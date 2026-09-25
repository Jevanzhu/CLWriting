/**
 * R0916-7-P3-21：文档族契约 ↔ 服务端文档层权威类型的编译期对齐探针。
 *
 * 为什么单独一个文件：探针必须 import 服务端文档层类型做逐字段断言，而服务端文档层
 * （structure-merge → structure-core → fs/events…）整图被拉进 web-next 的 vue-tsc 程序
 * 后，会连带编译出服务端既有报错（实测 server/api/schema.ts 一处不可赋值）并显著放大
 * 前端类型程序——故本文件**只被根 tsc 编译**（tsconfig include src/，web-next 的
 * tsconfig 只 include web-next/src，本文件无人 import）。
 *
 * 纪律：本文件不被任何运行时/前端代码 import；只放类型断言，不写运行时语句
 * （纯类型文件零覆盖语义，见 vitest.config 对 types/tree.ts 的同款口径）。
 *
 * 被抓的漂移：文档层给干跑视图/执行结果加字段、改字段类型、改判别值时，本文件
 * 的 `Assert<…>` 即编译期报错（`npm run typecheck`），契约与前端类型同步刷新前过不了门。
 */
import type {
  MergeApplyResult,
  MergePlanView as DocMergePlanView,
  MergeUndoResult,
} from '../../document/structure-merge.js'
import type { SplitApplyResult, SplitPlanView as DocSplitPlanView } from '../../document/structure-split.js'
import type {
  MergeApplyOk,
  MergePlanView,
  MergeUndoOk,
  SplitApplyOk,
  SplitPlanView,
} from './documents.js'

/** 逐字段等价：键集相等（抓「新增/删除字段」——含可选字段，双向可赋值抓不到它，
 *  `A extends B` 对 B 的**可选**新字段恒真）+ 双向可赋值（抓字段类型/判别值变化）。 */
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false
type SameShape<A, B> = SameKeys<A, B> extends true
  ? [A] extends [B]
    ? [B] extends [A]
      ? true
      : false
    : false
  : false

type Assert<T extends true> = T

// 干跑视图：契约 = 文档层原样（服务端 reply({ ok, plan }) 里的 plan 即文档层类型）
export type _MergePlanViewAligned = Assert<SameShape<MergePlanView, DocMergePlanView>>
export type _SplitPlanViewAligned = Assert<SameShape<SplitPlanView, DocSplitPlanView>>

// 执行/撤销结果：契约 = 文档层结果联合的成功支（失败支走非 2xx 错误信封，前端不见）
export type _MergeApplyOkAligned = Assert<SameShape<MergeApplyOk, Extract<MergeApplyResult, { ok: true }>>>
export type _SplitApplyOkAligned = Assert<SameShape<SplitApplyOk, Extract<SplitApplyResult, { ok: true }>>>
export type _MergeUndoOkAligned = Assert<SameShape<MergeUndoOk, Extract<MergeUndoResult, { ok: true }>>>
