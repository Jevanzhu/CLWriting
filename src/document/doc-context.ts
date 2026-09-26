/**
 * DocContext —— 文档层共享设施的显式上下文（源码质量评审）。
 *
 * 为什么存在：本轮之前，`service-meta.ts` 要复用保存链的锁编排 / 清单读写 / 路径安全 /
 * 快照策略，只能靠 service.ts 把 `bookRoot`/`journalDir`/`snapshotsDir`/`manifestPath`
 * 四个字段与五个方法**剥掉 private 并标 `@internal`** 让兄弟模块从类实例上摸——任何模块
 * 都能改类内部状态，封装形同虚设，且读代码要在两个文件间来回跳（评审原文）。
 * 现改为：共享设施收进本对象、由文档层组装根（DocumentService 构造处）构造一次，各操作
 * 成为显式接收 `(ctx, params)` 的模块函数（service.ts / service-move.ts / service-meta.ts）。
 * 类上再无 `@internal` 剥离面——需要跨模块共享的一切，只能经本文件的显式 API。
 *
 * 所有权与生命周期（注释只写代码说不出的约束，此三条是硬约束）：
 * - **单实例所有权**：一个 DocContext 绑定一个 bookRoot、只由一个 DocumentService 实例
 *   持有并随其存活（`documents-core.ts` 的 per-bookRoot service 缓存即其生命周期边界：
 *   删书/换书时缓存清除，ctx 与其实例字段上的缓存一同被丢弃）。跨实例复用一个 ctx 会
 *   把两本书的清单/journal/快照设施与每实例缓存（字数缓存、策略缓存、meta 串行链）
 *   搅在一起，**禁止**。
 * - **不导出可变态**：可变状态（`globalPolicyCache` / `docWordsCache` / `metaOpChains`）
 *   一律 private，只能经下列方法读写；外部不得持有其引用，也不得为测试之外的用途改写。
 * - **路径口径唯一**：`journalPathOf` 是 per-doc journal 路径的唯一构造点（`encodeDocDirName`
 *   的文件名编码口径在此单源）——各操作不得再自行 join，编码漂移会让同一 docId
 *   的 journal 分裂成两个文件（保存链的 pending/aborted 落在一处、恢复链扫另一处）。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeWinSeparators, platformCaseFold, resolveWithinRoot } from '../fs/safe-path.js'
import { acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { toNfcName } from '../fs/text-canonical.js'
import { isInternalBookPath } from './layout.js'
import {
  readManifestStrict,
  upsertEntry,
  withManifestLockAsync,
  writeManifest,
  type ManifestEntry,
} from './manifest.js'
import { DEFAULT_VERSION_POLICY, encodeDocDirName, readGlobalSnapshotPolicy, type VersionPolicy } from './version.js'
import { scanBookTree } from './tree.js'
import { findByLegacyId } from './service-helpers.js'
// 锁档常量（生产默认值单源）——本容器是保存链三档生效值的持有者（收敛：
// 原 service-guards 模块级 ForTest 注入口改 per-ctx 显式注入，测试经 DocContextOptions 传档）。
import { META_SAVE_LOCK_TIMEOUT_MS, WIRING_SAVE_LOCK_TIMEOUT_MS, SAVE_LOCK_TIMEOUT_MS } from './service-guards.js'
import type { Revision } from './revision.js'

export interface DocContextOptions {
  bookRoot: string
  /** APP 级数据目录（Electron userData）：写时清理读 global.json 全局保留策略（版本保留三层链）。 */
  userDataPath?: string | null
  /** 保存链锁等待档覆盖（毫秒，测试注入用；缺省 = 生产常量档，逐位不变）。
   *  ：save/meta/wiring 三档自 service-guards 模块级 ForTest 注入口收敛为
   *  per-ctx 注入——锁档是「每服务实例的组装参数」，不再是无主的模块级可变态。 */
  saveLockTimeoutMs?: number
  /** 元数据 PATCH 链（updateChapterMeta/updateDocMeta）的 save 锁等待档；缺省同 save。 */
  metaSaveLockTimeoutMs?: number
  /** 布线文件第二道锁的等待档；缺省同 save。 */
  wiringSaveLockTimeoutMs?: number
}

/** withSaveLocks 参数（-的编排契约，语义见方法注）。 */
export interface SaveLocksArgs<T> {
  journalPath: string
  /** 调用方已持同 docId save 锁时 false（锁基建禁同进程嵌套同路径锁，重取必超时）。 */
  holdSaveLock?: boolean
  saveTimeoutMs: number
  onSaveLockThrown: (e: unknown) => T
  onSaveLockTimeout: () => T
  wiring?: { relPath: string; timeoutMs: number; onThrown: (e: unknown) => T; onTimeout: () => T }
  body: () => Promise<T>
}

export class DocContext {
  /** 书仓库根（绝对路径）。 */
  readonly bookRoot: string
  readonly userDataPath: string | null
  /** journal 目录（<bookRoot>/工作区/.journal）。 */
  readonly journalDir: string
  /** 版本快照目录（<bookRoot>/工作区/.版本）。 */
  readonly snapshotsDir: string
  /** 文档清单路径（<bookRoot>/项目/文档清单.jsonl）。 */
  readonly manifestPath: string

  // ── 保存链锁等待档（模块级 ForTest 注入口 → per-ctx 组装参数）────
  // 语义与档位见各常量注（service-guards.ts 单源）；只读字段——注入只在构造时发生，
  // 实例存活期内恒定（与「每 ctx 一书一实例」的所有权口径一致，无运行期改写通道）。
  /** executeSave 主保存锁（`<journalPath>.save.lock`）等待档。 */
  readonly saveLockTimeoutMs: number
  /** 元数据 PATCH 双路径的 save 锁等待档。 */
  readonly metaSaveLockTimeoutMs: number
  /** 布线文件写路径第二道同名锁的等待档。 */
  readonly wiringSaveLockTimeoutMs: number

  constructor(opts: DocContextOptions) {
    this.bookRoot = opts.bookRoot
    this.userDataPath = opts.userDataPath ?? null
    this.journalDir = join(this.bookRoot, '工作区', '.journal')
    this.snapshotsDir = join(this.bookRoot, '工作区', '.版本')
    this.manifestPath = join(this.bookRoot, '项目', '文档清单.jsonl')
    this.saveLockTimeoutMs = opts.saveLockTimeoutMs ?? SAVE_LOCK_TIMEOUT_MS
    this.metaSaveLockTimeoutMs = opts.metaSaveLockTimeoutMs ?? META_SAVE_LOCK_TIMEOUT_MS
    this.wiringSaveLockTimeoutMs = opts.wiringSaveLockTimeoutMs ?? WIRING_SAVE_LOCK_TIMEOUT_MS
  }

  /** per-doc journal 路径唯一构造点（文件名编码口径单源，见文件头注第三条）。 */
  journalPathOf(docId: string): string {
    return join(this.journalDir, `${encodeDocDirName(docId)}.jsonl`)
  }

  /** 路径安全：批 6 统一委托 resolveWithinRoot（symlink 防越出 + fail-closed，
   *  目标存在时返回 realpath；此前本方法为各变体中语义最全的一份，canonical 即取自它）。
   *  ：realpath 反查内部簿记（仅跳板形态）——capabilitiesOf 只按
   *  **词法** relPath fail-closed 内部路径（layout.ts ），书内 symlink（如
   *  设定/x.md → 项目/book.yaml）使能力判定按词法放行、落写却命中 realpath 的系统
   *  文件。判定限定「词法非内部 && realpath 内部」的跳板形态：词法内部路径（doTrash
   *  的 .trash 落点等合法内部用法）仍放行交能力层拒绝，错误码口径不变。仅覆盖
   *  「目标已存在」面（resolveWithinRoot 对存在目标才 realpath）；不存在目标的中间
   *  目录 symlink 窗口是已认账取舍，不在此扩面。 */
  resolveSafePath(relPath: string): string | null {
    const safe = resolveWithinRoot(this.bookRoot, relPath)
    if (!safe) return null
    // -mac适配：词法面归一 win32-only（与 safe.rel 同委托单源）——
    // posix 上字面 `\` 不再被当分隔符，两侧口径对齐后跳板形态判定不劈叉
    const lexical = normalizeWinSeparators(relPath)
    if (!isInternalBookPath(lexical) && isInternalBookPath(safe.rel)) return null
    return safe.abs
  }

  /** 布线线索文件的跨进程文件锁键（非布线文件 → null 不加锁）。
   *  背景：lead-finalize.ts 对单个布线文件的「读旧→补履历→writeLead」临界段持
   *  `<文件绝对路径>.lock`，与保存链按 journal 命名的 save 锁互不感知—— 注释宣称
   *  防住了「作者经 executeSave 保存同一布线文件」，实际没防住（lost update：保存的新正文
   *  被回写的旧正文整文件覆盖）。保存链三个写路径（executeSave/updateChapterMeta/
   *  updateDocMeta）在 save 锁内对本文件再取**同名锁**，双侧同名锁互斥后覆盖窗口真正
   *  闭合。键必须与 lead-finalize 同构造（join(bookRoot, relPath) 词法路径，不经
   *  realpath）——resolveSafePath 对存在目标返回 realpath，在 symlink 根（macOS tmp
   *  /var→/private/var）下会拼出不同键名使互斥失效。关系线按 lead-finalize 同口径位于
   *  大纲/关系线/（同为布线族回写点），一并覆盖。
   *  锁序：全仓统一「save 锁 → 布线锁 → 清单锁」——定稿链原
   *  「持清单锁内取布线锁」的反向交叉对已由 finalize 入口预取布线锁消除。 */
  wiringFileLockKey(relPath: string): string | null {
    // -mac适配：前缀门归一 win32-only——真实布线文件（`布线/`、
    // `大纲/关系线/` 前缀）两种形态下判定一致、键字节用原始 relPath 不受影响；
    // files.ts wiringLockKeyForPut（范围外）暂保留无条件归一，可达路径上判定与键逐位一致
    const p = normalizeWinSeparators(relPath)
    if (p.startsWith('布线/') || p.startsWith('大纲/关系线/')) {
      const key = `${join(this.bookRoot, relPath)}.lock`
      // win32 大小写折叠（对齐 manifestLockKey ）——外部
      // case-only 改名后 save 链与 lead-finalize 链此前会取不同锁文件，互斥静默失效
      // lead-finalize 侧锁键已同口径折叠（wiringFileLockKeyOf）——
      // 本侧此前单侧折叠构成不对称，现两侧逐位一致（回归测试锚定同键；不为收口单一
      // 真相源引入 service↔lead-finalize 循环 import——后者已反向 import isUtf8Bytes）
      // 折叠改委托 safe-path platformCaseFold 单源——safe-path 为
      // 底层叶子模块，委托不引入循环 import；前缀过滤/join/'.lock' 管线不变，键字节不变
      // （修复批）：折叠前补 toNfcName（先 NFC 后
      // 大小写折叠，与文档身份键 docJoinKey = relPathKey(toNfcName(p)) 同序并齐）——
      // mac 上清单登记路径（NFC 为主）与磁盘扫描路径（NFD，外源工具常产）此前对同一
      // 布线文件派生两个不同 .lock 文件名，保存链与终稿链（锁内重读-合并-写回）互斥
      // 静默失效（丢失更新窗）。join(bookRoot, relPath) 后整段 NFC 安全：分隔符 / 不受
      // 组合字符影响（docJoinKey 注释同口径）；NFC 输入键字节不变（与字节稳定
      // 不变量相容），仅 NFD 输入键变化；lead-finalize 侧（wiringFileLockKeyOf）与
      // files.ts PUT 侧（wiringLockKeyForPut）同批同式，三侧仍逐位一致
      return platformCaseFold(toNfcName(key))
    }
    return null
  }

  /** （修复批）：保存链锁编排单源——「save 锁
   *  （`<journalPath>.save.lock`：获取自身抛出→收口 WRITE_ERROR，等待超时 null→fail-closed
   *  收口）→ 布线锁（wiringFileLockKey 非空时；异常/超时先释放 save 锁防泄漏再收口）→
   *  body → finally 逆序 release（release 幂等）」。此前 executeSave /
   *  updateChapterMetaLocked / updateDocMetaLocked / doMoveOrRename / doTrash 五处各持
   *  一份 ~50 行同构编排；锁序（全仓 save → 布线 → 清单）与失败语义逐位不变：
   *  - holdSaveLock=false（doMoveOrRename 调用方已持同 docId save 锁）：跳过取锁与释放；
   *  - wiring 缺省（结构性操作段）：不取布线锁，零开销（布线判定 wiringFileLockKey
   *    仍在 helper 内单源执行，与旧各处就地判定同位同序）；
   *  - 失败收口文案各调用面专属（超时/异常文案逐字保留），由回调注入。
   *  （save 锁动机）/（获取抛出收口）/+（布线锁与锁序）/
   *  （等待异步化）的机制本体自该批起单源此处，动机沿革见各调用面注释。
   *  ：编排随共享设施自 DocumentService 迁入本对象——本方法不再依赖类实例，
   *  五个调用面统一 `ctx.withSaveLocks(...)`，语义与锁序逐位不变。 */
  async withSaveLocks<T>(args: SaveLocksArgs<T>): Promise<T> {
    let docSaveLock: (() => void) | null = null
    if (args.holdSaveLock ?? true) {
      try {
        docSaveLock = await acquireCrossProcessLockAsync(`${args.journalPath}.save.lock`, args.saveTimeoutMs)
      } catch (e) {
        return args.onSaveLockThrown(e)
      }
      if (!docSaveLock) return args.onSaveLockTimeout()
    }
    let wiringLock: (() => void) | null = null
    if (args.wiring) {
      const wiringKey = this.wiringFileLockKey(args.wiring.relPath)
      if (wiringKey) {
        try {
          wiringLock = await acquireCrossProcessLockAsync(wiringKey, args.wiring.timeoutMs)
        } catch (e) {
          docSaveLock?.()
          return args.wiring.onThrown(e)
        }
        if (!wiringLock) {
          docSaveLock?.()
          return args.wiring.onTimeout()
        }
      }
    }
    try {
      return await args.body()
    } finally {
      // 布线文件锁先于 save 锁释放（逆获取序），release 幂等
      if (wiringLock) wiringLock()
      if (docSaveLock) docSaveLock()
    }
  }

  /** upsertManifestEntry 的异步孪生——executeSave 锁内复核的
   *  legacy 收编链专用。等待期 withManifestLockAsync（setTimeout 轮询，事件循环不
   *  阻塞），RMW 本体与同步版逐位对齐（strict 读/同错误/同锁文件）。（三十
   *  四轮）：doCreate/doCopy 登记亦迁本异步孪生；残留清偿批：同步版随 adoptLegacyDoc
   *  链删除——本函数成为清单登记唯一实现。 */
  async upsertManifestEntryAsync(docId: string, relPath: string): Promise<void> {
    await withManifestLockAsync(this.manifestPath, () => {
      const m = existsSync(this.manifestPath)
        ? readManifestStrict(this.manifestPath)
        : { version: 1, entries: new Map<string, ManifestEntry>() }
      upsertEntry(m, { id: docId, nodeType: 'document', path: relPath, parentId: null })
      mkdirSync(dirname(this.manifestPath), { recursive: true })
      writeManifest(this.manifestPath, m)
    })
  }

  /** lookupPathByDocId 的异步收编孪生（executeSave 锁内复核用）。
   *  清单命中读与同步版同口径（无锁读）；miss 且 legacy 前缀时扫盘反查后经异步清单锁
   *  登记——原路径 adoptLegacyDoc → upsertManifestEntry 用同步 withManifestLock
   *  （Atomics.wait），双进程争用窗口内在 save 锁等待异步化的保存链上重新引入最长
   *  2×5s 的事件循环阻塞。残留清偿批全调用面（含端点侧
   *  resolvePathAsync）已迁本孪生，同步链删除——本函数为 docId 收编唯一实现。 */
  async lookupPathByDocIdAdoptAsync(docId: string): Promise<string | null> {
    if (existsSync(this.manifestPath)) {
      // （c 修复批）：命中读改 readManifestStrict（与 RMW 链
      // upsertManifestEntryAsync/updateManifestPath 的口径对齐）——容错版对瞬态
      // 读失败（EBUSY/EACCES）返空表，守卫把「登记在册」误判「未登记」：save 走新建语义
      // 在旧路径落盘（同内容双文件/复活窗），trash/move 的「未登记」分支同样静默失效。
      // strict 读失败上抛，由各调用方既有 WRITE_ERROR 信封收口（fail-closed：未落盘、
      // 可重试）——executeSave 前段/锁内复核本就有 catch，本函数的直调方（meta/结构性
      // 操作）已随 /3 各自补 catch。
      const path = readManifestStrict(this.manifestPath).entries.get(docId)?.path
      if (path) return path
    }
    if (!docId.startsWith('legacy:')) return null
    const hit = findByLegacyId(scanBookTree(this.bookRoot), docId)
    if (!hit) return null
    await this.upsertManifestEntryAsync(docId, hit)
    return hit
  }

  /** 条件性更新清单：书已有清单 + 条目已存在 → 刷新 path；否则 no-op（保存不建清单）。
   *  ：RMW 全程持清单锁（跨进程互斥）。
   *  ：锁等待异步化（withManifestLockAsync）——读改写文件操作本身仍是同步 FS
   *  调用（毫秒级无妨），仅锁争用等待期不阻塞事件循环；超时档与 fail-closed 语义不变。 */
  async maybeUpdateManifest(docId: string, relPath: string): Promise<void> {
    if (!existsSync(this.manifestPath)) return
    await withManifestLockAsync(this.manifestPath, () => {
      const m = readManifestStrict(this.manifestPath) // RMW strict 读——读失败拒写保旧清单
      const entry = m.entries.get(docId)
      if (!entry || entry.path === relPath) return
      entry.path = relPath
      writeManifest(this.manifestPath, m)
    })
  }

  /** 清单 path 更新（move/rename 用，docId 不变）。：RMW 持清单锁。 */
  async updateManifestPath(docId: string, newPath: string): Promise<void> {
    if (!existsSync(this.manifestPath)) return
    // 清单锁等待异步化（withManifestLockAsync，原语）——
    // RMW 本体仍全程同步 FS，语义与同步版逐位对齐
    await withManifestLockAsync(this.manifestPath, () => {
      const m = readManifestStrict(this.manifestPath) // RMW strict 读
      const entry = m.entries.get(docId)
      if (!entry) return
      entry.path = newPath
      writeManifest(this.manifestPath, m)
    })
  }

  /** 快照保留策略（起只走全局）：global.json snapMax* → 硬编码默认；book.yaml snapshots 已砍书级。
   *  ：global.json 解析结果走 stat 缓存——每次 save 都 existsSync+readFileSync
   *  改为 statSync 一次（stat 远廉价于读盘，与 version.ts 指纹缓存同款「缓存命中免读盘」口径）。
   *  失效条件：global.json 的 mtimeMs（取整毫秒）或 size 任一变化即重读重解析——作者手工
   *  编辑 global.json 后**下一次 save 即生效**（无需重启）；stat 失败（文件不存在/不可读）
   *  不缓存负条目，直接回落空策略；进程重启缓存自然失效（实例字段）。 */
  snapshotPolicy(): VersionPolicy {
    const global = this.readGlobalPolicyCached()
    return {
      maxDays: global.maxDays ?? DEFAULT_VERSION_POLICY.maxDays,
      maxCount: global.maxCount ?? DEFAULT_VERSION_POLICY.maxCount,
      throttleMinutes: DEFAULT_VERSION_POLICY.throttleMinutes,
    }
  }

  private globalPolicyCache: { statKey: string; value: { maxDays?: number; maxCount?: number } } | null = null

  /** global.json 的 stat 键控缓存读取（见 snapshotPolicy 注释）。 */
  private readGlobalPolicyCached(): { maxDays?: number; maxCount?: number } {
    if (!this.userDataPath) return {}
    const p = join(this.userDataPath, 'global.json')
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch {
      return {}
    }
    const statKey = `${Math.floor(st.mtimeMs)}:${st.size}`
    if (this.globalPolicyCache?.statKey === statKey) return this.globalPolicyCache.value
    const value = readGlobalSnapshotPolicy(this.userDataPath)
    this.globalPolicyCache = { statKey, value }
    return value
  }

  /** docId → 盘上整文件 revision 与其正文字数的缓存。
   *  以 revision（整文件 sha256）为键控：同字节 ⇒ 同正文字数（countWords 确定性），
   *  外部编辑器/他窗写入必变 rev ⇒ 命中判据自动失效重算，零陈旧窗口；命中时保存链
   *  免 diskBytes.toString('utf-8') 整篇旧文物化（2MB 章 ≈4MB 瞬时字符串）。
   *  上限防御（口径）：超限整体清空，最坏重算一次（条目仅 ~50B/文档）。 */
  private docWordsCache = new Map<string, { rev: Revision; words: number }>()

  /** 字数缓存读取（命中返回该 revision 下的正文字数，未命中/换版返回 undefined）。 */
  cachedDocWords(docId: string, rev: Revision): number | undefined {
    const cached = this.docWordsCache.get(docId)
    return cached !== undefined && cached.rev === rev ? cached.words : undefined
  }

  /** 字数缓存写入（executeSave 旧文侧回填 + 成功落盘后新文侧回填共用）。 */
  rememberDocWords(docId: string, rev: Revision, words: number): void {
    if (this.docWordsCache.size >= 4096) this.docWordsCache.clear()
    this.docWordsCache.set(docId, { rev, words })
  }

  /** 同 docId meta 操作串行链——锁等待让出事件循环后，同文档第二
   *  请求会撞跨进程锁文件的同进程 pid 自锁语义（等满超时 fail-closed）。promise 链串行
   *  保持旧同步版「单线程无交错」行为等价（跨进程互斥仍由文件锁承担）。
   *  每 ctx（= 每服务实例）状态，严禁提为模块级单例（多服务实例会跨实例串态——见文件头注）。 */
  private metaOpChains = new Map<string, Promise<unknown>>()

  chainDocMetaOp<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.metaOpChains.get(docId) ?? Promise.resolve()
    const p = prev.then(fn, fn)
    this.metaOpChains.set(docId, p)
    void p
      .catch(() => {})
      .finally(() => {
        if (this.metaOpChains.get(docId) === p) this.metaOpChains.delete(docId)
      })
    return p
  }
}
