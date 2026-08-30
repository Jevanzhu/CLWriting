/**
 * providers.json 读写——应用级（userDataPath），跨书共享（方案 §四①）。
 *
 * 不进书库目录：供应商是「这台机器的作者用什么服务」，不是「这本书的属性」。
 * 书库可能进 git，凭据不能跟着走。
 *
 * S4 加密落地（凭据存储设计 §四–七）：
 * - API Key 经 vault 信封加密（HKDF→KEK→DEK→AES-GCM），不明文落盘
 * - 加解密只发生在 load/save 边界，内存中 ProviderConf 仍含明文 apiKey
 * - 上层 API（providers.ts）零改动
 * - load 时自动迁移明文→密文 + 半迁移状态收敛（§五）
 *
 * 写入健壮性（原子写/备份/损坏不静默）属于 S5；凭据文件权限统一 0600 且随创建即生效（ee-P2-1）。
 */
import { readFileSync, mkdirSync, existsSync, chmodSync, copyFileSync, statSync } from 'node:fs'
import { atomicWriteFile } from '../../fs/atomic.js'
// R30-3（三十轮）：锁等待改异步孪生 + 快路同步尝试——生成收尾路径（降级持久化等）与
// 设置页保存在 CLI+桌面双进程争用窗口不再被 Atomics.wait 同步微睡冻结事件循环
import { acquireCrossProcessLockAsync, tryAcquireCrossProcessLock } from '../../fs/cross-process-lock.js'
import { dirname, join } from 'node:path'
import type { ProviderConf, ModelConf, TierSlot, TierConfig, RagProviderConf } from './types.js'
import { builtinKeyMaterial } from './vault-key.js'
import { log } from '../../log/index.js'
import {
  createVault,
  openVault,
  sealKey,
  openKey,
  type Vault,
} from './vault.js'

const FILE = 'providers.json'

/**
 * mtime 缓存——避免每次 AI 生成重复 readFileSync + AES-256-GCM 解密。
 * saveProviders 写后失效；外部改动经 mtime 检测自动失效。
 */
let _cache: { path: string; store: ProviderStore; mtime: number } | null = null

/** 深拷贝 store——structuredClone 将 Buffer 降级为 Uint8Array，dek 须恢复（P2-AI-1） */
function cloneStore(store: ProviderStore): ProviderStore {
  const cloned = structuredClone(store)
  if (cloned.dek) cloned.dek = Buffer.from(cloned.dek)
  return cloned
}

/**
 * 内存中的供应商存储——ProviderSettings 超集。
 *
 * load 时解密得到明文 apiKey + vault/dek（复用避免重解）；
 * save 时用 dek 加密、剥离明文、写回 vault。
 * vault/dek 为 null 表示无存量 vault（首次启动 / 全新配置）。
 */
export interface ProviderStore {
  providers: ProviderConf[] // 含明文 apiKey（仅内存）
  currentId: string | null
  currentModel: string | null // 全局模型选择（方案 A：model 独立于供应商）
  /**
   * 表驱动重构（§6.5）：modelCaps 探测退役后，此槽复用为「400 降级记忆」——
   * 记录该 provider+model 已确认不支持 structured 输出，下次直接跳过（避免重复 400）。
   * key = `${providerId}/${model}`，值只用 structured:false 布尔。
   */
  modelCaps: Record<string, { structured: false }>
  /** 任务档位（D 档：创作档/助手档；端点按任务类型取档） */
  tiers: TierConfig
  /** RAG（嵌入）服务商——应用级多服务商，书按 rag.provider 引用（key 同走 vault） */
  ragProviders: RagProviderConf[]
  /** 并发修订号（P4）：save 写前 +1，读侧无该键视为 0；写端点带 expectedRevision 校验 */
  revision: number
  vault: Vault | null
  dek: Buffer | null
}

/** 默认档位配置（首次启动 / 文件无 tiers 字段时） */
function defaultTiers(model: string | null): TierConfig {
  return {
    creative: { model: model ?? '', effort: 'xhigh' },
    assistant: null,
    chat: null,
  }
}

/** 空 store（首次启动 / 文件缺失时） */
export function emptySettings(): ProviderStore {
  return { providers: [], currentId: null, currentModel: null, modelCaps: {}, tiers: defaultTiers(null), ragProviders: [], revision: 0, vault: null, dek: null }
}


/** 磁盘文件结构——providers 不含 apiKey，密文统一在 vault.keys */
interface DiskFormat {
  providers: Array<Omit<ProviderConf, 'apiKey'> & { apiKey?: string }>
  currentId: string | null
  currentModel?: string | null
  /** 400 降级记忆槽（表驱动重构后复用原 modelCaps 槽，见 ProviderStore.modelCaps） */
  modelCaps?: Record<string, { structured: false }>
  tiers?: TierConfig
  /** RAG（嵌入）服务商（同 vault 加密；形状坏容错为 []，不触发整文件 bak 恢复） */
  ragProviders?: Array<Omit<RagProviderConf, 'apiKey'> & { apiKey?: string }>
  /** 并发修订号（P4）；存量文件无该键 → 0 */
  revision?: number
  vault?: Vault
}

/**
 * W-P2-9：主文件损坏时的备份恢复引导。
 * 从 providers.bak.json 复制回主文件（并尝试保持 0600 权限）。
 * @returns null=恢复成功；string=恢复失败原因（bak 缺失/读失败/复制失败）。
 */
function tryRestoreFromBak(fp: string, bakFp: string): string | null {
  if (!existsSync(bakFp)) return '备份文件不存在'
  try {
    copyFileSync(bakFp, fp)
    try {
      chmodSync(fp, 0o600)
    } catch {
      /* 平台不支持 chmod 则忽略 */
    }
    _cache = null // 恢复后强制重读
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/**
 * 读 providers.json → 解密 → ProviderStore（含明文 apiKey）。
 *
 * 解密失败（版本过高 / 认证失败）抛错——S5 会兜住"损坏不静默"，
 * 当前版本向上传播，由调用方（server API）转成错误响应。
 */
export function loadProviders(userDataPath: string): ProviderStore {
  const fp = `${userDataPath}/${FILE}`
  if (!existsSync(fp)) {
    _cache = null
    return emptySettings()
  }

  // mtime 缓存命中——跳过 readFileSync + vault 解密（高频 AI 生成场景核心优化）
  // P2-SEC-4：返回副本而非同一引用——调用方（API 端点）会直接 mutate store 后 saveProviders，
  // 若缓存返回原引用，未 save 的中间态会泄漏给后续 loadProviders 调用方
  try {
    const mtime = statSync(fp).mtimeMs
    if (_cache && _cache.path === fp && _cache.mtime === mtime) return cloneStore(_cache.store)
  } catch {
    _cache = null
  }

  let raw: DiskFormat
  const bakFp = `${dirname(fp)}/providers.bak.json`
  try {
    raw = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
  } catch (e) {
    // W-P2-9：损坏不静默，且不再直接放弃——主文件解析失败时尝试从 bak 恢复
    // （save 每次写前都会生成 providers.bak.json，理论上是最新一份完整配置）。
    // 恢复成功 → 用备份内容继续（并在下方用恢复后的内容重写主文件，重建一致状态）。
    const bakErr = tryRestoreFromBak(fp, bakFp)
    if (bakErr) {
      // D6：备份也不可用 → 保留原文件、向上报错（router 全局 catch 转 500 响应）
      throw new Error(`providers.json 解析失败，文件可能损坏（备份恢复亦失败）：${e instanceof Error ? e.message : ''}${bakErr ? '；bak: ' + bakErr : ''}`)
    }
    try {
      raw = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
    } catch (e2) {
      throw new Error(`providers.json 备份恢复后仍无法解析：${e2 instanceof Error ? e2.message : ''}`)
    }
  }
  // RB-AI-P2-6：JSON 合法但形状坏（providers 非数组）——不再静默 emptySettings
  //（用户视角 = Key 无故消失、无任何损坏提示），走与解析失败相同的 bak 恢复链；
  // bak 也不可用才重置为空，且 log.warn 显式告警（不静默）
  if (!Array.isArray(raw.providers)) {
    const bakErr = tryRestoreFromBak(fp, bakFp)
    let restored: DiskFormat | null = null
    if (!bakErr) {
      try {
        const reread = JSON.parse(readFileSync(fp, 'utf8')) as DiskFormat
        if (Array.isArray(reread.providers)) restored = reread
      } catch {
        /* bak 内容亦不可解析 */
      }
    }
    if (restored) {
      raw = restored
    } else {
      log.warn(
        'providers',
        `providers.json 形状损坏（providers 非数组）${bakErr ? `，备份恢复失败：${bakErr}` : '，备份内容亦不可用'}——已重置为空配置（损坏文件保留，可从 providers.bak.json 手动恢复）`,
      )
      return emptySettings()
    }
  }

  const vault: Vault | null = raw.vault ?? null
  let dek: Buffer | null = null

  if (vault) {
    // 版本守卫 + HKDF 派生 KEK + 解封 DEK（可能抛 VaultVersionError / VaultDecryptError）
    dek = openVault(vault, builtinKeyMaterial())
  }

  // 逐条提取明文 apiKey，按 §五半迁移规则收敛
  let needsRewrite = false
  const providers: ProviderConf[] = raw.providers.map((p) => {
    const conf = { ...p, apiKey: '' } as ProviderConf
    if (vault && dek && vault.keys[conf.id]) {
      // vault 有 → 解密（vault 永远优先）
      // R31-28（三十一轮）：providerId 绑 AAD；存量未绑密文经 legacy 通道打开并标记重封
      const opened = openKey(dek, vault.keys[conf.id]!, conf.id)
      conf.apiKey = opened.apiKey
      if (opened.legacy) needsRewrite = true
      // 残留明文 apiKey 字段 → 标记清理
      if (p.apiKey) needsRewrite = true
    } else if (p.apiKey) {
      // vault 缺该条目但明文有 → 补迁移
      conf.apiKey = p.apiKey
      needsRewrite = true
    }
    return conf
  })

  // 无 vault 但有明文 apiKey → 全量首次迁移
  if (!vault && providers.some((p) => p.apiKey)) {
    needsRewrite = true
  }

  // RAG（嵌入）服务商——同款解密/明文迁移规则。形状坏容错为 []：
  // ragProviders 是后加段，不能因它拖累 chat providers 走整文件 bak 恢复链。
  const ragRaw = Array.isArray(raw.ragProviders) ? raw.ragProviders : []
  const ragProviders: RagProviderConf[] = ragRaw.map((p) => {
    const conf = { ...p, apiKey: '' } as RagProviderConf
    if (vault && dek && vault.keys[conf.id]) {
      // R31-28（三十一轮）：同 chat 侧——providerId 绑 AAD + legacy 重封迁移
      const opened = openKey(dek, vault.keys[conf.id]!, conf.id)
      conf.apiKey = opened.apiKey
      if (opened.legacy) needsRewrite = true
      if (p.apiKey) needsRewrite = true
    } else if (p.apiKey) {
      conf.apiKey = p.apiKey
      needsRewrite = true
    }
    return conf
  })
  if (!vault && ragProviders.some((p) => p.apiKey)) {
    needsRewrite = true
  }

  const store: ProviderStore = { providers, currentId: raw.currentId ?? null, currentModel: raw.currentModel ?? null, modelCaps: raw.modelCaps ?? {}, tiers: raw.tiers ?? defaultTiers(raw.currentModel ?? null), ragProviders, revision: raw.revision ?? 0, vault, dek }

  // 迁移写回——剥离明文、加密进 vault（§五）
  if (needsRewrite) {
    // R29-2（二十九轮）：saveProviders 现返回 promise——迁移写是 load 的内联副作用：
    // 快路同步异常照旧向上抛（本行表达式同步求值，语义不变）；排队段（存在在途写时）
    // 的拒绝在此收口（saveProviders 内部已 log.warn 留痕），不再成为未处理 rejection
    saveProviders(userDataPath, store).catch(() => { /* 排队段失败已留痕，迁移写不向 load 异步上抛 */ })
    // R71-18：迁移后收敛 bak 明文残留——saveProviders 的 D7 写前备份会把迁移前的明文
    // 主文件原样拷进 providers.bak.json，用户此后不改配置则明文 Key 在 bak 永久残留
    // （直到下次 save 才被密文覆盖）。此处迁移写入后重新读回校验（openVault 重开 +
    // openKey 逐条解密比对明文），通过才用刚落盘的密文内容覆写一次 bak
    // （atomicWriteFile 与 D7/ee-P2-1 同款 0600+fsync）；校验失败保持 bak 现状
    // （明文 bak 是恢复通道，下次 saveProviders 自然覆盖）。
    try {
      const savedRaw = readFileSync(fp, 'utf8')
      const saved = JSON.parse(savedRaw) as DiskFormat
      const savedVault = saved.vault
      if (savedVault) {
        const savedDek = openVault(savedVault, builtinKeyMaterial())
        const roundtripOk = [...providers, ...ragProviders].every((p) => {
          if (!p.apiKey) return true // 空 key 无密文可校
          const sealed = savedVault.keys[p.id]
          return !!sealed && openKey(savedDek, sealed, p.id).apiKey === p.apiKey
        })
        if (roundtripOk) {
          atomicWriteFile(bakFp, savedRaw, { fsync: true, mode: 0o600 })
        }
      }
    } catch {
      /* 读回/解密校验失败：bak 保持现状（恢复通道），不向调用方传播 */
    }
  }

  // 更新 mtime 缓存
  try {
    _cache = { path: fp, store, mtime: statSync(fp).mtimeMs }
  } catch { /* 迁移写后 stat 失败忽略，下次 loadProviders 自然 miss */ }

  // P2-AI-3：缓存未命中也返回 clone（与缓存命中路径 structuredClone 一致）——
  // 否则调用方（API 端点）直接 mutate store 后 saveProviders 前，未保存的中间态会泄漏给后续 loadProviders
  return cloneStore(store)
}

/**
 * 写 providers.json——加密 apiKey 进 vault + 剥离明文 + mode 0600 创建即生效（ee-P2-1）。
 *
 * 每次 save 以 providers 列表为准重建 vault.keys（D4：删除的 provider 自动清除密文）。
 * 若 store 无 vault（首次 / 迁移），创建新 vault + 随机 DEK。
 *
 * R73-2（二十一轮 A-2）：全部写路径（loadProviders 迁移回写 / runner 降级持久化 /
 * 设置页保存）统一收口到本函数 → 按 userDataPath 的串行写队列 + 跨进程文件锁
 * （范式同 ai/calls.ts serializedWrite + J7 跨进程锁）。修复前读-改-写三段无串行化，
 * 与设置页保存并发时旧快照整态覆盖新写，用户配置丢失。
 *
 * 语义变化（R73-2 原口径，R29-2 二十九轮修订）：队列空闲时同步直行（同步调用方
 * 「存完即读」与「revision 写后 +1 立即可读」语义不变、IO 异常照旧同步上抛）；存在
 * 在途段时排队为微任务执行。R29-2：签名 void → Promise<void>——快路同步写完后
 * resolve（IO 异常仍同步抛，对 `try { await saveProviders(...) } catch` 两侧等价捕获）；
 * 排队段返回链式 promise，失败 log.warn 留痕后随 promise 上抛（修复前仅 warn 吞掉：
 * 设置页保存 API 已按成功返回而配置未落盘）。端点侧（批 D）约定按
 * `try { await saveProviders(...) } catch → 500` 消费。
 *
 * 残余窗口（登记）：读路径 loadProviders 不参与互斥——排队写未落地的微任务窗口内
 * 并发 load 读到旧快照、改动后再 save 会按调用序排在后面（后写覆盖前写）。
 * 设置页写端点已有 P4 expectedRevision 校验（陈旧快照 409 重读）兜住主路径；
 * 降级持久化等无 revision 校验的路径残余窗口 = 该微任务窗，写频每 key 一次
 * （AA-P3-5 去重），风险可接受。跨进程窗口由文件锁互斥（写段不交错），锁内
 * 不重读合并（与 calls.ts 同口径，读合并在锁外做收益为零）。
 */
const writeChains = new Map<string, Promise<unknown>>()

/** R73-2 跨进程锁等待超时（毫秒）——写段为本地文件 IO 级毫秒，5s 已极保守（同 calls.ts） */
const PROVIDERS_WRITE_LOCK_TIMEOUT_MS = 5_000

/** 测试辅助：向写链注入一段在途 promise（R29-2 排队路径回归用——空闲快路永不入链，
 *  生产代码无从触达排队段；生产零调用）。 */
export function __seedProvidersWriteChainForTest(userDataPath: string, pending: Promise<unknown>): void {
  writeChains.set(userDataPath, pending)
}

export function saveProviders(userDataPath: string, store: ProviderStore): Promise<void> {
  const prev = writeChains.get(userDataPath)
  if (prev === undefined) {
    // 空闲快路：无争用时同步原子完成（跨进程锁内——多进程同写 providers.json 不再交错
    // 覆盖）；IO 异常照旧同步上抛（R29-2：throw 路径保持 throw，await 侧 try/catch 同样
    // 接得住）。R30-3（三十轮）：锁被占时 saveWithCrossProcessLock 返回在途 promise
    //（异步轮询等待）——此处临时入链让后续写排队其后（保调用序 = 落盘序），并原样
    // 返回给 await 方（失败随 promise 上抛）；旁挂分支防在途 rejection 无人接时变
    // unhandled rejection + warn 留痕（R29-2 口径）。
    const inflight = saveWithCrossProcessLock(userDataPath, store)
    if (inflight === undefined) return Promise.resolve()
    writeChains.set(userDataPath, inflight)
    const cleanupInflight = (): void => {
      if (writeChains.get(userDataPath) === inflight) writeChains.delete(userDataPath)
    }
    void inflight.then(cleanupInflight, (e: unknown) => {
      log.warn('providers', `providers.json 写入失败（本次写未落盘）：${e instanceof Error ? e.message : String(e)}`)
      cleanupInflight()
    })
    return inflight
  }
  const next = prev.catch(() => {}).then(() => saveWithCrossProcessLock(userDataPath, store))
  writeChains.set(userDataPath, next)
  const cleanup = (): void => {
    if (writeChains.get(userDataPath) === next) writeChains.delete(userDataPath)
  }
  // 旁挂分支只负责留痕 + 清链——不吞返回 promise 的拒绝（R29-2 前这里是唯一出口，
  // 排队段失败对外表现为「成功」）
  void next.then(cleanup, (e: unknown) => {
    log.warn('providers', `排队 providers.json 写入失败（本轮写未落盘）：${e instanceof Error ? e.message : String(e)}`)
    cleanup()
  })
  // R29-2（二十九轮）：排队段失败随返回的链式 promise 向上传播（await 方 catch → 500），
  // 不再「log.warn 后吞」——写未落盘不得伪装成保存成功
  return next
}

/** R30-3（三十轮）：跨进程锁获取——无争用快路同步持锁直行（tryAcquire 即得，写段为
 *  文件 IO 级毫秒，同步原子完成后返回 undefined；R29-2「快路 IO 异常同步上抛」与
 *  loadProviders 迁移写回的 R71-18 紧邻读回校验所依赖的「存完即读」逐位不变）；
 *  锁被占时改用 acquireCrossProcessLockAsync 异步轮询等待（setTimeout 微睡、事件循环
 *  不阻塞）——生成收尾路径与设置页保存在 CLI+桌面双进程争用时不再冻结承载 SSE/全部
 *  接口的服务进程至超时。超时语义不变：5s 封顶、超时上抛（rejection 随 saveProviders
 *  返回的 promise 上抛 / 排队段旁挂 warn 留痕）。 */
function saveWithCrossProcessLock(userDataPath: string, store: ProviderStore): void | Promise<void> {
  const lockPath = `${userDataPath}/${FILE}.lock`
  const fast = tryAcquireCrossProcessLock(lockPath)
  if (fast) {
    try {
      saveProvidersLocked(userDataPath, store)
      return
    } finally {
      fast()
    }
  }
  return acquireCrossProcessLockAsync(lockPath, PROVIDERS_WRITE_LOCK_TIMEOUT_MS).then((release) => {
    if (!release) {
      throw new Error(`providers.json 跨进程锁获取超时（${lockPath}）——本次写入未落盘，避免与其他进程交错覆盖`)
    }
    try {
      saveProvidersLocked(userDataPath, store)
    } finally {
      release()
    }
  })
}

/** 原 saveProviders 主体（R73-2 改名入锁；逻辑逐行不变） */
function saveProvidersLocked(userDataPath: string, store: ProviderStore): void {
  const fp = `${userDataPath}/${FILE}`
  mkdirSync(dirname(fp), { recursive: true })

  // 确保 vault + DEK（首次创建或迁移时新建）
  let vault = store.vault
  let dek = store.dek
  if (!vault || !dek) {
    const created = createVault(builtinKeyMaterial())
    vault = created.vault
    dek = created.dek
    store.vault = vault
    store.dek = dek
  }

  // 以 providers + ragProviders 为准重建 vault.keys——加密每个 apiKey。
  // 两类 key 必须同批收齐：漏收任一类 = 存另一类时静默抹掉它的密文。
  vault.keys = {}
  const sealKeyOf = (id: string, apiKey: string): void => {
    // R31-28（三十一轮）：providerId 绑 AAD——密文换位到其他条目认证失败
    if (apiKey) vault!.keys[id] = sealKey(dek!, apiKey, id)
  }
  const diskProviders = store.providers.map((p) => {
    sealKeyOf(p.id, p.apiKey)
    // 剥离明文 apiKey（落盘不含）
    return { ...p, apiKey: undefined } as Omit<ProviderConf, 'apiKey'>
  })
  const ragProviders = store.ragProviders ?? []
  const diskRagProviders = ragProviders.map((p) => {
    sealKeyOf(p.id, p.apiKey)
    return { ...p, apiKey: undefined } as Omit<RagProviderConf, 'apiKey'>
  })

  const disk: DiskFormat = { providers: diskProviders, currentId: store.currentId, currentModel: store.currentModel, modelCaps: store.modelCaps, tiers: store.tiers, ragProviders: diskRagProviders, revision: (store.revision ?? 0) + 1, vault }
  // P4：写前 +1，内存 store 同步（调用方随后刷新时读到新号）
  store.revision = disk.revision!
  const json = JSON.stringify(disk, null, 2) + '\n'

  // D7：写前备份（文件已存在时）。ee-P2-1：bak 改走 atomicWriteFile + mode 0600 创建即生效——
  // 此前 copyFileSync 建文件后再补 chmodSync，chmod 前受 umask 影响（默认 0644 短暂全局可读，
  // 虽是密文仍是纪律缺口）；与主文件统一到「mode 随临时文件创建生效」纪律（CC-P2-3 / RB-IF-P2-6），
  // 且顺带获得原子性（不再可能留下半截 bak）。
  if (existsSync(fp)) {
    atomicWriteFile(join(dirname(fp), 'providers.bak.json'), readFileSync(fp, 'utf8'), { fsync: true, mode: 0o600 })
  }

  // D5+D8：原子写（atomicWriteFile: PID+UUID tmp 防冲突 + fsync 落盘）。
  // ee-P2-1：mode 0600 随临时文件创建即生效（rename 保留 mode），删除写后 chmodSync——
  // 后者存在 umask 窗口（默认 0644 短暂全局可读），与 CC-P2-3（src/ai/calls.ts 记账文件）同款修法。
  atomicWriteFile(fp, json, { fsync: true, mode: 0o600 })

  // 写后失效缓存（下次 loadProviders 自动重读 + 更新缓存）
  _cache = null
}

/**
 * 400 降级记忆落盘回调（U-P2-2）——适配器深处只持有 store 的内存 clone
 * （P2-SEC-4：loadProviders 返回副本），mutate 不回缓存也无人保存。
 * runner 侧注册落盘函数（load→改→save 读盘最新，防覆盖并发改动），
 * 适配器经 persistDegraded 转发；未注册（如单测直接构造 store）时静默跳过。
 *
 * R30-4（三十轮）：通道补显式 path 维度——同进程双库并发生成时，适配器携
 * 来源 userDataPath（resolveProvider 经 createProvider 注入）调用，分发按显式
 * path 路由；未传（旧形态/单测直调）由 runner 分发器回落「最近 resolve 的活跃
 * path」（进程内口径 = 活跃库优先，兼容不变）。
 */
let _persistDegraded: ((key: string, userDataPath?: string) => void) | null = null
export function registerDegradedPersist(fn: (key: string, userDataPath?: string) => void): void {
  _persistDegraded = fn
}
export function persistDegraded(key: string, userDataPath?: string): void {
  if (!_persistDegraded) return
  try {
    _persistDegraded(key, userDataPath)
  } catch {
    // AA-P3-5：降级记忆是优化通道——写失败（load/save 抛错）不向调用方传播，不得中断
    // 已成功的建流；失败由 runner 侧「不标记」承载，下次 persistDegraded 自然重试。
  }
}

/**
 * 降级记忆新鲜读（批次 D2）——与 persistDegraded 对称的查通道。
 *
 * 缘由：适配器缓存（registry 按 settings hash 复用实例）后，适配器捕获的 store
 * 是创建时刻的快照，降级记忆会读到旧值。runner 注册本回调后，适配器经
 * lookupDegraded 读「此刻磁盘上的记忆」（loadProviders 有 mtime 缓存，代价可忽略），
 * 适配器不再依赖捕获的 store 快照。未注册（单测直接构造 store）时返回 undefined，
 * 由适配器回落到捕获 store 的快照读。
 * R30-4（三十轮）：显式 path 维度同 persistDegraded（见上注）。
 */
let _lookupDegraded: ((key: string, userDataPath?: string) => boolean | undefined) | null = null
export function registerDegradedLookup(fn: (key: string, userDataPath?: string) => boolean | undefined): void {
  _lookupDegraded = fn
}
export function lookupDegraded(key: string, userDataPath?: string): boolean | undefined {
  return _lookupDegraded?.(key, userDataPath)
}
/** 测试辅助：清空注册的查/写回调（防跨用例泄漏） */
export function resetDegradedChannels(): void {
  _lookupDegraded = null
  _persistDegraded = null
}

/** 当前启用的供应商；未配置 / currentId 指向已删条目 → null */
export function currentProvider(userDataPath: string): ProviderConf | null {
  const s = loadProviders(userDataPath)
  if (!s.currentId) return null
  return s.providers.find((p) => p.id === s.currentId) ?? null
}

/** 从已加载 store 算档位（纯函数，不读磁盘——供 resolveProvider 复用，避免重复 loadProviders） */
export function tierFromStore(s: ProviderStore, kind: 'creative' | 'assistant' | 'chat'): TierSlot {
  const fallback = s.currentModel ?? ''
  // RB-AI-P2-6：tiers 缺 creative 键（providers.json 直灌/半迁移）防御性访问——
  // 此前直接 .creative.model 抛 TypeError → API 500；缺键回落默认档位（currentModel + xhigh）
  if (kind === 'assistant' && s.tiers?.assistant) {
    return s.tiers.assistant.model ? s.tiers.assistant : { ...s.tiers.assistant, model: fallback }
  }
  if (kind === 'chat' && s.tiers?.chat) {
    return s.tiers.chat.model ? s.tiers.chat : { ...s.tiers.chat, model: fallback }
  }
  const creative = s.tiers?.creative
  if (!creative) return { model: fallback, effort: 'xhigh' }
  return creative.model ? creative : { ...creative, model: fallback }
}

/** 取档位配置（assistant/chat 未配 / model 为空 → 回落 creative + currentModel） */
export function resolveTier(userDataPath: string | null, kind: 'creative' | 'assistant' | 'chat'): TierSlot {
  if (!userDataPath) return { model: '', effort: 'xhigh' }
  return tierFromStore(loadProviders(userDataPath), kind)
}

/** 新供应商 ID */
export function newProviderId(): string {
  return `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** 新 RAG 服务商 ID（rag- 前缀与 chat 服务商区分，vault 槽天然不撞） */
export function newRagProviderId(): string {
  return `rag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** key 遮蔽：只留前 4 后 4，不足 8 位 → *** */
export function maskKey(key: string): string {
  if (key.length < 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

/**
 * 当前供应商 + 当前模型的模型行覆盖（P9 §7.2 显式 resolve 链第 1 层）。
 * 运行时 `provider.conf.model` 已由 resolveProvider 注入实际档位模型。
 * 无行（供应商没配 / 行没有该 id）→ undefined，消费者回落 quirks 表/协议兜底。
 */
export function modelConfOf(conf: ProviderConf): ModelConf | undefined {
  return conf.models?.find((m) => m.id === conf.model)
}
