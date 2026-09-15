/**
 * 文档服务守卫与锁档常量 —— R0916-5e（2026-09-16，⑤④产品巨件拆分波1）自
 * service.ts 缝 A 拆出（纯移动，零行为变化）。
 *
 * 内容：非 UTF-8 拒绝守卫（isUtf8Bytes + NON_UTF8_REJECT / NON_UTF8_SAVE_REJECT）与
 * 四组跨进程锁等待档（META / STRUCT / WIRING / SAVE——常量 + testableConst 生效值
 * getter / 注入钩子）。原 service.ts 导出项仍由 service.ts 逐名 re-export 桥接
 * （全库消费方 import 面不变）；原模块私有项（NON_UTF8_*、saveLockTimeoutMs）迁入后
 * 加 export 供 service.ts 内部 import，不对外新增导出面。
 */
import { testableConst } from '../shared/testable.js'

/** 第五轮：非 UTF-8（GBK 等）文件的元数据写回统一拒绝——utf-8 读入产生 U+FFFD 替换
 *  符，元数据路径会把乱码正文原子覆盖回原文件（原始字节永久丢失，且无快照留底，
 *  用户没碰正文却被「盲改」）。检出即拒，先转码再改。 */
export const NON_UTF8_REJECT = {
  ok: false as const,
  code: 'WRITE_ERROR' as const,
  reason: '检测到非 UTF-8 编码（正文含 U+FFFD 替换字符）：为防写回损坏原文，请先将该文件转为 UTF-8 再修改元数据',
}

/** M-5（第六轮）：save 主路径同款防线（含 autosave）——编辑器打开 GBK 文件显示乱码后
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
  reason: '目标文件不是合法 UTF-8（可能是编辑器以错误编码打开本文件，或外部工具写入了 GBK 等编码）：为防原始内容被乱码覆盖后不可恢复，已拒绝保存——请先将文件转为 UTF-8 再编辑',
}

/** R76-1（二十四轮）：元数据 PATCH 双路径（updateChapterMeta/updateDocMeta）的跨进程
 *  保存锁等待（毫秒）——与 executeSave 的 5s 同档；测试注入缩短保快（生产零调用），
 *  同 draft-pipeline DRAFT_SAVE_LOCK_TIMEOUT_MS 惯例。
 *  R30-18（三十轮）：常量化——export let 可被任一 import 方静默改写（同 events/store.ts
 *  R26-105 的收口认定），改 const + 内部可变生效值；测试只能经注入钩子改档，生产恒用常量。 */
export const META_SAVE_LOCK_TIMEOUT_MS = 5_000

/** 复审-0914-优化修复批 A4（2026-09-14 修复批）：三件套换装 testableConst——生效值 getter +
 *  注入钩子由工厂单源产出（钩子名/签名不变，测试面零感知；生产消费点改调 getter）。 */
export const [getMetaSaveLockTimeoutMs, __setMetaSaveLockTimeoutForTest] = testableConst(META_SAVE_LOCK_TIMEOUT_MS)

/** R0912-2（2026-09-11 重评-0911c 修复批）：结构性操作（doMoveOrRename/doTrash）落位段
 *  的 per-doc save 锁等待档（毫秒）——与 executeSave 的 5s 同档；测试注入缩短保快
 *  （生产零调用），同 META_SAVE_LOCK_TIMEOUT_MS 惯例。
 *  A4 换装（同 META 注）：档位常量为本模块私有（无导出消费方），def 值就地字面化。 */
export const [getStructSaveLockTimeoutMs, __setStructSaveLockTimeoutForTest] = testableConst(5_000)

/** R29-7（二十九轮）：布线文件写路径的第二道跨进程锁（`<布线文件绝对路径>.lock`，
 *  与 lead-finalize.ts applyLeadUpdates 同名锁）等待档（毫秒）——与 save 锁的 5s
 *  同档（测试注入缩短保快，生产零调用）。
 *  R30-18（三十轮）：常量化——同 META_SAVE_LOCK_TIMEOUT_MS 的收口口径。 */
export const WIRING_SAVE_LOCK_TIMEOUT_MS = 5_000

/** A4 换装（同 META 注）。 */
export const [getWiringSaveLockTimeoutMs, __setWiringSaveLockTimeoutForTest] = testableConst(WIRING_SAVE_LOCK_TIMEOUT_MS)

/** 复审-0913-源码 P3-③：executeSave 主体保存锁（`<journalPath>.save.lock`）等待档
 *  （毫秒）——原裸写 5_000 与 META/STRUCT/WIRING 三档惯例脱钩（R30-18 收口口径漏网
 *  单点）；测试注入缩短保快（生产零调用），同 META_SAVE_LOCK_TIMEOUT_MS 惯例。 */
export const SAVE_LOCK_TIMEOUT_MS = 5_000

/** 生效值（模块内可变）：初值 = 常量；测试如需注入走模块内替换（复审-0914-优化修复批
 *  B4：原 __setSaveLockTimeoutForTest 钩子全库零调用方，2026-09-14 修复批删）。
 *  本批注：钩子删后本值再无改写通道（恒等常量），随 eslint prefer-const 降 const。 */
export const saveLockTimeoutMs = SAVE_LOCK_TIMEOUT_MS
