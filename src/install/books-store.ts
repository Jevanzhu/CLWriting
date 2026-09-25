/**
 * books.jsonl 登记存储层（常量 + 解析缓存 + 读写 + 跨进程锁）—— R0916-7-P3-3
 * （2026-09-16 评审修复批）自 install/books.ts 下沉的中立模块。
 *
 * 起因：本层原居 install/books.ts，而同域拆分出的 books-repair.ts / books-resolve.ts
 * 又要回引它（repair 需 readBooksStrict/writeBooks/tryBooksLock/KIND_DIRS，resolve 需
 * CLWRITING_DIR），books.ts 尾部的 re-export 桥又把 repair/resolve 引回来——三文件互引
 * 成环（books ↔ books-repair ↔ books-resolve）。存储层下沉后依赖单向化：
 * books-resolve / books-repair / books.ts 各自向下引本模块，本模块不引同域任何文件。
 *
 * 边界：这里只放「登记文件的读写与互斥」，不放业务变更（目录占用判重 / active 指针 /
 * 书名校验留 books.ts；自愈扫盘留在 books-repair.ts）。本模块不引 format/ai 等上层。
 */
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
// R30-3（三十轮）：锁等待异步孪生（acquireCrossProcessLockAsync：setTimeout 轮询，
// 事件循环不阻塞）+ 同步版（CLI/测试面）——两形态同源互斥
import { acquireCrossProcessLockWithTimeout, acquireCrossProcessLockAsync } from '../fs/cross-process-lock.js'
import { log } from '../log/index.js'
import { testableConst } from '../shared/testable.js'

/** books.jsonl 登记条目（一行一书） */
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
// R0916-5e（拆分波1）：字面量单源——books-resolve.ts findWorkDir 上溯判存 / books.ts
// writeActive 等消费点共用，不随拆分复制
export const CLWRITING_DIR = '.clwriting'
// R0916-5e（拆分波1）：books-repair.ts scanBookCandidates 扫长篇/短篇二级分组用；
// books.ts bookKindDir 同用（字面量单源）
export const KIND_DIRS = {
  long: '长篇',
  short: '短篇',
} as const

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
