/**
 * books.jsonl 登记 + 活动书 —— 依据 #32。
 *
 * – 既有命令从「单书 cwd」走向「工作目录多书」的核心接缝：
 * - books.jsonl 登记有哪些书；.clwriting/active 指当前哪本（指针，换书只改它）
 *
 * （⑤④产品拆分波1）：本文件纯移动拆分——缝 B（工作目录定位/
 * 书仓库判定）→ books-resolve.ts，缝 A（books.jsonl 自愈 repairBooks 族）→
 * books-repair.ts；残核 = books.jsonl 登记读写 + 锁 + 活动书指针 +
 * 书名校验（BOOK_NAME_* / isInvalidBookName）。两新模块的既有导出经文件尾逐名
 * re-export 桥接，全库 import 面不动；零行为变化。
 *
 * （评审修复批）：登记读写 + 锁（BOOKS_FILE/CLWRITING_DIR/
 * KIND_DIRS/BookEntry/readBooksStrict/readBooks/writeBooks/tryBooksLock(Async) 与
 * 超时档）再下沉 books-store.ts（中立模块，不引同域任何文件）——拆分波1 的两处
 * re-export 桥使 books ↔ books-repair ↔ books-resolve 三文件互引成环（repair/resolve
 * 回引本文件取存储原语，本文件再引回二者）。下沉后依赖单向：books-resolve /
 * books-repair / 本文件各自向下引 books-store；本文件仍逐名 re-export 存储层与
 * 两个拆出模块的导出（desktop/document/studio 等消费方 import 面不动）。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { samePhysicalPath } from '../fs/user-data-path.js' // /登记目录占用判重（dev+ino 物理身份，stat 失败回退 samePath）
import { errMsg, log } from '../log/index.js' // errMsg 收编错误文案三目单源
// 存储层（常量 / 解析缓存 / 读写 / 跨进程登记锁）下沉中立模块——
// 同域三个文件（本文件 / books-repair / books-resolve）由此单向向下依赖，环解开
import {
  CLWRITING_DIR,
  KIND_DIRS,
  readBooksStrict,
  tryBooksLock,
  tryBooksLockAsync,
  writeBooks,
  type BookEntry,
} from './books-store.js'

// 活动书指针文件（相对工作目录；随活动书指针残核留本文件——存储层只管 books.jsonl）
const ACTIVE_FILE = '.clwriting/active'

// ── books.jsonl 登记格式（#32 第 2 节）──────────────

/** 书库二级目录名：一级书库 / 二级长短篇 / 三级具体书。 */
function bookKindDir(kind: 'long' | 'short'): string {
  return KIND_DIRS[kind]
}

/** 新建书默认登记路径（相对工作目录）。旧 books.jsonl 平铺 path 仍兼容读取。 */
export function bookStoragePath(bookName: string, kind: 'long' | 'short'): string {
  return `${bookKindDir(kind)}/${bookName}`
}

/** 书名 UTF-8 字节上限。书名直接作书目录名，完整路径 =
 *  <书库根>/长篇|短篇/<书名>/<书内最深后代>，win MAX_PATH 260 单位封顶下预算：
 *  盘符+用户目录+书库根 ≈30 + 分隔/长篇层级 ≈3 + 书内最深 scaffold 后代
 *  写作/正文/第一卷/0001-<60 码位标题>.md ≈76 + 原子写 tmp 后缀
 *  （.<pid>.<uuid>.tmp）≈48 → 书名至多约 100 单位。取 120 字节（≈40 个汉字，占
 *  40 单位）留足余量，且与 filename.ts 的 sanitizeChapterTitle 120 字节上限同值
 *  （库内既有封顶口径）。超限名 mkdir 时 ENAMETOOLONG 裸抛（win 上 MAX_PATH 直拒），
 *  入口统一先行拒绝。 */
export const BOOK_NAME_MAX_BYTES = 120

/**
 * 书名非法的面向用户拒绝文案单源isInvalidBookName 各
 * 消费点（doInit 逻辑层 / server 建书与改名）共用，含 win 非法字符全集与跨平台
 * 原因披露。行为面维持跨平台硬拒不变（数据面对称系有意设计，见 isInvalidBookName
 * 内注）——仅文案向作者说明「为何 mac 上也拦 win 字符」。
 */
export const BOOK_NAME_INVALID_REASON =
  '书名不能包含 \\ / : * ? " < > | 等字符，也不能是 . 或 ..（书名需兼容 Windows/macOS 双平台书库互拷，故统一限制）'

/**
 * 书名合法性（跨 server 建书 + doInit 逻辑层共用单一真相源）。
 * 书名直接用作目录名——禁空、NUL、路径分隔符、特殊路径段（. / ..），
 * 防 `../` 经 join 后越出 workDir（此前防线只在 server 层，逻辑层新调用方会重踩）。
 */
export function isInvalidBookName(name: string): boolean {
  // win 非法字符集（win 适配）：书名直接作目录名，任意非法字符
  // 在 win 上 mkdir 失败/吞字；跨平台统一拒绝（mac 也拦住，行为一致更简单）
  if (name === '' || name.includes('\0') || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') return true
  // UTF-8 字节封顶（推导见 BOOK_NAME_MAX_BYTES 头注）——
  // 单源防御：server 建书/改名与 doInit 共用本判据，超长名不再漏到 mkdir 才炸
  if (Buffer.byteLength(name, 'utf8') > BOOK_NAME_MAX_BYTES) return true
  // Windows 保留设备名（CON/NUL/COM1-9/LPT1-9 等）——win 上
  // mkdir 对这些名字直接失败，提前以人话校验拒绝（mac 不受影响，为阶段 21 预铺）；
  // 尾点/尾空格同拒（win 落盘时被剥引发读写名不一致）。
  // （win 平台专项）：保留名判定改取首段（对齐 format/filename.ts
  // winCompatNamePart 的 split('.')[0] 口径）——「CON.md」「aux.txt」与裸名同为
  // win 保留设备名（CreateDirectoryW 报 ERROR_INVALID_NAME），此前只剥尾点/尾空格
  // 放行了带扩展名形态。CLOCK$ 随单一真相源补齐。
  const bare = name.replace(/\.+$/, '').replace(/\s+$/, '').split('.')[0]!.toUpperCase()
  if (/^(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9])$/.test(bare)) return true
  return /[.\s]$/.test(name)
}

// ── 指纹缓存的读 path / 写 path / books.lock 互斥 ────────────────────
// 解析缓存、读写（readBooksStrict / readBooks / writeBooks）、
// 登记锁（BOOKS_LOCK_TIMEOUT_MS / tryBooksLock / tryBooksLockAsync，
// ）与常量（BOOKS_FILE / CLWRITING_DIR / KIND_DIRS）整体下沉 books-store.ts
// （中立模块）——同域拆出的 books-repair / books-resolve 与本文件由此单向向下依赖。
// 实现与沿革注释随代码走（含 DA-3 拒写 / stat 分诊 / BOM / 浅拷贝
// 纪律），本文件不再持副本。

/** 追加一本书到 books.jsonl（同名/目录占用则报冲突）。
 *  0918二轮修复批（G104）：active 指针随登记在**同一 books.lock 临界段**内写——
 *  此前 appendBook 只登记、writeActive 由调用方（doInit/doInitAsync）在锁外裸写，
 *  双进程并发建书时两个「登记→切指针」段交错，active 被先释放锁的一方事后覆盖
 *  （最后写者胜，指针指向非最后完成的书）。生产调用面（doInit/doInitAsync 两孪生）
 *  全部是「建书即切活动书」语义（grep 核实无「只登记不切 active」调用点），故
 *  无条件写入不加选项参数。active 写失败按口径报「已建成并登记成功，但
 *  设置当前活动书失败」（登记在盘，从书架手动启用即可）。 */
export function appendBook(workDir: string, entry: BookEntry): { ok: true } | { ok: false; reason: string } {
  // 读改写整段进跨进程锁——CLI 与桌面并发建书不交错覆盖丢登记
  // /GUI 建书端点与 CLI 建书统一走下方异步孪生 appendBookAsync
  //（本同步版保留供 CLI 残余/测试合法同步面， 窄面登记口径）
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
 * appendBook 的异步孪生（/，三十六轮）——建书锁等待走 tryBooksLockAsync
 * （acquireCrossProcessLockAsync：setTimeout 轮询，事件循环不阻塞）。同步版
 * tryBooksLock 的 Atomics.wait 在双进程争写窗口最坏停 5s；GUI 建书端点（/api/books
 * POST → doInitAsync）承载 SSE/全部接口，此前经 doInit → appendBook 在请求事件
 * 循环上同步睡（指出的 CLI 建书同根漏网：install/books.ts 注释登记「余面
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

/** 持锁后的追加主体（拆出——同步/异步获取者共用，结果语义单源）。
 *  0918二轮修复批（G104）：登记写 + active 指针写合为本持锁段内的两步原子面
 *  （writeActive 此前在调用方锁外裸写，见 appendBook 头注）。 */
function appendBookLocked(workDir: string, entry: BookEntry): { ok: true } | { ok: false; reason: string } {
  // DA-3读失败（null）拒绝重写——降级空表会让 writeBooks 只写进新书一行，
  // 其余登记全被清掉（repairBooks 扫盘可重建兜底，但期间书架丢书）
  const books = readBooksStrict(workDir)
  if (books === null) {
    return { ok: false, reason: 'books.jsonl 读取失败（权限或磁盘故障），已拒绝改写以防清空书库登记——请修复后重试' }
  }
  if (books.some((b) => b.name === entry.name)) {
    return { ok: false, reason: `已有一本叫「${entry.name}」的书，换个名字或先删掉旧的` }
  }
  // 登记名判重外补目录占用判重——大小写不敏感卷（win）上 Foo/foo
  // 两个名字 join 后指向同一书目录，仅名字判重会放行成「双登记同库」形态（书架两张卡
  // 互踩、删一张殃及另一张的登记面）。
  // 占用判重从纯字符串 samePath 升级为 dev+ino 物理身份判定
  //（同款，win 侧孪生漏修收编）——mac 默认 APFS（大小写不敏感）上字符串口径
  // posix 全等看不见《Foo》/《foo》同物理目录形态；dev+ino 不同即放行，天然不误伤
  // 大小写敏感卷上的合法异名库；stat 任一失败回退的 samePath 字符串口径。
  // 文案点名占用书，与既有冲突同义。
  const occupying = books.find((b) => samePhysicalPath(join(workDir, b.path), join(workDir, entry.path)))
  if (occupying) {
    return {
      ok: false,
      reason: `已有一本叫「${occupying.name}」的书占用了目录「${entry.path}」（大小写不敏感的卷上仅大小写不同的书名视为同库），换个名字或先删掉旧的`,
    }
  }
  // a) 拷贝后追加——books 为缓存边界浅拷贝（readBooksStrict slice 纪律），
  //    以新数组形态交写侧，不与任何共享引用纠缠。
  // b) 写段 try/catch——init.ts 契约「appendBook*/doInit* 永不 reject」此前对写段
  //    失效（writeBooks → mkdirSync/atomicWriteFile 在 EACCES/ENOSPC 时抛出直穿，
  //    GUI 建书端点得 500 而非人话 reason）；锁超时/读失败两条已契约化，唯写漏。
  const next = [...books, entry]
  try {
    writeBooks(workDir, next)
  } catch (e) {
    // 0918二轮修复批（G104）顺手收编：错误文案三目改 errMsg 单源（口径）
    return {
      ok: false,
      reason: `books.jsonl 写入失败（权限或磁盘故障），登记未落盘——请检查磁盘空间/权限后重试：${errMsg(e)}`,
    }
  }
  // 0918二轮修复批（G104）：active 指针写收进本临界段（此前由 doInit/doInitAsync
  // 在锁外调 writeActive——双进程并发建书最后写者胜）。失败语义沿
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
 * 残留清偿批生产调用面已迁下方异步孪生 removeBookEntryAsync（删书
 * 端点）；本同步版保留供 CLI/测试合法同步面（窄面登记收口）。
 */
export function removeBookEntry(workDir: string, name: string): void {
  // 读改写整段进跨进程锁；超时跳过留痕（与读失败同口径——登记留盘由启动
  // repairBooks 报告 missing，但不自动清除（如实口径），文件系统侧删除照常进行）
  const release = tryBooksLock(workDir)
  if (!release) {
    log.warn('books', `books.jsonl 登记锁获取超时，跳过移除「${name}」登记（登记留盘，成为幽灵条目需人工清理）`)
    return
  }
  try {
    removeBookEntryLocked(workDir, name) // 持锁主体单源
  } finally {
    release()
  }
}

/**
 * removeBookEntry 的异步孪生（残留清偿批·三十四轮）——删书端点在承载 SSE/全部接口
 * 的服务进程事件循环上直调同步版，其 tryBooksLock 的 Atomics.wait 等待（双进程争用
 * 窗最坏 5s）是 mutator 族登记残留的最后一个服务面落点。锁等待走
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
    removeBookEntryLocked(workDir, name) // 持锁主体与同步版单源（appendBookLocked 先例）
  } finally {
    release()
  }
}

/** 持锁后的移除主体（——sync/async 孪生此前整段复制，
 *  照 appendBookLocked（拆出）先例收编单源，语义逐位不变）。 */
function removeBookEntryLocked(workDir: string, name: string): void {
  // DA-3读失败拒绝重写——降级空表会让 writeBooks 清掉其余登记；
  // 登记留在盘上成为幽灵条目（repairBooks 只报告 missing 不清除），文件系统侧删除照常进行
  const books = readBooksStrict(workDir)
  if (books === null) return
  // （#37）：写段 try/catch 对齐 appendBookLocked 收编形态——
  // writeBooks/active 清指针在 EACCES/ENOSPC 时抛出此前直穿（上游删书端点已兜，
  // CLI/测试同步面无契约），失败按锁超时同款跳过留痕：登记留盘成幽灵条目，由
  // 启动 repairBooks 报告，文件系统侧删除不受影响
  try {
    writeBooks(
      workDir,
      books.filter((b) => b.name !== name),
    )
    // 活动书被删 → 清指针（下次进书架会提示选书）
    if (readActive(workDir) === name) {
      atomicWriteFile(join(workDir, ACTIVE_FILE), '')
    }
  } catch (e) {
    log.warn(
      'books',
      `books.jsonl 登记写入失败（权限或磁盘故障），跳过移除「${name}」登记（登记留盘，成为幽灵条目需人工清理）：${errMsg(e)}`,
    )
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
    // 低级项读取失败（EACCES/EISDIR 等）不裸抛——降级为未选书（null）
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

// ── 存储层下沉后的导出面桥接 ──
// 存储层（常量 / BookEntry / 读写 / 登记锁与超时档）下沉 books-store.ts 后，本文件
// 逐名 re-export 保住既有导出面（desktop/document/studio 等消费方仍从 install/books.js
// 取这些名字，含 的测试注入钩子）——桥的方向单向向下（本文件 → books-store），
// 不构成环；新增消费方建议直引 books-store.js。
export {
  BOOKS_LOCK_TIMEOUT_MS,
  CLWRITING_DIR,
  KIND_DIRS,
  __setBooksLockTimeoutForTest,
  getBooksLockTimeoutMs,
  readBooks,
  readBooksStrict,
  tryBooksLock,
  tryBooksLockAsync,
  writeBooks,
} from './books-store.js'
export type { BookEntry } from './books-store.js'

// ── （⑤④产品拆分波1）缝 B 拆出桥接 ──
// 工作目录定位（findWorkDir）/ 书仓库判定（isBookRepo）纯移动至 books-resolve.ts
// （注释随代码走）；逐名 re-export 保住既有导出面，消费方 import 不动。
// 两模块已不再回引本文件（改引 books-store），桥自此单向。
export { findWorkDir, isBookRepo } from './books-resolve.js'

// ── （⑤④产品拆分波1）缝 A 拆出桥接 ──
// books.jsonl 自愈族（RepairResult/repairBooks/isDirConfirmedMissing/repairBooksLocked/
// scanBookCandidates/detectBookName/detectBookKind/detectBookCreatedAt）纯移动至
// books-repair.ts（注释随代码走）；逐名 re-export 保住既有导出面，消费方 import 不动。
// 同上，桥自此单向（repair 的存储原语改引 books-store）。
export { repairBooks, type RepairResult } from './books-repair.js'
