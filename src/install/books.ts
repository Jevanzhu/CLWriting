/**
 * books.jsonl 登记 + 活动书 —— 依据 M5 #32。
 *
 * M0–M4 既有命令从「单书 cwd」走向「工作目录多书」的核心接缝：
 * - books.jsonl 登记有哪些书；.clwriting/active 指当前哪本（指针，换书只改它）
 *
 * R0916-5e（2026-09-16，⑤④产品拆分波1）：本文件纯移动拆分——缝 B（工作目录定位/
 * 书仓库判定）→ books-resolve.ts，缝 A（books.jsonl 自愈 repairBooks 族）→
 * books-repair.ts；残核 = books.jsonl 登记读写 + 锁 + 活动书指针 +
 * 书名校验（BOOK_NAME_* / isInvalidBookName）。两新模块的既有导出经文件尾逐名
 * re-export 桥接，全库 import 面不动；零行为变化。
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, dirname, isAbsolute } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { samePhysicalPath } from '../fs/user-data-path.js' // R42-35/R44-11：登记目录占用判重（dev+ino 物理身份，stat 失败回退 samePath）
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { errMsg, log } from '../log/index.js' // errMsg 收编（复审-0914-优化修复批）：错误文案三目单源
import { testableConst } from '../shared/testable.js'

// ── books.jsonl 登记格式（#32 第 2 节）──────────────

export interface BookEntry {
  name: string
  /** 书仓库目录，相对工作目录（移动检测用） */
  path: string
  kind: 'long' | 'short'
  created_at?: string
  /** 未知字段容错保留 */
  [key: string]: unknown
}

const BOOKS_FILE = '.clwriting/books.jsonl'
const ACTIVE_FILE = '.clwriting/active'
// R0916-5e（拆分波1）：导出供同域拆出模块消费——books-resolve.ts findWorkDir 上溯
// 判存用；字面量单源，不随拆分复制
export const CLWRITING_DIR = '.clwriting'
// R0916-5e（拆分波1）：导出供同域拆出模块消费——books-repair.ts scanBookCandidates
// 扫长篇/短篇二级分组用；字面量单源，不随拆分复制
export const KIND_DIRS = {
  long: '长篇',
  short: '短篇',
} as const

/** 书库二级目录名：一级书库 / 二级长短篇 / 三级具体书。 */
function bookKindDir(kind: 'long' | 'short'): string {
  return KIND_DIRS[kind]
}

/** 新建书默认登记路径（相对工作目录）。旧 books.jsonl 平铺 path 仍兼容读取。 */
export function bookStoragePath(bookName: string, kind: 'long' | 'short'): string {
  return `${bookKindDir(kind)}/${bookName}`
}

/** R74-11（七十四轮批 D）：书名 UTF-8 字节上限。书名直接作书目录名，完整路径 =
 *  <书库根>/长篇|短篇/<书名>/<书内最深后代>，win MAX_PATH 260 单位封顶下预算：
 *  盘符+用户目录+书库根 ≈30 + 分隔/长篇层级 ≈3 + 书内最深 scaffold 后代
 *  写作/正文/第一卷/0001-<60 码位标题>.md ≈76 + 原子写 tmp 后缀
 *  （.<pid>.<uuid>.tmp）≈48 → 书名至多约 100 单位。取 120 字节（≈40 个汉字，占
 *  40 单位）留足余量，且与 filename.ts 的 sanitizeChapterTitle 120 字节上限同值
 *  （库内既有封顶口径）。超限名 mkdir 时 ENAMETOOLONG 裸抛（win 上 MAX_PATH 直拒），
 *  入口统一先行拒绝。 */
export const BOOK_NAME_MAX_BYTES = 120

/**
 * 书名非法的面向用户拒绝文案单源（复审-0913-mac适配 P3-6）：isInvalidBookName 各
 * 消费点（doInit 逻辑层 / server 建书与改名）共用，含 win 非法字符全集与跨平台
 * 原因披露。行为面维持跨平台硬拒不变（数据面对称系有意设计，见 isInvalidBookName
 * 内注）——仅文案向作者说明「为何 mac 上也拦 win 字符」。
 */
export const BOOK_NAME_INVALID_REASON =
  '书名不能包含 \\ / : * ? " < > | 等字符，也不能是 . 或 ..（书名需兼容 Windows/macOS 双平台书库互拷，故统一限制）'

/**
 * 书名合法性（P2-27：跨 server 建书 + doInit 逻辑层共用单一真相源）。
 * 书名直接用作目录名——禁空、NUL、路径分隔符、特殊路径段（. / ..），
 * 防 `../` 经 join 后越出 workDir（此前防线只在 server 层，逻辑层新调用方会重踩）。
 */
export function isInvalidBookName(name: string): boolean {
  // win 非法字符集（win 适配批 2，2026-08-27）：书名直接作目录名，任意非法字符
  // 在 win 上 mkdir 失败/吞字；跨平台统一拒绝（mac 也拦住，行为一致更简单）
  if (name === '' || name.includes('\0') || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return true
  // R74-11（七十四轮批 D）：UTF-8 字节封顶（推导见 BOOK_NAME_MAX_BYTES 头注）——
  // 单源防御：server 建书/改名与 doInit 共用本判据，超长名不再漏到 mkdir 才炸
  if (Buffer.byteLength(name, 'utf8') > BOOK_NAME_MAX_BYTES) return true
  // Z-22（第五十八轮）：Windows 保留设备名（CON/NUL/COM1-9/LPT1-9 等）——win 上
  // mkdir 对这些名字直接失败，提前以人话校验拒绝（mac 不受影响，为阶段 21 预铺）；
  // 尾点/尾空格同拒（win 落盘时被剥引发读写名不一致）。
  // R1W-5（win 平台专项复审 R1）：保留名判定改取首段（对齐 format/filename.ts
  // winCompatNamePart 的 split('.')[0] 口径）——「CON.md」「aux.txt」与裸名同为
  // win 保留设备名（CreateDirectoryW 报 ERROR_INVALID_NAME），此前只剥尾点/尾空格
  // 放行了带扩展名形态。CLOCK$ 随单一真相源补齐。
  const bare = name
    .replace(/\.+$/, '')
    .replace(/\s+$/, '')
    .split('.')[0]!
    .toUpperCase()
  if (/^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/.test(bare)) return true
  return /[.\s]$/.test(name)
}

// ── R46-11（四十六轮）：books.jsonl 解析结果的 (mtimeNs,size) 指纹缓存 ──────────
// 动机：resolveBook 是全部书键端点的统一入口（studio/server 面 70+ 处调用点），每请求
// 经 readBooks → readBooksStrict 对同一 books.jsonl readFileSync 整读 + 逐行
// JSON.parse——服务进程高峰期同一文件每秒重复解析数十次。指纹缓存（R46-10 名册缓存
// 同款范式）：stat (mtimeNs,size) 命中直接回缓存解析结果，命中只付 1 次 statSync，
// 精度 mtimeNs 无陈旧窗口；键含 books.jsonl 绝对路径；FIFO 上限 16（工作目录数常态
// 个位数）。写侧失效收口在 writeBooks 开头（append/remove/repair/改名端点全部经它
// 落盘）——就地先失效保证即便后续物理写抛出，也不留被调用方 mutated 过的缓存数组。
// 缺文件/读失败不缓存失败值（各按原口径返回，下次照常重试）。
const BOOKS_READ_CACHE_MAX = 16
const booksReadCache = new Map<string, { mtimeNs: bigint; size: bigint; books: BookEntry[] }>()

/** 读 books.jsonl。写路径专用口径：缺文件 → 空表（新建合法）；读失败（EACCES/
 *  EISDIR 等）→ null——DA-3（第七轮）：写方据此拒绝重写，防「降级空表 × 后续整写」
 *  把其余登记清掉（EACCES 挡 readFileSync 不挡 atomicWriteFile 的 tmp+rename）。
 *  读路径容错请用 readBooks（失败降级空表，书架/resolveBook 不裸抛）。 */
export function readBooksStrict(workDir: string): BookEntry[] | null {
  // R46-11：缓存键含绝对路径（不同形态的 workDir 字符串指向同一文件时同键复用）
  const fp = resolve(workDir, BOOKS_FILE)
  // R46-11：原 existsSync 判存合并进指纹 stat——一次调用同时承担「缺文件 → 空表」
  // 判定与缓存指纹采集；stat 成功但文件是目录时走下方 readFileSync EISDIR → null
  // 原路径不变。
  // R0912-3（重评-0912 P3 #33）：stat 失败按 errno 分诊——仅 ENOENT 归空表（首启
  // 语义，缺文件 = 新建合法）；EACCES/EIO/ENOTDIR 等其余失败归 null，与下方
  // readFileSync 失败同走 DA-3 拒写防线（此前一律归空表，降级空表 × 后续整写会把
  // 其余登记清掉，恰好绕过 DA-3；repairBooks 扫盘可重建兜底故评 P3）。
  let mtimeNs: bigint
  let size: bigint
  try {
    const st = statSync(fp, { bigint: true })
    mtimeNs = st.mtimeNs
    size = st.size
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null
    // R0912-3-WIN（#33 平台补）：win 对「路径中间组件是普通文件」的 stat/readFileSync
    // 均返 ENOENT（POSIX 归 ENOTDIR）——只认 errno 会把 `.clwriting` 被损坏成文件的
    // 状态误判成首启缺文件而回空表，恰好绕过 DA-3 拒写面。故 ENOENT 分支再复核父目录
    // 真身：存在且非目录 → null（损坏态，与 POSIX 同归拒写）；父链本身缺失（真首启，
    // 含 workDir 未建）才归空表。
    try {
      if (!statSync(dirname(fp)).isDirectory()) return null
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    return []
  }
  // R46-11：同指纹直接回缓存解析结果。
  // R0912（重评-0911c P3）：命中返回浅拷贝——缓存数组本体不出缓存。原「共享数组
  // 无旁路污染」的承诺不成立（appendBookLocked 曾对命中数组就地 push，跨 await 持
  // 同一引用的读方会看到突增条目）；边界处一次 slice 消灭整类就地 mutate 面，
  // 代价可忽略（条目数 = 书数个位数）。
  const hit = booksReadCache.get(fp)
  if (hit && hit.mtimeNs === mtimeNs && hit.size === size) return hit.books.slice()
  let text: string
  try {
    text = readFileSync(fp, 'utf-8')
  } catch {
    return null
  }
  // R40-25（四十轮）：剥 BOM 前缀——win 记事本「UTF-8 with BOM」保存后首行变
  // `\uFEFF{"name":…}`，JSON.parse 首条即抛 → 该书静默从书架消失（catch continue
  // 吞掉，无痕）。剥后首条正常解析；无 BOM 文件首字符不受影响（replace 无命中）
  const books: BookEntry[] = []
  const lines = text.replace(/^\uFEFF/, '').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof obj['name'] === 'string' && typeof obj['path'] === 'string') {
        // 路径安全：拒绝对路径与父级穿越段（防 books.jsonl 篡改后 join(workDir,path) 越出 workDir，
        // DELETE 端点 rmSync recursive 可递归删除外部目录 —— NP0-B）
        const relPath = obj['path']
        // P2-SEC-2：补 NUL 字节检查（与 safeManifestPath 一致——NUL 可截断后续路径拼接）
        if (!relPath || relPath.includes('\0') || isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) continue
        // P1-2：拒绝 "." / "" / "./" 等 resolve 后指向 workDir 自身的路径
        // （join(workDir,".")=workDir → DELETE rmSync recursive 删整个书库）
        if (resolve(workDir, relPath) === resolve(workDir)) continue
        const entry = {
          ...obj,
          name: obj['name'],
          path: obj['path'],
          kind: obj['kind'] === 'short' ? 'short' : 'long',
        } as BookEntry
        if (typeof obj['created_at'] === 'string') {
          entry.created_at = obj['created_at']
        } else {
          delete entry.created_at
        }
        books.push(entry)
      }
    } catch {
      // 坏行跳过（容错，不崩）
    }
  }
  // R46-11：仅成功解析入缓存（缺文件/读失败不缓存失败值）；FIFO 淘汰最旧键
  if (booksReadCache.size >= BOOKS_READ_CACHE_MAX) {
    const oldest = booksReadCache.keys().next().value
    if (oldest !== undefined) booksReadCache.delete(oldest)
  }
  booksReadCache.set(fp, { mtimeNs, size, books })
  // R0912：同上——缓存本体不出缓存，返回浅拷贝
  return books.slice()
}

/** 读 books.jsonl（容错：缺文件/读失败均返回空；坏行跳过不崩——读路径降级口径）。
 */
export function readBooks(workDir: string): BookEntry[] {
  return readBooksStrict(workDir) ?? []
}

/** 全量写 books.jsonl（一行一书）。物理写（无锁）——跨进程互斥由上层 mutator
 *  持 books.lock（R63-2）后调用；直接调用方需自证单写者。 */
export function writeBooks(workDir: string, books: BookEntry[]): void {
  // R46-11：解析缓存写前失效——append/remove/repair/改名端点的 books.jsonl 写全部
  // 经本函数落盘，单点失效即全覆盖；放开头保证 mkdir/物理写若抛出不留已失效缓存
  booksReadCache.delete(resolve(workDir, BOOKS_FILE))
  mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
  const fp = join(workDir, BOOKS_FILE)
  const lines = books.map((b) => JSON.stringify(b)).join('\n')
  atomicWriteFile(fp, lines + (lines ? '\n' : ''))
}

/** R63-2（十一轮）：books.jsonl 锁等待超时（毫秒）——可注入缩短保测试快；
 *  争用为文件 IO 级毫秒，5s 已极保守（对齐 ai-calls J7 的 AI_CALLS_LOCK_TIMEOUT_MS）。
 *  R32-19（三十二轮）：`export let` 违反全仓 const+ForTest 注入口径改 const 导出 +
 *  内部可变生效值（import 方静默改写会绕过注入钩子）；R32-18 口径：本族同步锁窄面
 *  登记维持——mutator 族（append/remove/repair/rename）26 处调用跨 CLI/桌面/测试三面，
 *  异步化级联不成比例，争用本身是毫秒级文件 IO（Atomics.wait 最坏停 5s 仅双进程
 *  争写同一 books.jsonl 窗口），与 journal/manifest 已登记口径同族。
 *  残留清偿批（三十四轮）登记收窄：服务事件循环面**归零**——端点内嵌 RMW（改名流
 *  与删书 removeBookEntryAsync）全走 tryBooksLockAsync；
 *  R36-9/R36-26（三十六轮）：建书面收口——GUI 建书端点（POST /api/books →
 *  doInitAsync）与 CLI 建书（appendBookAsync）均走异步孪生，原「同步版余面 = CLI
 *  init（appendBook）…均不在请求处理窗口内」登记失实（GUI 建书正是请求窗口内
 *  消费 appendBook 的漏网点）；同步版余面 = 启动段 pre-listen（repairBooks，见
 *  server/index.ts 登记注）/ 测试，均不在请求处理窗口内。 */
export const BOOKS_LOCK_TIMEOUT_MS = 5_000

/** 三件套换装 testableConst 工厂：生效值 getter（消费点显式调用）+ 测试注入 setter 元组第二位（原名原签名，测试面零感知）。 */
export const [getBooksLockTimeoutMs, __setBooksLockTimeoutForTest] = testableConst(BOOKS_LOCK_TIMEOUT_MS)

/**
 * R63-2（十一轮）：books.jsonl 读改写段的跨进程互斥——锁文件 .clwriting/books.lock
 * （fs/cross-process-lock.ts：O_EXCL + pid 存活探测 + 崩溃接管，J7 同款）。此前四个
 * 写点（append/remove/repair/rename 端点）只靠进程内同步段天然原子，CLI 与桌面双进程
 * 并发读改写会交错覆盖丢登记（repairBooks 扫盘可重建兜底，但期间书架丢书/误 missing）。
 * 进程内无需额外串行化：本模块写段全同步，Node 单线程内不交叉。
 * 返回 null = 超时——调用方按 DA-3 口径降级（append 拒改写返回 ok:false、remove 跳过
 * 留痕、repair 跳过本轮、rename 端点跳过整写留痕），不裸抛。
 * 同进程嵌套获取同一锁会自锁（见 cross-process-lock 模块头注）——doWrite 段内不得
 * 再调本函数或其它持锁写点。
 */
export function tryBooksLock(workDir: string): (() => void) | null {
  // R44-18（四十四轮）：获取段整段收编——首行 mkdirSync（.clwriting 建不出：EACCES/
  // 只读卷/磁盘满）与 acquire 内部非冲突类故障（open 'wx' 权限错等上抛形态）此前裸穿，
  // 而全部调用方的 null 检查只预期「超时拿不到锁」一种失败语义（append 拒改写、
  // remove/repair 跳过留痕——都是「失败不裸抛」收口），throw 直接炸穿。收编为获取
  // 锁失败语义（返回 null，公共签名/降级口径不变），EACCES 类留 warn 供诊断。
  try {
    mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
    return acquireCrossProcessLockWithTimeout(join(workDir, CLWRITING_DIR, 'books.lock'), getBooksLockTimeoutMs())
  } catch (e) {
    log.warn('books', `books.jsonl 登记锁获取失败（${e instanceof Error ? e.message : String(e)}），本轮跳过改写`)
    return null
  }
}

/** R34D-19（三十四轮）：tryBooksLock 的异步孪生——锁等待走 acquireCrossProcessLockAsync
 *  （setTimeout 轮询，事件循环不阻塞），锁文件/超时/降级语义与同步版逐位同源。
 *  服务进程事件循环上的**端点内嵌 RMW 面**专用：改名端点登记段（books.ts）、
 *  删书 removeBookEntryAsync，以及 R36-9/R36-26 收口的建书面（appendBookAsync /
 *  doInitAsync，GUI 端点与 CLI 建书共用）；mutator 族余下同步版（remove/repair/
 *  rename 等 CLI/桌面/测试面）维持不动（上方登记口径）。 */
export async function tryBooksLockAsync(workDir: string): Promise<(() => void) | null> {
  // R44-18（四十四轮）：同 tryBooksLock 的获取段收编（异步孪生同步堵）——mkdirSync
  // 可抛面与调用方 null 降级口径同源（GUI 建书/删书/改名端点都在请求事件循环上）
  try {
    mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
    return await acquireCrossProcessLockAsync(join(workDir, CLWRITING_DIR, 'books.lock'), getBooksLockTimeoutMs())
  } catch (e) {
    log.warn('books', `books.jsonl 登记锁获取失败（${e instanceof Error ? e.message : String(e)}），本轮跳过改写`)
    return null
  }
}

/** 追加一本书到 books.jsonl（同名/目录占用则报冲突）。
 *  0918二轮修复批（G104）：active 指针随登记在**同一 books.lock 临界段**内写——
 *  此前 appendBook 只登记、writeActive 由调用方（doInit/doInitAsync）在锁外裸写，
 *  双进程并发建书时两个「登记→切指针」段交错，active 被先释放锁的一方事后覆盖
 *  （最后写者胜，指针指向非最后完成的书）。生产调用面（doInit/doInitAsync 两孪生）
 *  全部是「建书即切活动书」语义（grep 核实无「只登记不切 active」调用点），故
 *  无条件写入不加选项参数。active 写失败按 R44-18 口径报「已建成并登记成功，但
 *  设置当前活动书失败」（登记在盘，从书架手动启用即可）。 */
export function appendBook(
  workDir: string,
  entry: BookEntry,
): { ok: true } | { ok: false; reason: string } {
  // R63-2：读改写整段进跨进程锁——CLI 与桌面并发建书不交错覆盖丢登记
  // R36-9/R36-26：GUI 建书端点与 CLI 建书统一走下方异步孪生 appendBookAsync
  //（本同步版保留供 CLI 残余/测试合法同步面，R32-18 窄面登记口径）
  const release = tryBooksLock(workDir)
  if (!release) {
    return { ok: false, reason: '书库登记锁获取超时（另一进程正在改写 books.jsonl），本轮不建书——请稍后重试' }
  }
  try {
    return appendBookLocked(workDir, entry)
  } finally {
    release()
  }
}

/**
 * appendBook 的异步孪生（R36-9/R36-26，三十六轮）——建书锁等待走 tryBooksLockAsync
 * （acquireCrossProcessLockAsync：setTimeout 轮询，事件循环不阻塞）。同步版
 * tryBooksLock 的 Atomics.wait 在双进程争写窗口最坏停 5s；GUI 建书端点（/api/books
 * POST → doInitAsync）承载 SSE/全部接口，此前经 doInit → appendBook 在请求事件
 * 循环上同步睡（R36-26 指出的 CLI 建书同根漏网：install/books.ts 注释登记「余面
 * 均不在请求窗口」与 GUI 建书事实矛盾）。锁文件/超时档/超时降级/DA-3 读失败拒
 * 重写语义与同步版逐位对齐。
 */
export async function appendBookAsync(
  workDir: string,
  entry: BookEntry,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const release = await tryBooksLockAsync(workDir)
  if (!release) {
    return { ok: false, reason: '书库登记锁获取超时（另一进程正在改写 books.jsonl），本轮不建书——请稍后重试' }
  }
  try {
    return appendBookLocked(workDir, entry)
  } finally {
    release()
  }
}

/** 持锁后的追加主体（R63-2 拆出——同步/异步获取者共用，结果语义单源）。
 *  0918二轮修复批（G104）：登记写 + active 指针写合为本持锁段内的两步原子面
 *  （writeActive 此前在调用方锁外裸写，见 appendBook 头注）。 */
function appendBookLocked(workDir: string, entry: BookEntry): { ok: true } | { ok: false; reason: string } {
  // DA-3（第七轮）：读失败（null）拒绝重写——降级空表会让 writeBooks 只写进新书一行，
  // 其余登记全被清掉（repairBooks 扫盘可重建兜底，但期间书架丢书）
  const books = readBooksStrict(workDir)
  if (books === null) {
    return { ok: false, reason: 'books.jsonl 读取失败（权限或磁盘故障），已拒绝改写以防清空书库登记——请修复后重试' }
  }
  if (books.some((b) => b.name === entry.name)) {
    return { ok: false, reason: `已有一本叫「${entry.name}」的书，换个名字或先删掉旧的` }
  }
  // R42-35（四十二轮）：登记名判重外补目录占用判重——大小写不敏感卷（win）上 Foo/foo
  // 两个名字 join 后指向同一书目录，仅名字判重会放行成「双登记同库」形态（书架两张卡
  // 互踩、删一张殃及另一张的登记面）。
  // R44-11（四十四轮）：占用判重从纯字符串 samePath 升级为 dev+ino 物理身份判定
  //（R71-8 同款，win 侧孪生漏修收编）——mac 默认 APFS（大小写不敏感）上字符串口径
  // posix 全等看不见《Foo》/《foo》同物理目录形态；dev+ino 不同即放行，天然不误伤
  // 大小写敏感卷上的合法异名库；stat 任一失败回退 R42-35 的 samePath 字符串口径。
  // 文案点名占用书，与既有冲突同义。
  const occupying = books.find((b) => samePhysicalPath(join(workDir, b.path), join(workDir, entry.path)))
  if (occupying) {
    return { ok: false, reason: `已有一本叫「${occupying.name}」的书占用了目录「${entry.path}」（大小写不敏感的卷上仅大小写不同的书名视为同库），换个名字或先删掉旧的` }
  }
  // R0912（重评-0911c P3）：
  // a) 拷贝后追加——books 为缓存边界浅拷贝（readBooksStrict R0912 slice 纪律），
  //    以新数组形态交写侧，不与任何共享引用纠缠。
  // b) 写段 try/catch——init.ts 契约「appendBook*/doInit* 永不 reject」此前对写段
  //    失效（writeBooks → mkdirSync/atomicWriteFile 在 EACCES/ENOSPC 时抛出直穿，
  //    GUI 建书端点得 500 而非人话 reason）；锁超时/读失败两条已契约化，唯写漏。
  const next = [...books, entry]
  try {
    writeBooks(workDir, next)
  } catch (e) {
    // 0918二轮修复批（G104）顺手收编：错误文案三目改 errMsg 单源（复审-0914 口径）
    return { ok: false, reason: `books.jsonl 写入失败（权限或磁盘故障），登记未落盘——请检查磁盘空间/权限后重试：${errMsg(e)}` }
  }
  // 0918二轮修复批（G104）：active 指针写收进本临界段（此前由 doInit/doInitAsync
  // 在锁外调 writeActive——双进程并发建书最后写者胜）。失败语义沿 R44-18
  // writeActiveGuarded 原口径（该包装随收编拆除，文案单源迁此）：登记已落盘，
  // 按「登记在、active 未写」给可行动 reason，防作者重试撞「已有一本叫…」误导。
  try {
    writeActive(workDir, entry.name)
  } catch (e) {
    return {
      ok: false,
      reason: `书「${entry.name}」已建成并登记成功，但设置当前活动书失败（${errMsg(e)}）——书已在书架中，从书架启用该书即可，无需重建（重跑同名建书会提示已存在）`,
    }
  }
  return { ok: true }
}

/**
 * 从 books.jsonl 移除一本书的登记（不改文件系统）。
 * 如果删的是活动书，清 active 指针（防野指针）。找不到则 no-op。
 * 残留清偿批（三十四轮）：生产调用面已迁下方异步孪生 removeBookEntryAsync（删书
 * 端点）；本同步版保留供 CLI/测试合法同步面（R32-18 窄面登记收口）。
 */
export function removeBookEntry(workDir: string, name: string): void {
  // R63-2：读改写整段进跨进程锁；超时跳过留痕（与读失败同口径——登记留盘由启动
  // repairBooks 报告 missing，但不自动清除（R35-28 如实口径），文件系统侧删除照常进行）
  const release = tryBooksLock(workDir)
  if (!release) {
    log.warn('books', `books.jsonl 登记锁获取超时，跳过移除「${name}」登记（登记留盘，成为幽灵条目需人工清理）`)
    return
  }
  try {
    removeBookEntryLocked(workDir, name) // F6（复审-0914-优化修复批）：持锁主体单源
  } finally {
    release()
  }
}

/**
 * removeBookEntry 的异步孪生（残留清偿批·三十四轮）——删书端点在承载 SSE/全部接口
 * 的服务进程事件循环上直调同步版，其 tryBooksLock 的 Atomics.wait 等待（双进程争用
 * 窗最坏 5s）是 R32-18 mutator 族登记残留的最后一个服务面落点。锁等待走
 * acquireCrossProcessLockAsync（setTimeout 轮询），锁文件/超时档/超时跳过留痕/
 * DA-3 读失败拒重写语义与同步版逐位对齐。
 */
export async function removeBookEntryAsync(workDir: string, name: string): Promise<void> {
  const release = await tryBooksLockAsync(workDir)
  if (!release) {
    log.warn('books', `books.jsonl 登记锁获取超时，跳过移除「${name}」登记（登记留盘，成为幽灵条目需人工清理）`)
    return
  }
  try {
    removeBookEntryLocked(workDir, name) // F6：持锁主体与同步版单源（appendBookLocked 先例）
  } finally {
    release()
  }
}

/** 持锁后的移除主体（F6 复审-0914-优化修复批拆出——sync/async 孪生此前整段复制，
 *  照 appendBookLocked（R63-2 拆出）先例收编单源，语义逐位不变）。 */
function removeBookEntryLocked(workDir: string, name: string): void {
  // DA-3（第七轮）：读失败拒绝重写——降级空表会让 writeBooks 清掉其余登记；
  // 登记留在盘上成为幽灵条目（repairBooks 只报告 missing 不清除，R35-28），文件系统侧删除照常进行
  const books = readBooksStrict(workDir)
  if (books === null) return
  // R0912-3（重评-0912 P3 #37）：写段 try/catch 对齐 appendBookLocked 收编形态——
  // writeBooks/active 清指针在 EACCES/ENOSPC 时抛出此前直穿（上游删书端点已兜，
  // CLI/测试同步面无契约），失败按锁超时同款跳过留痕：登记留盘成幽灵条目，由
  // 启动 repairBooks 报告，文件系统侧删除不受影响
  try {
    writeBooks(workDir, books.filter((b) => b.name !== name))
    // 活动书被删 → 清指针（下次进书架会提示选书）
    if (readActive(workDir) === name) {
      atomicWriteFile(join(workDir, ACTIVE_FILE), '')
    }
  } catch (e) {
    log.warn('books', `books.jsonl 登记写入失败（权限或磁盘故障），跳过移除「${name}」登记（登记留盘，成为幽灵条目需人工清理）：${errMsg(e)}`)
  }
}

// ── 活动书指针（#32 第 3 节）──────────────────────

/** 读活动书 name（.clwriting/active 单行）。缺失返回 null。 */
export function readActive(workDir: string): string | null {
  const fp = join(workDir, ACTIVE_FILE)
  if (!existsSync(fp)) return null
  let name: string
  try {
    name = readFileSync(fp, 'utf-8')
  } catch {
    // 低级项（第六轮）：读取失败（EACCES/EISDIR 等）不裸抛——降级为未选书（null）
    return null
  }
  name = name.trim()
  return name === '' ? null : name
}

/** 写活动书 name（单文件，换书只改它）。原子写防并发/崩溃致半截文件。 */
export function writeActive(workDir: string, name: string): void {
  mkdirSync(join(workDir, CLWRITING_DIR), { recursive: true })
  atomicWriteFile(join(workDir, ACTIVE_FILE), name + '\n')
}

// ── R0916-5e（2026-09-16，⑤④产品拆分波1）缝 B 拆出桥接 ──
// 工作目录定位（findWorkDir）/ 书仓库判定（isBookRepo）纯移动至 books-resolve.ts
// （注释随代码走）；逐名 re-export 保住既有导出面，消费方 import 不动。
export { findWorkDir, isBookRepo } from './books-resolve.js'

// ── R0916-5e（2026-09-16，⑤④产品拆分波1）缝 A 拆出桥接 ──
// books.jsonl 自愈族（RepairResult/repairBooks/isDirConfirmedMissing/repairBooksLocked/
// scanBookCandidates/detectBookName/detectBookKind/detectBookCreatedAt）纯移动至
// books-repair.ts（注释随代码走）；逐名 re-export 保住既有导出面，消费方 import 不动。
export { repairBooks, type RepairResult } from './books-repair.js'
