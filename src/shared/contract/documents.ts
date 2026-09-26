/**
 * （全库源码质量评审修复批）：回包类型共享契约——文档族。
 *
 * 起因：前端 `web-next/src/api/*.ts` 的回包类型全部手抄，两端靠人肉同步——服务端加字段
 * 前端不报错、只静默缺失（的 gateDegraded 漂移即此形态：服务端已透出、前端类型漏接）。
 *
 * 机制（本文件 = 两端共同引用的那份声明）：
 *   - 前端 api/ 层 `apiJson<契约类型>` 并把类型原样转发（`export type { … }`），调用方
 *     import 面不变；
 *   - 服务端 handler 把回包对象**注解 / `satisfies` 成本契约类型**——对象字面量的多余属性
 *     检查即编译期抓「服务端加字段而契约未同步」（服务端批接线点：reply(res, 200, {…}) 处）；
 *   - 服务端已有权威类型的地方（文档层干跑视图）由本目录 `documents.conformance.ts`
 *     以 type-only 探针钉住逐字段一致——违反即 `npm run typecheck` 红。
 *
 * 为什么本文件零导入、纯类型：`import type` 在 isolatedModules/verbatimModuleSyntax 下
 * 完全擦除，前端打包零体积代价；本文件同时被根 tsc（NodeNext）与 web-next vue-tsc
 * （Bundler）编译，一旦引入跨包相对导入就把服务端整图拉进前端类型程序（实测会连带
 * 编译服务端既有报错），故只放声明。
 *
 * 边界：只放**跨进程边界上的回包形状**（HTTP 响应体字段级约定）。前端自造的展示态
 * 归一化形状（*FE 后缀）与组件 props 不进本目录——它们不跨端，放这里只是换个地方放。
 */

/** revision 指纹形状（服务端 src/document/revision.ts 的 Revision 同口径）。 */
export type Revision = `sha256:${string}`

// ── 读 / 写正文 ─────────────────────────────────────────────────────

/** GET /file 载荷（路径寻址读全文，含编码探测告警）。 */
export interface FileContentPayload {
  content: string
  revision?: Revision
  /** 非 UTF-8 存量文件（GBK/Big5 导入旧稿）——前端据此 toast 告警（在乱码上编辑保存
   *  会被服务端 400 拒绝）。 */
  encodingSuspect?: boolean
  encodingHint?: string
}

/** PUT /documents/:docId/content 成功体（乐观锁保存；409 走 ApiError 错误信封）。 */
export interface SaveOk {
  ok: true
  revision: Revision
  /** 本次保存被更新的 revision 取代（同一会话内后写者胜出） */
  superseded?: boolean
  /** 服务端保存前留底失败（工作区/.版本 不可写）但正文已落盘——留底是兜底不是闸
   *  （fail-open），保存成功；本旗仅降级时带出，doc store 据此每文档提示一次
   *  「版本历史有缺口」。 */
  snapshotDegraded?: boolean
}

// ── 树 CRUD ────────────────────────────────────────────────────────

/** POST /documents 与 POST /documents/:docId/copy 的共用成功体。 */
export interface CreateOk {
  ok: true
  docId: string
  path: string
  revision: Revision
}

/** 回收站条目（id = 原 docId）。 */
export interface TrashEntry {
  id: string
  path: string
  originalPath?: string
  deletedAt?: string
}

// ── 定稿 ───────────────────────────────────────────────────────────

/** POST /documents/:docId/finalize 成功体（revision → final，git commit 锁定版本）。 */
export interface FinalizeOk {
  ok: true
  status: 'final'
  skipped: boolean
  /** 防吃书闸降级短语（非空 = 闸门 fail-open 放行：账本推进文件读失败或闸自身异常）。
   *  服务端单章与批量逐项均透出（documents-save.ts），前端据此弹 warning。 */
  gateDegraded?: string[]
}

/** 批量定稿逐条结果（单条失败不中断整批）。 */
export interface BatchFinalizeItem {
  docId: string
  ok: boolean
  status?: 'final'
  skipped?: boolean
  error?: string
  /** 同 FinalizeOk.gateDegraded：本条定稿被降级放行的原因（ok 时才可能出现） */
  gateDegraded?: string[]
}

/** POST /documents/batch-finalize 回包。 */
export interface BatchFinalizeOk {
  ok: true
  results: BatchFinalizeItem[]
}

// ── 章节结构操作（干跑 / 执行 / 撤销）──────────────────────────────
// 干跑视图与执行结果由文档层算（src/document/structure-*.ts）——形状逐字段对齐该层，
// 由 documents.conformance.ts 的 type-only 探针编译期钉住（改动任一侧即报错）。

/** 合并干跑视图（前端确认弹窗数据源；路径字段前端不消费但服务端照发，故一并声明）。 */
export interface MergePlanView {
  ok: true
  op: 'merge'
  targetDocId: string
  sourceDocId: string
  targetChapterNo: number
  sourceChapterNo: number
  targetPath: string
  sourcePath: string
  targetTitle: string
  sourceTitle: string
  /** 任一方非 UTF-8（GBK 存量）——apply 将 400 拒绝，前端干跑后即拦 */
  encodingSuspect: boolean
  sourceWords: number
  /** 源章正文首段预览（截断） */
  sourcePreview: string
  /** 折叠后目标章 fm 并入 数组（写侧单跳化） */
  mergedInto: number[]
  /** 源章履历引文对拼接正文的命中预演（false 项合并后将产 lead-evidence-miss 红） */
  leadPreviews: Array<{ leadId: string; 动词: string; 证据: string; willMatch: boolean }>
  /** 源章 RAG 向量块清除预估 */
  ragChunksToClear: number
  planHash: string
}

/** 拆分干跑视图（拆分弹窗数据源）。 */
export interface SplitPlanView {
  ok: true
  op: 'split'
  docId: string
  path: string
  chapterNo: number
  title: string
  /** 新章号 = 全书 max+1 再跳已定稿章号（篇号永不复用） */
  newChapterNo: number
  order: number
  headWords: number
  tailWords: number
  tailPreview: string
  /** 原章 fm 已发布 → 提示「平台连载无插入机制」，不硬拦 */
  publishedWarning: boolean
  planHash: string
}

/** POST /documents/:docId/structure-plan 回包（干跑，不占结构闸）。 */
export type StructurePlanOk = { ok: true; plan: MergePlanView | SplitPlanView }

/** 合并执行成功体（失败支走非 2xx 错误信封，经 apiJson 抛 ApiError，不进本类型）。 */
export interface MergeApplyOk {
  ok: true
  targetDocId: string
  sourceDocId: string
  targetChapterNo: number
  sourceChapterNo: number
  mergedInto: number[]
  /** = 源 docId（TrashEntry.id 即原 docId） */
  trashEntryId: string
  rollbackSnapshotId?: string
  planHash: string
}

/** 拆分执行成功体。 */
export interface SplitApplyOk {
  ok: true
  docId: string
  newDocId: string
  originChapterNo: number
  newChapterNo: number
  order: number
  title: string
}

/** 撤销合并成功体。 */
export interface MergeUndoOk {
  ok: true
  targetDocId: string
  sourceDocId: string
  sourceChapterNo: number
  trashEntryId: string
  planHash: string
}
