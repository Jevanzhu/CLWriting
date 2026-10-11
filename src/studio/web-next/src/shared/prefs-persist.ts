import { getGlobalPrefs, putGlobalPrefs, type GlobalPrefs } from '../api/prefs'
import { ApiError } from '../api/client'
import { notifyCrossWindow } from './cross-window'

/**
 * prefs 持久化引擎（自 stores/prefs.ts 拆出，纯移动/行为零变化）。
 *
 * 本件收 store 的写路径四件：①init 的读链与首次 localStorage 迁移写；②debounce 写回
 * 单飞链（schedulePersist / runPutChain / flushPendingPersist）；③乐观并发（revision
 * 维护 + 409 恢复 recoverFromConflict + dirtyKeysOf 脏键判定）；④跨窗失效重取
 * （refreshOnRemoteChange，只读不写）。
 *
 * 依赖以注入面收口（本件不 import stores/*——保持 shared 层单向：store → shared）：
 * snapshot/applyPrefs 来自 shared/prefs-rows 的行表，副作用三连与 toast 由 store 接线
 * （useUiStore）、迁移读写由 store 注入（refs 归 store 所有，迁移是「旧 localStorage →
 * refs」的搬运用例，不属线上协议）。
 *
 * 不变量（逐条对齐拆分前实现，测试群 prefs-409-recovery / prefs-close-flush-inflight /
 * prefs-debounce-fire-clears-handle / prefs-persist-fail-warn 等逐条锚定）：
 * - putInFlight 单飞：body 起跑即同步占位（赋值先于任何宏任务可观察点），链尾守卫只清
 *   自己占据的占位；保存的 Promise 是真链（非已 resolve 占位符），flushPendingPersist
 *   才能等它落定。
 * - debounce fire 分支起始置空 persistTimer：「定时器已 fire = 无待写」，否则保存过
 *   一次的窗每次关窗空写 PUT → 服务端空 bump revision → 他窗伪 409。
 * - 409 恢复 = 远端垫底 + 本窗未落盘修改重放（dirtyKeysOf 对比 lastPersisted 基线），
 *   重试 PUT 纳入单飞；无基线（lastPersisted=null）时零脏字段、整体采纳远端。
 * - 非 409 失败一次性 warning（persistFailNotified 去重，成功落盘复位）；恢复链三态
 *   告知（成功 warning / 重试失败 error / GET 失败静默）。
 * - revision 未知态（init 失败离线）写前重 GET 对齐（ensureRevisionKnown 单源）。
 */
export interface PrefsPersistDeps {
  /** 当前全局 refs 全量快照（shared/prefs-rows 的 snapshotRows 接线） */
  snapshot: () => GlobalPrefs
  /** 逐键守卫应用（shared/prefs-rows 的 applyPrefsTo 接线） */
  applyPrefs: (p: GlobalPrefs) => void
  /** 排版 CSS 变量副作用 */
  apply: () => void
  /** 主题 dataset + win 窗控副作用 */
  applyTheme: () => void
  /** 紧凑 class 副作用 */
  applyCompact: () => void
  /** 失败提示出口（store 侧接线 useUiStore().toast） */
  toast: (msg: string, kind: 'warning' | 'error') => void
  /** 旧 localStorage → refs 迁移（返回是否有迁移数据） */
  migrateLegacy: () => boolean
  /** 迁移完成后清理旧键 */
  clearLegacy: () => void
}

/** store 出口面（init / 关窗冲刷 / 跨窗失效刷新）。 */
export interface PrefsPersist {
  init: () => Promise<void>
  schedulePersist: () => void
  flushPendingPersist: () => Promise<void>
  refreshOnRemoteChange: () => Promise<void>
}

/** 持久化实例态（非响应式——仅供写路径用，随 store 实例一份）。 */
interface PersistState {
  persistTimer: ReturnType<typeof setTimeout> | null
  /** 在途写回句柄（单飞排队判据；finally 复位） */
  putInFlight: Promise<void> | null
  /** 最近一次成功落盘的服务端快照（PUT 的入参快照）——409 恢复时判定
   *  「本窗已改未落盘字段」的基线（当前 refs ≠ 此快照的字段即本窗脏字段）。 */
  lastPersisted: GlobalPrefs | null
  /** 并发修订号：PUT /api/library/prefs 的 expectedRevision 依据。
   *  GET/写成功响应回传时同步（照 provider store 的维护方式），非响应式——仅供写路径用。
   * 配对未知态标记——init 失败（API 不可达）时 revision=0 是「未知」
   *  而非「服务端确为 0」，原样参与 PUT 会让首保存必 409（误报「已在其他窗口被修改」）。 */
  revision: number
  revisionKnown: boolean
  /** 非 409 持久化失败的一次性提示去重标记——对齐 useSse 的
   *  busy429Notified 惯例：同一失败窗只 warning 一次（离线改主题/排版此前全静默，
   *  重启回退无提示），成功落盘后复位，恢复后再败可再提示。 */
  failNotified: boolean
}

interface PersistCtx {
  st: PersistState
  deps: PrefsPersistDeps
}

/** PUT 链占位单源——body 起跑即同步占位（单飞不变式：
 *  赋值先于任何宏任务可观察点，后续防抖回落只见非空重排队），链尾守卫清位（只清
 *  自己占据的占位——多路关窗冲刷/在途交叠时防误清对方的占位）。返回真链 Promise
 *  （在途/冲刷两链的 finally 不再用已 resolve 的占位符——原占位 await 即穿透，
 *  等不到 PUT 落定，flushPendingPersist 无从续链）。 */
function runPutChain(ctx: PersistCtx, body: () => Promise<void>): Promise<void> {
  const { st } = ctx
  const p = body().finally(() => {
    if (st.putInFlight === p) st.putInFlight = null
  })
  st.putInFlight = p
  return p
}

/** revision 未知态写前对齐单源——的重 GET 块原在
 *  schedulePersist / flushPendingPersist 两处逐行双写，收敛本函数防漂移（语义零变化：
 *  已知即跳过；GET 失败照旧发 PUT，走既有 409/静默口径自愈）。 */
async function ensureRevisionKnown(ctx: PersistCtx): Promise<void> {
  const { st } = ctx
  if (st.revisionKnown) return
  try {
    st.revision = (await getGlobalPrefs()).revision
    st.revisionKnown = true
  } catch {
    /* 网络不可达：照旧 PUT */
  }
}

/** debounce 写回 global.json（500ms）。
 * 快照移入定时器回调（此前防抖注册即捕快照，PUT 晚 500ms 发出，
 *  与在途 PUT 交叠时旧快照后到可丢改动）+ 在途单飞（在途时重走防抖排队，完成后以
 *  届时最新快照发出）。
 * fire 分支起始置空 persistTimer——
 *  此前回调执行完不置空，句柄停在「已 fire 的旧定时器」上恒非 null，而
 *  flushPendingPersist 以 `!persistTimer` 作「无待写」判据，
 *  于是**保存过一次**的窗每次关窗都同值空写 PUT → 服务端无条件 bump revision → 其他
 *  存活窗下次保存伪 409 +「已在其他窗口被修改」误导 toast。定时器已 fire 即无待写，
 *  置空后守卫恢复原意（原注释「定时器只在冲刷内清空」正是缺口自述）。的返回
 *  真链 Promise 不变式不受影响（在途分支重排 schedulePersist 会重新武装句柄）。 */
function schedulePersist(ctx: PersistCtx): void {
  const { st } = ctx
  if (st.persistTimer) clearTimeout(st.persistTimer)
  st.persistTimer = setTimeout(() => {
    st.persistTimer = null // 本定时器已 fire，无待写（在途分支下方重排会重新武装）
    if (st.putInFlight) {
      schedulePersist(ctx) // 在途挂起排队：完成后重拍 500ms，快照届时重取
      return
    }
    void runPutChain(ctx, async () => {
      // revision 未知态（init 失败离线）首次 PUT 前重 GET 对齐——不再以 0
      // 自伤 409（ensureRevisionKnown 单源收敛）
      await ensureRevisionKnown(ctx)
      await doPersistPut(ctx)
    })
  }, 500)
}

/** 实际 PUT 段抽直（占位逻辑外提）；409 恢复见 recoverFromConflict（改写
 * 的「整体采纳远端」口径）。 */
async function doPersistPut(ctx: PersistCtx): Promise<void> {
  const { st, deps } = ctx
  // 快照先于 PUT：await 窗口内的新 setter 不属于本次落盘内容，成功后按快照记基线
  const cache = deps.snapshot()
  try {
    // 带 expectedRevision 乐观并发——两面板同时保存时后写收 409 而非静默覆盖先写
    const r = await putGlobalPrefs(cache, st.revision)
    st.revision = r.revision
    st.revisionKnown = true
    st.lastPersisted = cache
    st.failNotified = false // 成功落盘复位——恢复后再失败可再提示
    // 跨窗失效广播：本窗偏好已落盘 → 他窗走各自既有 GET 合并链重取（不回传值）。
    // 只在落盘成功后发——落盘前广播会让他窗 GET 到旧值且不会重试（本通道是提示，不是队列）。
    notifyCrossWindow(['prefs'])
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) {
      // 非 409 失败（离线/网络/5xx）不再全静默——原口径直接
      // return，离线改主题/排版不落盘、重启回退且无提示。补一次性 warning（去重
      // 见 failNotified 注）；refs 已生效（展示不受影响），仅落盘滞后。
      if (!st.failNotified) {
        st.failNotified = true
        deps.toast('全局偏好暂时未能保存（网络/服务异常），恢复后将随下次改动自动重试', 'warning')
      }
      return /* 其他错误维持既有静默口径（提示去重后不打断） */
    }
    await recoverFromConflict(ctx, cache)
  }
}

/** 关窗/退出前的立即冲刷——清 500ms 防抖窗直发一次 PUT
 *  （主进程 flushRendererBeforeClose 经 window.__clwFlushPrefs 调用；revision 对齐与
 *  409 自愈口径与 schedulePersist 相同）。
 * 在途 PUT 时原实现 `if (putInFlight) return` 空返回——关窗钩子
 *  的返回值被主进程 executeJavaScript await，视为冲刷完成即放行销毁窗口，在途 PUT
 *  快照之后的偏好改动（<500ms 防抖窗内）随定时器与窗口一同死亡。改为：等在途真链
 *  落定（其失败已由 doPersistPut/恢复链内部消化，catch 兜底防御）后清防抖定时器、
 *  按届时最新快照补一笔直发；整链作为返回 Promise 交主进程预算内等待
 *  （flushRendererWithBudget 的 FLUSH_BUDGET_TIMEOUT 兜底，超时同权放行关窗）。 */
async function flushPendingPersist(ctx: PersistCtx): Promise<void> {
  const { st } = ctx
  // 无待写不空写守卫（对齐 workspace.flushPendingBookPrefs 的
  // `if (!debounceTimer) return` 口径，待写标志即本引擎的 persistTimer）——书架/
  // 书库等独立窗关窗此前也无条件同值 PUT，服务端 revision 空 bump → 存活窗陈旧
  // revision 伪 409 +「已在其他窗口被修改」误导 toast。
  // 本守卫在原 schedulePersist
  // 下只兑现了一半——fire 后句柄不清空，「保存过一次」的窗恒判为有待写，仍每次关窗
  // 空写（原注释「定时器只在冲刷内清空，清后复改会重排」正是缺口自述；现已由 fire
  // 分支置空收口）。persistTimer 为空 = 确认无待写：本窗从未排过防抖写，或排过的
  // 定时器已 fire / 已被先前冲刷消费。此时不补发 PUT，但**仍等在途链落定**——刚
  // fire 出去的那笔 PUT 可能仍在途，主进程 await 本函数的语义是「冲刷完成才销毁
  // 窗口」，跳过等待会让已发出的写随窗口销毁而夭折（同源风险面）。
  if (!st.persistTimer) {
    if (st.putInFlight)
      await st.putInFlight.catch(() => {
        /* 在途失败已消化，此处不重试 */
      })
    return
  }
  if (st.putInFlight) {
    await st.putInFlight.catch(() => {
      /* 在途失败已消化，此处不重试 */
    })
  }
  if (st.persistTimer) {
    clearTimeout(st.persistTimer)
    st.persistTimer = null
  }
  return runPutChain(ctx, async () => {
    // 同 schedulePersist——写前重 GET 对齐未知 revision（ensureRevisionKnown 单源）
    await ensureRevisionKnown(ctx)
    await doPersistPut(ctx)
  })
}

/** 本窗脏字段键集：当前值与最近成功落盘快照不一致的键（脏字段判定源）。 */
function dirtyKeysOf(st: PersistState, local: GlobalPrefs): string[] {
  // 无已持久化基线（lastPersisted 尚为 null——init 未完成/未调用态；
  // 已核对 init 各完成路径——迁移分支/else 分支含 GET 失败降级——均置基线且此后
  // 不再回 null，正常态此处不可达）时无从判定「本窗脏」，视为零脏字段：409 恢复
  // 整体采纳远端。原 Object.keys(local) 会把全量本地值（含未改动的默认值）当本窗
  // 修改回放、覆盖他窗配置 + toast「已保留本窗修改」与事实不符。409 恢复其余分支
  // 语义不变。
  if (!st.lastPersisted) return []
  const out: string[] = []
  for (const k of Object.keys(local)) {
    if (local[k] !== st.lastPersisted[k]) out.push(k)
  }
  return out
}

/** 409 恢复——远端值垫底 + 本窗未落盘修改重放（原口径 applyPrefs 整体
 *  采纳远端，本窗未落盘的修改被静默丢弃）。重试 PUT 经 await 并入调用方的 putInFlight
 *  单飞：恢复窗口内的新保存排队到重试完成后发出，不再带陈旧 revision 再吃 409。
 *  本链自身还有 GET + 重试 PUT 两段 await 窗口，窗口内本窗新编辑只存在于 refs
 *  （localCache 是本笔 PUT 的快照，不含它们）：除按基线重放快照时的脏字段外，还须把
 *  「当前 refs ≠ 快照」的键以当前值覆盖进 merged，否则 applyPrefs 把它们回退成远端值，
 *  且回退态随即成为重试 PUT 的 body 与 lastPersisted 基线（编辑静默丢失 + 基线记错）。 */
async function recoverFromConflict(ctx: PersistCtx, localCache: GlobalPrefs): Promise<void> {
  const { st, deps } = ctx
  let remote: Awaited<ReturnType<typeof getGlobalPrefs>>
  try {
    remote = await getGlobalPrefs()
  } catch {
    return /* 网络不可达保持现值，等下次 schedulePersist */
  }
  st.revision = remote.revision
  st.revisionKnown = true
  // 当前 refs = 「本窗最后意图」（快照后可能又改过）；与 localCache 不等的键即快照
  // 之后（含本 GET 在途）新改的键，合并时以当前值覆盖远端值。
  const current = deps.snapshot()
  // 远端值垫底，本窗脏字段重放本地值（合并经 applyPrefs 的逐键类型/范围守卫落 refs）
  const merged: GlobalPrefs = { ...remote.prefs }
  for (const k of dirtyKeysOf(st, localCache)) merged[k] = localCache[k]
  for (const k of Object.keys(current)) {
    if (current[k] !== localCache[k]) merged[k] = current[k]
  }
  deps.applyPrefs(merged)
  // 合并结果只写 refs 不落样式——非本窗脏的字段采纳远端新值后，
  // 排版 CSS 变量/主题 dataset/紧凑 class 仍停留在冲突前旧值，「已保留本窗修改并合并
  // 最新值」的提示弹出但样式不生效。对齐 init 的恢复链：applyPrefs 后接三连 apply
  deps.applyTheme()
  deps.applyCompact()
  deps.apply()
  const retryCache = deps.snapshot()
  try {
    const r = await putGlobalPrefs(retryCache, st.revision)
    st.revision = r.revision
    st.revisionKnown = true
    st.lastPersisted = retryCache
    st.failNotified = false // 成功落盘复位（与 doPersistPut 成功分支同口径）
    notifyCrossWindow(['prefs']) // 合并重试已落盘：他窗按各自脏键合并链重取（同 doPersistPut）
    // 三态告知之「成功」——合并 + 重试落盘都成功才按现行口径提示
    deps.toast('全局偏好已在其他窗口被修改，已保留本窗修改并合并最新值', 'warning')
  } catch {
    /* 三态告知之「已刷新+重试失败」——refs 已合并保留（本窗脏修改仍在，
     * lastPersisted 未推进 → 下次 schedulePersist 自动重试），但不得再按成功口径
     * 提示「已合并」误导作者（原实现 catch 静默 + 无条件成功 toast）。第三态
     * （GET 失败）维持上方静默：本窗值未动、无成功假象，等下次保存自动再走恢复链。 */
    deps.toast(
      '全局偏好已在其他窗口被修改，已合并最新值，但重试保存失败——本窗修改已保留，将随下次改动自动重试',
      'error',
    )
  }
}

/** 跨窗失效通知的刷新入口（收到他窗 prefs 落盘广播时本窗重取）。
 *
 * 为什么是「失效通知」而不是「数据同步」：广播载荷不携带任何偏好值，本函数只把它当
 * 失效信号，重走既有 GET + applyPrefs 逐键守卫 + 脏键合并链——远端值垫底、本窗未落盘
 * 脏键重放覆盖。于是既不绕过 revision 乐观并发闸（不把别窗值直接写进 refs 造成
 * 「本窗未保存编辑被静默覆盖」），也不吃本窗脏键（红线）。
 *
 * 为什么不复用 recoverFromConflict：那条链尾接着重试 PUT + 「已在其他窗口被修改」toast。
 * 本链不是冲突（没有任何本窗写失败），PUT 会把刚采纳的远端值原样写回并 bump 服务端
 * revision → 他窗再收广播 → 写回环 + 误导提示。故只读不写。
 *
 * 基线推进只对非脏键（值确实随远端改了）：不推进则下次 409 恢复会把「已被采纳的远端
 * 旧值」误判成本窗脏字段重放，反过来盖掉他窗更新的值（跨窗反向覆盖）。脏键保持旧基线
 * → 仍判脏 → 下次保存链照旧重放/补写，本窗编辑不丢。 */
async function refreshOnRemoteChange(ctx: PersistCtx): Promise<void> {
  const { st, deps } = ctx
  let remote: Awaited<ReturnType<typeof getGlobalPrefs>>
  try {
    remote = await getGlobalPrefs()
  } catch {
    return /* 网络不可达：保持现值，等下次通知/保存链自愈（与 recoverFromConflict 同口径） */
  }
  st.revision = remote.revision
  st.revisionKnown = true
  // current 取在 await 之后：GET 在途期间的本窗新编辑（≠ 基线）同样判脏而被保留
  const current = deps.snapshot()
  const dirty = new Set(dirtyKeysOf(st, current))
  // 远端值垫底，本窗脏键重放（合并经 applyPrefs 的逐键类型/范围守卫落 refs）
  const merged: GlobalPrefs = { ...remote.prefs }
  for (const k of Object.keys(current)) {
    if (dirty.has(k)) merged[k] = current[k]
  }
  deps.applyPrefs(merged)
  // 采纳远端值后样式必须随落——排版 CSS 变量/主题 dataset/紧凑 class 不得停在旧值
  // （对齐 init 与 recoverFromConflict 的 applyPrefs 后三连）
  deps.applyTheme()
  deps.applyCompact()
  deps.apply()
  if (st.lastPersisted) {
    // 采纳后的实际值（applyPrefs 守卫可能回落到本窗现值）= 服务端已知态，作非脏键新基线
    const after = deps.snapshot()
    const next: GlobalPrefs = { ...st.lastPersisted }
    for (const k of Object.keys(after)) {
      if (!dirty.has(k)) next[k] = after[k]
    }
    st.lastPersisted = next
  }
}

/** 异步初始化：从 global.json 加载（替代 localStorage）。
 *  首次为空时从旧 localStorage 自动迁移。main.ts 在 mount 前调一次。 */
async function init(ctx: PersistCtx): Promise<void> {
  const { st, deps } = ctx
  let prefs: GlobalPrefs = {}
  let apiOk = false
  try {
    const r = await getGlobalPrefs()
    // 200 但缺 prefs 字段（信封异常/旧网关代理截断）时 r.prefs 为
    // undefined——赋值后 Object.keys(undefined) 抛 TypeError，沿 main.ts mount 前的
    // top-level await 冒出，应用整体不挂载（白屏死）。`?? {}` 兜底为「空偏好」：走
    // applyPrefs 逐键守卫全跳过 = 全默认值，与 catch 的「API 不可达用默认」同口径降级。
    prefs = r.prefs ?? {}
    st.revision = r.revision
    st.revisionKnown = true
    apiOk = true
  } catch {
    /* API 不可达用默认——revision 维持未知态（写回前重 GET 对齐） */
  }

  // 迁移：API 可达且 prefs 为空（真·首次）时才从旧 localStorage 读取。
  // API 不可达不再误判「首次」——旧 localStorage 残值会覆盖
  // 展示态（服务端配置实际存在，重连后展示跳变）。迁移成功后清理旧键（对齐
  // workspace 侧已修口径），防旧残值在后续 API 不可达时再度触发伪迁移。
  if (apiOk && Object.keys(prefs).length === 0 && deps.migrateLegacy()) {
    prefs = deps.snapshot()
    // 迁移写内容即基线（迁移 PUT 失败时脏字段判定仍成立）。
    // 注记：评审曾建议「移到 PUT 落定
    // 后置位」，二阶分析后维持先行——①迁移 PUT 是裸调用不占 putInFlight 单飞槽，
    // 在途窗口内用户编辑可并发 schedulePersist → 撞 409 → recoverFromConflict 的
    // 本窗重放依赖 dirtyKeysOf 对比基线；移后 lastPersisted=null 走零脏口径
    // 会静默丢该次编辑（现行为可重放）。②先行置位保住头注「init 各完成
    // 路径均置基线」不变量。③迁移 PUT 失败的服务端缺口由 revisionKnown=false 的
    // 写前重 GET 链在下一次保存时对齐补写，无需基线参与。
    st.lastPersisted = prefs
    deps.clearLegacy()
    // 迁移写带 expectedRevision = 上面那次 GET 的号（apiOk 即 revisionKnown）——
    // 服务端契约 PUT /api/library/prefs body {prefs, expectedRevision?}：
    // 缺失放行、不等回 409（server/api/prefs.ts revisionError 闸）。不带即全库唯一
    // 可无条件覆盖他窗同键的写：GET 与本次 PUT 之间他窗落盘的新值会被本次迁移的
    // 全量快照盖掉。带号后该情形收 409（不覆盖他窗），本地号随之陈旧 → 下一次用户保存
    // 经 recoverFromConflict 合并重试自愈。
    // 迁移写会 bump 服务端 revision——同步回存，否则首个用户保存带陈旧号 409
    void putGlobalPrefs(prefs, st.revision)
      .then((r) => {
        st.revision = r.revision
        st.revisionKnown = true
        notifyCrossWindow(['prefs']) // 落盘成功才广播：他窗重取时读到的是本窗已写入的值
      })
      .catch(() => {
        /* 409/网络失败：迁移值仍在 refs（展示不回退），服务端由后续保存链合并补写 */
      })
  } else {
    deps.applyPrefs(prefs)
    st.lastPersisted = deps.snapshot() // 初始服务端态即基线
  }

  deps.applyTheme()
  deps.applyCompact()
  deps.apply()
}

/** 装配面：一份实例态 + 注入面 → store 出口四件（init / 防抖落盘 / 关窗冲刷 / 跨窗刷新）。 */
export function createPrefsPersist(deps: PrefsPersistDeps): PrefsPersist {
  const ctx: PersistCtx = {
    st: {
      persistTimer: null,
      putInFlight: null,
      lastPersisted: null,
      revision: 0,
      revisionKnown: false,
      failNotified: false,
    },
    deps,
  }
  return {
    init: () => init(ctx),
    schedulePersist: () => schedulePersist(ctx),
    flushPendingPersist: () => flushPendingPersist(ctx),
    refreshOnRemoteChange: () => refreshOnRemoteChange(ctx),
  }
}
