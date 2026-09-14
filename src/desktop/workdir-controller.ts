/**
 * 工作目录（书库）控制器（复审-0914-优化修复批 F1 自 main.ts 拆出——纯移动零逻辑变化）。
 *
 * 收编面（原 main.ts :404-767 对应节）：
 * - workdir.json 持久化（storePath/readStore/writeStore/saveCurrent 族 + 切库回滚基线）；
 * - bootstrap 实际 workDir 记账（currentWorkDir 统一取值面，M-3）；
 * - 切库守卫与可达性预探（isLibraryDir/canSwitchLibraryDir/probeDirReachable）；
 * - 原生目录选择器与切库入口（pickLibrary/warnIfCaseSensitive/openLibraryAction）；
 * - relaunch 意图与不可回头点武装（pendingRelaunch/armPendingRelaunchIfAny，R51-A-1）；
 * - F2 同批样板收敛：resolveReachableWorkDir（三 IPC 入口内联的「workDir 判空 +
 *   probeDirReachable unreachable 错误框」×3 单源）与 findBookEntry（readBooks().find ×2
 *   单源）、msgBox/openDirDialog（dialog 双参/单参三元 ×3 单源）。
 *
 * 纯数据变换在 workdir-store.ts（零 Electron 依赖可单测）；本文件是 Electron 绑定层
 * （app.getPath/dialog）+ 守卫/选择器编排，对齐「Electron 绑定层留在需要处」纪律。
 * 模块级零副作用：app.getPath 只在函数内惰性调用（storePath）——本文件随 main.ts 的
 * import 先于其模块体求值，app.setPath('userData') 必须先行。
 */
import {
  app,
  dialog,
  type BrowserWindow,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from 'electron'
import { basename, join, resolve } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises' // R54-A-2：切库可达性预探（异步+超时，不冻主进程）
import { findWorkDir, readBooks } from '../install/books.js'
import { findGitAncestor } from '../install/scaffold.js' // R44-14：git-ancestor 防线与 init（doInitSteps）同源判定
import { atomicWriteFile } from '../fs/atomic.js'
import { probeCaseSensitive } from '../fs/case-probe.js' // 平台规范化批 E：大小写敏感卷探测
import { samePath } from '../fs/user-data-path.js'
import { errMsg, log } from '../log/index.js'
import {
  emptyStore,
  parseStore,
  raceWithTimeout,
  serializeStore,
  setCurrent,
  type WorkDirStore,
} from './workdir-store.js'
import { wins } from './windows.js'

// ── 工作目录持久化（userData/workdir.json）──────────────

/** 持久化文件路径（Electron userData 目录）。 */
function storePath(): string {
  return join(app.getPath('userData'), 'workdir.json')
}

/** 读 store（含失效 recent 清理）；缺失/损坏 → 空存储。
 *  R47-9（四十七轮）：内存缓存（写时失效）——此前每次调用全量读盘 + 旧同步版
 *  filterValidRecent 逐 recent 项 existsSync+statSync：welcome 态 currentWorkDir 的
 *  ?? 兜底使每次相关 IPC 都重踩，书库在失联网络卷（NAS/SMB「挂载点在而服务器无
 *  响应」态）上时同步阻塞主进程数秒（三窗口输入/IPC 全冻结）。缓存后常态零盘 IO；
 *  recent 有效性过滤只在首读一次执行（workdir.json 系应用管理文件，外部手改重启
 *  可见，可接受）。
 *  R1010-P2-1（2026-09-10 全量重评 GLM-5.3 修复批）：首读不再同步过滤——同步逐条
 *  stat 在 recent 残留失联网络卷时照样冻主进程数十秒（重审-1 probeDirReachable
 *  防线只护 current/cwd，recent 条目在防线外）。readStore 仅 parse 缓存，过滤挪
 *  bootstrap 异步预算一次执行（filterValidRecentBudgeted，超时项保留展示——见其
 *  头注；bootstrap await 先于任何 IPC 注册，早读窗口不存在）。
 *  R48-73（四十八轮）备案（取舍补记）：首读过滤后运行期不再复验——会话内被外部
 *  （或本应用他路径）删除的书库目录会残留展示至重启，R47-9 注释只声明了「外部手改
 *  重启可见」一半。接受依据：点切换有 canSwitchLibraryDir 守卫拦截兜底（失效目录
 *  拒切），残留只污展示面不产行为错；逐次复验即回到 R47-9 要治的 NAS/SMB 同步阻塞。
 *  返回共享引用——调用方（setCurrent/saveCurrent）均为纯函数式建新对象，无 mutate 面。
 *  P3（复审-0914-优化修复批）：原 existsSync 前置分支删除——readFileSync 的 ENOENT
 *  （文件尚未创建的首次启动常态）在 catch 内静默按「无存储」降级（与原分支逐位等价，
 *  省一次前置 stat 系统调用），其余读失败维持 R61-B-2 的 warn 留痕降级。 */
let storeCache: WorkDirStore | null = null
function readStore(): WorkDirStore {
  if (storeCache) return storeCache
  const fp = storePath()
  // R61-B-2（六十一轮评审）：文件级读失败容错——此前失败面不对称：parseStore 对内容
  // 损坏已容错（返回 undefined 走默认）、loadWinState 对整个读过程 catch-all，唯
  // readFileSync 本身抛错（权限 EACCES、杀毒/同步盘瞬时锁）无人捕获 → bootstrap 链
  // 抛错 →「启动失败」退出。修复 = 读失败单独 try/catch，按「无存储」降级（与
  // parseStore 失败同款形态：缓存 emptyStore，下次调用不再重读）+ warn 留痕（带路径
  // 与原因）；启动可用性优先，不改变成功路径与缓存语义。
  let raw: string
  try {
    raw = readFileSync(fp, 'utf-8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // 文件不存在 = 无存储（原 existsSync 前置分支的等价形态，静默不留痕）
      storeCache = emptyStore()
      return storeCache
    }
    log.warn('desktop', `workdir.json 读取失败（按无存储降级）：${fp} —— ${errMsg(e)}`)
    storeCache = emptyStore()
    return storeCache
  }
  // R1010-P2-1：仅 parse 缓存（同步零盘 IO 除读文件本身）——recent 失效过滤挪 bootstrap
  // 异步预算执行（见 readStore 头注），失联网络卷不再同步冻首读
  storeCache = parseStore(raw)
  return storeCache
}

/** 原子写 store。R47-9：写后同步刷新缓存（写后即读一致）。 */
function writeStore(store: WorkDirStore): void {
  atomicWriteFile(storePath(), serializeStore(store))
  storeCache = store
}

/** 设新 current（旧入 recent）+ 持久化。 */
function saveCurrent(dir: string): void {
  writeStore(setCurrent(readStore(), dir))
}

/**
 * R51-A-4（五十一轮）：saveCurrent 的契约化包装——IPC 端点响应面是 `{ok,reason}`
 * 信封，而 saveCurrent → atomicWriteFile 可抛（磁盘满/权限/只读卷），裸抛会绕过契约
 * 直达渲染层 invoke 的异常通道（切库静默无反馈、前端拿不到结构化失败）。返回 null =
 * 成功；字符串 = 人话失败原因（调用方转 `{ok:false, reason}`，且不触发 relaunch——
 * 落库失败的切库若照常重启，应用会带着旧 current 重启、用户操作看起来像被吞）。
 * 菜单链 openLibraryAction 同走本包装（R57-A-2，五十七轮）：落库失败弹一次性原生
 * 错误框反馈并中止切换——原「调用点 .catch 留痕兜底」取舍废弃（日志留痕对用户
 * 不可见，点菜单后切换静默失败）。
 */
function saveCurrentSafe(dir: string): string | null {
  try {
    saveCurrent(dir)
    return null
  } catch (e) {
    log.error('main', `workdir.json 持久化失败（切库中止）：${errMsg(e)}`, e)
    return `书库目录落库失败（workdir.json 写入异常）：${errMsg(e)}`
  }
}

// R59 清偿批（R55-A-3）：切库回滚基线——三条切库入口（open-library / switch-library /
// 菜单 openLibraryAction）都是「先落库新 current，再 relaunch 走 before-quit 优雅退出」，
// 而退出链的冲突/保存失败原生确认可被取消（R44-19「取消即中止退出、应用原样保留」）。
// 取消后会话内继续跑旧库，workdir.json 却已指向新库——跨会话落入「已被取消」的新库。
// 故切库落库前快照 store 作回滚基线：取消路径回写（rollbackCancelledSwitch），过不可
// 回头点（armPendingRelaunchIfAny，退出既成、新库即用户所愿）即作废。store 对象为
// 不可变更新（setCurrent 纯函数建新对象），持快照引用安全；快照到回滚之间无其他写方
//（writeStore 仅切库链触达）。
let switchRollbackStore: WorkDirStore | null = null

/** 切库链专用落库：快照当前 store → saveCurrentSafe → 成功才武装回滚基线。
 *  三入口共用本函数——武装点收敛一处，新增切库入口漏接即测试面缺口。
 *  快照读失败按无基线处理（快照本身非切换要件）：readStore 原在 saveCurrentSafe
 *  的 try 内（R51-A-4 契约化错误面），此处外提后若裸抛反而放宽了失败语义；
 *  落库失败的契约返回由 saveCurrentSafe 内层 readStore（缓存）原样保住。 */
function saveCurrentArmingRollback(dir: string): string | null {
  let prev: WorkDirStore | null = null
  try {
    prev = readStore()
  } catch {
    prev = null
  }
  const err = saveCurrentSafe(dir)
  if (err) return err
  switchRollbackStore = prev
  return null
}

/** 退出被取消路径调用：回写切库前 store，跨会话不残留被取消的新库。 */
function rollbackCancelledSwitch(): void {
  const prev = switchRollbackStore
  switchRollbackStore = null
  if (!prev) return
  try {
    writeStore(prev)
    log.info('main', `切库的退出被作者取消：workdir.json 已回写为原书库（${prev.current ?? '未选'}），本会话与下次启动均维持原库`)
  } catch (e) {
    // 回滚写失败不另起错误面（退出取消路径），但必须留痕：持久化面仍指向被取消的
    // 新库，「应用原样保留」跨会话已破——留诊断线索供排查（磁盘满/只读卷同因）
    log.error('main', `切库的退出被取消，workdir.json 回写失败（跨会话仍指向被取消的新库）：${errMsg(e)}`, e)
  }
}

/** P5-服务端（第七轮）：bootstrap 实际采用的 workDir——before-quit 优雅退出回读用
 *  （readStore().current 可能为 null/失效而实际 workDir 由 findWorkDir 发现） */
let bootstrappedWorkDir: string | null = null
/** bootstrap 侧记账入口（原 main.ts bootstrap 内联赋值，拆分后经本函数跨模块写）。 */
export function setBootstrappedWorkDir(dir: string | null): void {
  bootstrappedWorkDir = dir
}

/** M-3（第八轮）：桌面侧统一取「实际运行的书库」——bootstrap 实际采用的 workDir 优先，
 *  store 回读兜底。P5-服务端（第七轮）只修了 before-quit 一点；second-instance --book、
 *  show-in-folder、open-book-dir、open-library-dir 四个入口仍单读 readStore().current，
 *  store.current 为 null/失效而实际跑在 findWorkDir 发现的书库上时全部静默失明。 */
function currentWorkDir(): string | null {
  return bootstrappedWorkDir ?? readStore().current
}

/** 是否合法书库目录（自身含 .clwriting/）。复用 findWorkDir 的判定。
 *  R1W-7（win 平台专项复审 R1）：win 路径大小写不敏感——findWorkDir 返回值与
 *  resolve(dir) 的盘符/目录大小写可能漂移，全等比较会误判「非书库」。 */
function isLibraryDir(dir: string): boolean {
  const found = findWorkDir(dir)
  return found !== null && samePath(found, resolve(dir))
}

/** R41-1（四十一轮）：switch-library 的接受面 = bootstrap 语义（目录存在即可，含
 *  pickLibrary「在此新建」落库的待建空书库），不再要求自身含 .clwriting/——原守卫
 *  直接复用 isLibraryDir 与 bootstrap 分叉：空书库入 recent 后未建首书即退出，最近
 *  列表点回恒被拒，成永久死条目。唯一额外防线：不能是另一书库的子目录（findWorkDir
 *  命中祖先而非自身——防误把书内目录挂成书库根）。
 *  R44-14（四十四轮）：git-ancestor 防线同步——待建空书库（自身及祖先均无
 *  .clwriting/）位于 git 仓库内时，建第一本书会被 doInitSteps 恒拒（init 的 B1
 *  口径），点回即落空壳死胡同，与 pickLibrary「在此新建」同源拒绝。已建成的书库
 *  （findWorkDir 命中自身）不拦：书籍读写不受影响，拦了反而把 R41-1 救活的
 *  recent 条目重新变死条目。 */
function canSwitchLibraryDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false
  } catch {
    return false
  }
  const found = findWorkDir(dir)
  if (found !== null && !samePath(found, resolve(dir))) return false
  if (found === null && findGitAncestor(dir)) return false
  return true
}

/** R54-A-2（五十四轮）：切库可达性预探超时——超过即按「目录暂不可达」契约化拒切，
 *  不再进同步守卫（失联网络卷上 statSync 单点即可冻主进程数十秒）。可注入（测试快进）。 */
const SWITCH_LIBRARY_PROBE_TIMEOUT_MS = Number(process.env['CLW_SWITCH_LIBRARY_PROBE_TIMEOUT_MS']) || 2_000

/** 重审-1（2026-09-07 全量代码重审 §四.1）：bootstrap 工作目录定位预探超时——
 *  store.current / 运行目录指向失联网络卷时，bootstrap 的 statSync / findWorkDir
 *  同步扫描冻主进程（R54-A-2 切库同族的启动侧入口）。可注入（测试快进）。 */
const BOOTSTRAP_PROBE_TIMEOUT_MS = Number(process.env['CLW_BOOTSTRAP_PROBE_TIMEOUT_MS']) || 2_000

/** 预探超时哨兵（raceWithTimeout 的 reject/归一载体——stat 的真实异常都带 errno code，唯超时无）。 */
const PROBE_TIMEOUT = Symbol('switch-library-probe-timeout')

type DirReachability = 'ok' | 'unreachable' | 'invalid'

/**
 * R54-A-2（五十四轮）：切库守卫前的可达性预探——recent 列表残留失联网络卷（挂载点
 * 在服务器无响应态）时，canSwitchLibraryDir 的 statSync/findWorkDir 同步爬祖 +
 * probeCaseSensitive 的写探针全在主进程同步执行，一点「切换」即冻结三窗 UI 数秒
 *（R47-9 readStore 面已修的同族第三处）。先经 fs/promises stat 异步预探（超时
 * SWITCH_LIBRARY_PROBE_TIMEOUT_MS），同步守卫只在活卷上执行（预探通过后拔线的
 * TOCTOU 残窗仍在，但冻结从「恒现路径」收窄为「预探后瞬断」）。
 * 三态分诊：'ok' = stat 通过；'unreachable' = 超时（失联卷挂死面，唯一冻结形态）；
 * 'invalid' = stat 确定性快速失败（ENOENT/EACCES/ENOTDIR 等，不构成冻结面）——
 * 交回同步守卫走原「目录无效」契约文案，不把普通坏路径误报成网络卷不可达。
 * 重审-1：timeoutMs 参数化——bootstrap 侧预探复用同一函数但走独立超时注入
 * （CLW_BOOTSTRAP_PROBE_TIMEOUT_MS），与切库 knob 解耦。
 * P3（复审-0914-优化修复批）：race/哨兵/clearTimeout 竞速体收编 raceWithTimeout 单源。
 */
async function probeDirReachable(dir: string, timeoutMs: number = SWITCH_LIBRARY_PROBE_TIMEOUT_MS): Promise<DirReachability> {
  try {
    const r = await raceWithTimeout(stat(dir), timeoutMs, PROBE_TIMEOUT)
    return r === PROBE_TIMEOUT ? 'unreachable' : 'ok'
  } catch {
    return 'invalid'
  }
}

// ── 目录选择 + 切换 ────────────────────────────────────

/**
 * P3（复审-0914-优化修复批）：dialog 双参/单参三元 ×3（warnIfCaseSensitive 的
 * showMessageBox、pickLibrary 的 showOpenDialog + showMessageBox）收敛单源——
 * parent 缺省时走无 parent 重载，行为逐位不变。
 */
function msgBox(parent: BrowserWindow | undefined, opts: MessageBoxOptions) {
  return parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)
}
function openDirDialog(parent: BrowserWindow | undefined, opts: OpenDialogOptions) {
  return parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts)
}

/**
 * 弹原生目录选择器选书库。批2：仅接受含 .clwriting/ 的目录；非书库提示后重选或取消。
 * 批3 将扩展：非书库目录二次确认 → 引导建书。
 * E-9c（第五十三轮）：「重新选择」原为无上限递归——反复选非书库目录会无限弹窗；
 * 改循环 + 次数封顶（10 次），超限记 error 日志后返回 null 退出（由调用方按取消处理）。
 * @returns 校验通过的目录绝对路径；取消/超限返回 null
 */
const PICK_LIBRARY_MAX_ATTEMPTS = 10 // E-9c：目录选择循环封顶

/**
 * 平台规范化批 E（2026-09-03）：大小写敏感卷警告——探测目录所在卷敏感性，敏感
 * （mac 大小写敏感 APFS / Linux 常态 / win 按目录敏感标记）时弹确认。书库跨机互拷
 * 依赖「大小写不敏感」前提（win/默认 mac 卷均如此），敏感卷上两台机器各自创建的仅
 * 大小写异名文件会劈裂双存。返回 true = 用户选择换个目录（调用方回选择循环/中止切换）。
 */
async function warnIfCaseSensitive(dir: string): Promise<boolean> {
  // 探测失败（null）fail-open：探测本身不挡书库选择主流程
  if (probeCaseSensitive(dir) !== true) return false
  const parent = wins.mainWindow ?? undefined
  const msgOpts: MessageBoxOptions = {
    type: 'warning',
    title: '该目录在大小写敏感的卷上',
    message: `「${basename(dir)}」所在卷区分文件名大小写`,
    detail:
      'Windows 与 macOS 默认卷均不区分大小写；在大小写敏感卷上使用书库，跨机器互拷时可能出现仅大小写不同的重名文件劈裂（两台机器各留一份），不建议在此使用。',
    buttons: ['仍要使用', '换个目录'],
    defaultId: 1,
    cancelId: 1,
  }
  const choice = await msgBox(parent, msgOpts)
  return choice.response === 1
}
async function pickLibrary(): Promise<string | null> {
  // E-9c：递归改循环 + 封顶——超限退出并报错，不再无限弹窗
  for (let attempt = 1; attempt <= PICK_LIBRARY_MAX_ATTEMPTS; attempt++) {
    const parent = wins.mainWindow ?? undefined
    const openOpts: OpenDialogOptions = {
      title: '选择 CLWriting 书库目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = await openDirDialog(parent, openOpts)
    const dir = result.canceled ? null : result.filePaths[0]
    if (!dir) return null
    // R61-B-1（六十一轮）：可达性预探先行——失联网络卷不再经 isLibraryDir/findWorkDir
    // 的同步 stat 爬升与 case-probe 同步写探针冻结主进程（与 switch-library 链 R54-A-2
    // 同款防线补齐「打开书库」入口；probeDirReachable 唯一消费点此前仅在切库链）。
    // 命中即原生错误框明确反馈并留在选择循环重选（E-9c 封顶兜底）。
    if ((await probeDirReachable(dir)) === 'unreachable') {
      dialog.showErrorBox(
        '目录无响应',
        `「${basename(dir)}」暂不可达（可能是网络卷无响应或已断开），请重新选择。`,
      )
      continue
    }
    if (isLibraryDir(dir)) {
      // 平台规范化批 E：大小写敏感卷警告（探测失败 fail-open 不拦）——换目录回循环顶
      if (await warnIfCaseSensitive(dir)) continue
      return dir
    }
    // 非书库目录 —— 决策②：二次确认是否在此新建书库
    const msgOpts: MessageBoxOptions = {
      type: 'question',
      title: '在此新建书库？',
      message: `「${basename(dir)}」还不是书库目录`,
      detail: '确认后在此新建 CLWriting 书库：重启后书架为空，建第一本书时会自动建立 .clwriting/ 等结构。',
      buttons: ['在此新建', '重新选择', '取消'],
      defaultId: 0,
      cancelId: 2,
    }
    const choice = await msgBox(parent, msgOpts)
    if (choice.response === 0) {
      // R52-A-1（五十二轮）：嵌套书库防线——「在此新建」目标位于既有书库内部
      //（findWorkDir 命中祖先而非自身）时此前放行：内层 .clwriting/ 建成后抢占
      // workDir 判定（外层书库的 server 端口/锁根/task-gate 单进程单锁契约被内层
      // 篡改面）。与 canSwitchLibraryDir（switch-library 侧同款防线）口径对齐；
      // 命中即原生错误框明确反馈并留在选择循环重选，不落死胡同。
      const foundWork = findWorkDir(dir)
      if (foundWork !== null && !samePath(foundWork, resolve(dir))) {
        dialog.showErrorBox(
          '所选位置在另一书库内部',
          `「${basename(dir)}」位于书库（${foundWork}）内部，不能作为独立书库——嵌套书库会使工作目录判定歧义（建书结构被外层书库吞并）。请选择该书库以外的目录。`,
        )
        continue
      }
      // R44-14（四十四轮）：git-ancestor 防线前移——init 的 doInitSteps 对 git 仓库内
      // 工作目录恒拒绝建书（书文件会被外层 git 版本控制吞掉），此处放行会让作者把
      // 待建空书库落库并重启后，到「建第一本书」才被拒——空壳死胡同（书架恒空、建书
      // 恒拒、recent 里的它也无处可去）。与 init 同源判定（findGitAncestor），命中即
      // 原生错误框明确反馈并留在选择循环重选，不落死胡同。
      const gitRoot = findGitAncestor(dir)
      if (gitRoot) {
        dialog.showErrorBox(
          '所选位置在 git 仓库内',
          `「${basename(dir)}」位于 git 仓库（${gitRoot}）内，不能作为书库——书文件会被外层 git 的版本控制吞掉，建书将被拒绝。请选择 git 仓库外的目录。`,
        )
        continue
      }
      // 新建同样过大小写敏感卷警告（敏感卷上新建 = 后续跨机劈裂的源头）
      if (await warnIfCaseSensitive(dir)) continue
      return dir // 确认在此新建（待建空目录，由调用方持久化 + 重启）
    }
    if (choice.response === 1) continue // 重新选择（E-9c：回到循环顶，受封顶约束）
    return null // 取消
  }
  // E-9c：封顶退出——留痕报错后按取消收口，不无限弹窗困住用户
  log.error('main', `书库目录选择连续 ${PICK_LIBRARY_MAX_ATTEMPTS} 次未选定有效目录，已退出选择流程`)
  return null
}

/**
 * F2（复审-0914-优化修复批）：三 IPC 入口（show-in-folder / open-book-dir /
 * open-library-dir）内联的「currentWorkDir 判空 + probeDirReachable unreachable 原生
 * 错误框」逐字三写收敛单源（M-3 第八轮 + 重审-2 2026-09-07 §四.2 语义原样）。
 * 返回 null = 无 workDir 或不可达（错误框已弹，调用方按「无物可开」静默收口）。
 */
async function resolveReachableWorkDir(): Promise<string | null> {
  const workDir = currentWorkDir() // M-3（第八轮）：bootstrap 实际值优先
  if (!workDir) return null
  if ((await probeDirReachable(workDir)) === 'unreachable') {
    dialog.showErrorBox('目录无响应', '书库目录暂不可达（可能是网络卷无响应或已断开），请稍后重试。')
    return null
  }
  return workDir
}

/**
 * F2（复审-0914-优化修复批）：show-in-folder / open-book-dir 内联的
 * `readBooks(workDir).find((b) => b.name === name)` ×2 收敛单源（语义逐位不变）。
 */
function findBookEntry(workDir: string, name: string): ReturnType<typeof readBooks>[number] | undefined {
  return readBooks(workDir).find((b) => b.name === name)
}

/** 重启进程以应用新 workDir（规避 server 路由单例，见方案 §3.1）。
 *  R51-A-1（五十一轮）：app.relaunch() 武装与 releaseSingleInstanceLock 均不可回滚——
 *  原实现当场三连（relaunch+release+quit），后续 before-quit 链的 flush 冲突/失败
 *  确认一旦取消（R44-19/重评-1「取消即中止退出、应用原样保留」），应用带着「已释放
 *  单实例锁 + 已武装重启」续跑：真双开可抢入、后续任意一次退出被劫持成重启。改为只
 *  记意图并走优雅退出；真正的武装与锁释放推迟到 before-quit 链的不可回头点
 *  （armPendingRelaunchIfAny），取消路径同步丢弃意图。 */
let pendingRelaunch = false

/** R51-A-1：不可回头点武装——flush 确认全过、appTearingDown 置位处调用；切库意图
 *  在此刻兑现（app.relaunch() + R27-96 显式交接释放锁，锁时序缝隙与最坏结果分析见
 *  原 relaunch 注）。仅切库链带意图时动作，普通退出零副作用。 */
function armPendingRelaunchIfAny(): void {
  // R59 清偿批（R55-A-3）：不可回头点之后新库即用户所愿，回滚基线作废（普通退出
  // 无基线时本行为空操作）
  switchRollbackStore = null
  if (!pendingRelaunch) return
  pendingRelaunch = false
  app.relaunch()
  app.releaseSingleInstanceLock()
}

/** R51-A-1：取消退出 = 丢弃切库意图（退出语义不被劫持成重启）——原 quit 链取消路径
 *  内联赋值，拆分后经本函数跨模块置位（语义逐位不变）。 */
function discardPendingRelaunch(): void {
  pendingRelaunch = false
}

function relaunch(): void {
  pendingRelaunch = true
  // RB-SV-P2-6：走 before-quit 优雅清理（app.exit 会跳过 before-quit）
  app.quit()
}

/** 打开书库（菜单/前端共用）：选 → 存 → 重启。返回是否已触发切换。
 *  R57-A-2（五十七轮）：落库改走 saveCurrentSafe 契约化包装——原裸 saveCurrent 可抛
 * （磁盘满/权限/只读卷），异常仅被菜单调用点 .catch 记日志，用户点了菜单毫无反馈、
 * 切换静默失败。失败改一次性原生错误框（对齐 switch-library 链 main.ts saveErr 的
 * 契约化失败形态：菜单链无 {ok,reason} 信封可回，原生框即其反馈面），并中止切换
 * （不 relaunch——落库失败若照常重启，应用带旧 current 重启，操作看似被吞）。 */
async function openLibraryAction(): Promise<boolean> {
  const picked = await pickLibrary()
  if (!picked) return false
  // R59 清偿批（R55-A-3）：落库改切库链专用包装（快照武装回滚基线），取消退出可回写
  const saveErr = saveCurrentArmingRollback(picked)
  if (saveErr) {
    dialog.showErrorBox('打开书库目录失败', `${saveErr}\n\n当前书库未切换，应用将继续在原书库上运行。请检查磁盘空间/权限后重试。`)
    return false
  }
  relaunch()
  return true
}

/**
 * R1010-P2-1（2026-09-10 全量重评 GLM-5.3 修复批）：bootstrap 的 recent 失效过滤
 * 结果回写缓存——原 main.ts bootstrap 内联 `storeCache = { ...(storeCache ?? store),
 * recent: filtered.recent }`（整覆改仅回填 recent 字段：await 窗内菜单/IPC 链的并发写
 * （saveCurrent→writeStore 换 storeCache 对象）不被旧 store 的整对象赋值回滚），拆分
 * 后经本函数跨模块写（storeCache 非导出）。语义逐位不变；?? store：类型收窄兜底
 *（bootstrap 首行 readStore() 已建缓存，此分支 storeCache 恒非空且 !== null）。
 */
export function overwriteRecentInCache(fallbackStore: WorkDirStore, recent: WorkDirStore['recent']): void {
  storeCache = { ...(storeCache ?? fallbackStore), recent }
}

// ── 跨模块导出面（main.ts / ipc.ts / lifecycle.ts 消费）──
// 全部为原 main.ts 内联符号的纯移动（handler 语义与文案逐位不变）。
export { currentWorkDir }
export { isLibraryDir, canSwitchLibraryDir }
export { probeDirReachable }
export { BOOTSTRAP_PROBE_TIMEOUT_MS }
export { warnIfCaseSensitive, pickLibrary }
export { findBookEntry, resolveReachableWorkDir }
export { saveCurrentArmingRollback }
export { rollbackCancelledSwitch, armPendingRelaunchIfAny, discardPendingRelaunch, relaunch }
export { openLibraryAction }
export { readStore }
