/**
 * 文档服务守卫与锁档常量 —— （⑤④产品巨件拆分波1）自
 * service.ts 缝 A 拆出（纯移动，零行为变化）。
 *
 * 内容：非 UTF-8 拒绝守卫（isUtf8Bytes + NON_UTF8_REJECT / NON_UTF8_SAVE_REJECT）与
 * 四组跨进程锁等待档常量（META / STRUCT / WIRING / SAVE）。起锁档生效值
 * 由 DocContext 持有（per-ctx 组装参数，缺省 = 本文件常量）：META / WIRING / SAVE 的
 * 模块级注入钩子已删，唯 STRUCT 保留（唯一剩余测试消费方经 studio server 内建 service
 * 触达，见其注）。消费方直引本文件（起转发桥已删）；saveLockTimeoutMs
 * 生效值别名随收敛删除（其消费点 service.ts 改读 ctx.saveLockTimeoutMs）。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CLWRITING_DIR, readBooksStrict } from '../install/books.js'
// （件1）：书注册落盘前重验需上溯定位 workDir（DocumentService 只持
// bookRoot）——install/books-resolve 与 install/books 均无 document 侧回边，无环。
import { findWorkDir } from '../install/books-resolve.js'
import { testableConst } from '../shared/testable.js'

/** 非 UTF-8（GBK 等）文件的元数据写回统一拒绝——utf-8 读入产生 U+FFFD 替换
 *  符，元数据路径会把乱码正文原子覆盖回原文件（原始字节永久丢失，且无快照留底，
 *  用户没碰正文却被「盲改」）。检出即拒，先转码再改。 */
export const NON_UTF8_REJECT = {
  ok: false as const,
  code: 'WRITE_ERROR' as const,
  reason: '检测到非 UTF-8 编码（正文含 U+FFFD 替换字符）：为防写回损坏原文，请先将该文件转为 UTF-8 再修改元数据',
}

/** save 主路径同款防线（含 autosave）——编辑器打开 GBK 文件显示乱码后
 *  autosave 存回，乱码正文同样原子覆盖原文件；且设定/大纲等非 chapter 文档无快照
 *  兜底（maybeSnapshot 只留底章文档），一旦覆盖原始字节无版本可恢复。
 *  判据用「盘上字节是否合法 UTF-8」（fatal 解码探测）而非「盘上是否已含 U+FFFD」：
 *  GBK 文件以 utf-8 读入本就产生 U+FFFD，后者会把最该拦的场景判成放行。盘上为合法
 *  UTF-8（含作者真实键入的 � 字符）时不受影响——那是普通编辑，无字节可毁。 */
export function isUtf8Bytes(buf: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

export const NON_UTF8_SAVE_REJECT = {
  ok: false as const,
  code: 'WRITE_ERROR' as const,
  reason:
    '目标文件不是合法 UTF-8（可能是编辑器以错误编码打开本文件，或外部工具写入了 GBK 等编码）：为防原始内容被乱码覆盖后不可恢复，已拒绝保存——请先将文件转为 UTF-8 再编辑',
}

/** 元数据 PATCH 双路径（updateChapterMeta/updateDocMeta）的跨进程
 *  保存锁等待（毫秒）——与 executeSave 的 5s 同档；同 draft-pipeline DRAFT_SAVE_LOCK_TIMEOUT_MS
 *  惯例。
 * 常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 * 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。
 * （组装根注入收敛）：生效值改由 DocContext 持有（per-ctx 注入，缺省 =
 *  本常量），原模块级注入钩子 __setMetaSaveLockTimeoutForTest 删除（消费点只余
 *  service-meta.ts 的 (ctx,…) 函数，测试经 DocContextOptions.metaSaveLockTimeoutMs 注入）。 */
export const META_SAVE_LOCK_TIMEOUT_MS = 5_000

/** 结构性操作（doMoveOrRename/doTrash）落位段
 *  的 per-doc save 锁等待档（毫秒）——与 executeSave 的 5s 同档。
 * 换装（同 META 注）：档位常量为本模块私有（无导出消费方），def 值就地字面化。
 * 本档**保留模块级注入口**（未随 META/WIRING 收敛入 ctx）——消费点虽
 *  全在 (ctx,…) 函数，但其唯一剩余测试消费方 structure-crash.test.ts 经 studio server
 *  组装点内建 service（documents-core.ts getOrCreateService 固定实参构造）触达，
 *  src/studio 为冻结范围、无法从测试侧传 per-instance 档，故保留模块缝 + 如实记档；
 *  解除条件：studio 侧 service 组装开放 options 透传后，随批改 ctx.structSaveLockTimeoutMs
 *  并删本钩子（直调面 struct-save-lock.test.ts 同批改构造注入）。 */
export const [getStructSaveLockTimeoutMs, __setStructSaveLockTimeoutForTest] = testableConst(5_000)

/** 布线文件写路径的第二道跨进程锁（`<布线文件绝对路径>.lock`，
 *  与 lead-finalize.ts applyLeadUpdates 同名锁）等待档（毫秒）——与 save 锁的 5s
 *  同档。
 * 常量化——同 META_SAVE_LOCK_TIMEOUT_MS 的收口口径。
 * （同 META 注）：生效值改由 DocContext 持有，模块级注入钩子删除。 */
export const WIRING_SAVE_LOCK_TIMEOUT_MS = 5_000

/** -源码 -③：executeSave 主体保存锁（`<journalPath>.save.lock`）等待档
 * （毫秒）——原裸写 5_000 与 META/STRUCT/WIRING 三档惯例脱钩（收口口径漏网
 *  单点）。
 * （同 META 注）：生效值改由 DocContext 持有；原 `saveLockTimeoutMs`
 * 生效值别名（起钩子已删、恒等常量）随收敛删除。 */
export const SAVE_LOCK_TIMEOUT_MS = 5_000

// ──（件1）：rename 微任务残窗——书注册落盘前重验（二道防线）────────
// 登记原文「rename 微任务残窗：单元首行重验后微任务窗残留（files.ts 架构同源，
// 彻底闭合 = 重验下沉 DocumentService.executeSave）」。单元首行书注册重验
//（面 A，studio 层 book-context.ts bookMovedFailure 单源）通过到
// executeSave 落盘之间隔着排队/保存锁/清单锁等多个让出点，窗内书被改名/删书（books.ts
// 五连 drain 快照式，重验后新进单元不被等待）时，appendPending/atomicWriteFile 的
// mkdir recursive 会对旧捕获 bookRoot 重建孤儿目录树；且清单随书搬走后 lookupPathByDocId
// 按「未登记」放行新建语义，既有 strict 读防线被旁路——正是本守卫的缺口面。

/** 书注册重验失败人话文案单源——与 studio 层 book-context.ts bookMovedFailure 的
 *  reason 逐字同文（该侧经 409 BOOK_MOVED 信封出，本侧经 SaveResult.code='BOOK_MOVED'
 *  出、structStatus 既有 409 档映射，两端信封逐字节一致）。文案正本落本常量，studio
 *  侧消费随其触达批改引（本批 src/studio/ 冻结不动）。 */
export const BOOK_MOVED_REASON = '书已改名或已删除，本次操作已取消——请重新打开本书后再试'

/** （件1）：落盘前书注册复核——books.jsonl 登记中仍存在解析到 bookRoot
 *  的条目 → null（放行）；否则返回 BOOK_MOVED_REASON（调用方拒绝落盘）。判定口径与
 *  bookMovedFailure 同族（登记解析 ⟂ 捕获书根：登记缺条目 = 该侧 NOT_FOUND 臂），差异
 *  仅在取用形态：本函数只有 bookRoot 可用（DocumentService 不持 workDir/书名），经
 *  findWorkDir 上溯定位登记。放行档（读路径容错口径，首行重验仍是主防线，本守卫只
 *  收窄残窗不改其语义）：无登记语境（.clwriting/books.jsonl 不在盘——测试夹具/裸目录）
 *  与登记读失败（readBooksStrict null——对齐 readBooks 读降级，不因登记瞬态读失败阻断
 *  保存）；登记文件在盘但无匹配条目（含空表 = 末书已删/改签完成态）照 BOOK_MOVED 拒。 */
export function bookMovedGuardFailure(bookRoot: string): string | null {
  const workDir = findWorkDir(bookRoot)
  if (workDir === null) return null
  // books.jsonl 字面量与 install/books.ts BOOKS_FILE（模块私有）同源；此处只判「登记
  // 语境在不在盘」，不动读（读全走 readBooksStrict 单源）。
  const registered = existsSync(join(workDir, CLWRITING_DIR, 'books.jsonl'))
  const books = readBooksStrict(workDir)
  if (books === null) return null
  if (books.length === 0 && !registered) return null
  const rootAbs = resolve(bookRoot)
  return books.some((b) => resolve(join(workDir, b.path)) === rootAbs) ? null : BOOK_MOVED_REASON
}
