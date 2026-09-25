/**
 * R0916-7-P3-21（0916-7 批）回归：回包类型共享契约生效机制。
 *
 * 契约落点 = 根 `src/shared/contract/documents.ts`（两端共用一份声明）；前端 api/ 层
 * 引用并把类型原样转发，调用方 import 面不变。本文件钉四件事：
 *
 * ① 机制（编译期，@ts-expect-error + 类型探针）：契约是**精确形状**——服务端加字段而
 *    契约未同步时，服务端那侧的对象字面量注解（reply 负载）即「多余属性」编译期报错；
 *    同一机制在测试侧以 `@ts-expect-error` 钉住（放开即「Unused '@ts-expect-error'」报错）。
 *    同时 api 函数返回类型与契约类型双向可赋值（任一侧改形即报错）。
 * ② 迁移面锚：api/documents.ts 不再手抄这些回包类型（曾经的 FinalizeOk/gateDegraded
 *    漂移实例），只从契约转发。
 * ③ 服务端漂移闸（真实跨端）：服务端 handler 组装回包的对象字面量键集必须与契约键集
 *    相等——服务端加/删/改名字段而契约未同步时本用例红（文案级联：先改契约、再改前端
 *    消费处、最后服务端 ANN）。
 * ④ 编译期对齐探针存在且只归根 tsc（documents.conformance.ts）——它把契约的干跑视图
 *    逐字段钉在服务端文档层权威类型上（那边加字段同样过不了门）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { FinalizeOk } from '../../../src/shared/contract/documents'
import type { BatchFinalizeItem, BatchFinalizeOk } from '../../../src/shared/contract/documents'
import type { FileContentPayload, SaveOk, TrashEntry } from '../../../src/shared/contract/documents'
import type { MergeApplyOk, MergePlanView, SplitApplyOk, SplitPlanView, StructurePlanOk } from '../../../src/shared/contract/documents'
import {
  batchFinalizeDocs,
  finalizeDoc,
  getContentPayload,
  listTrash,
  saveContent,
  structureApply,
  structurePlan,
} from '../../../src/studio/web-next/src/api/documents'

const CONTRACT = 'src/shared/contract/documents.ts'
const SERVER_SAVE = 'src/studio/server/api/documents-save.ts'
const API_DOCUMENTS = 'src/studio/web-next/src/api/documents.ts'

// ── 类型探针（编译期）────────────────────────────────────────────────
// 探针即断言语义：`export` 只为过 noUnusedLocals（本文件是测试，导出无消费方也无害）；
// 断言失败 = Assert<false> 报错，与运行时用例无关。
type SameKeys<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false
type SameShape<A, B> = SameKeys<A, B> extends true
  ? [A] extends [B]
    ? [B] extends [A]
      ? true
      : false
    : false
  : false
type Assert<T extends true> = T

/** api 层返回类型 = 契约类型（api/documents.ts 不得再声明自己的形状） */
export type _FinalizeReturnMatchesContract = Assert<SameShape<Awaited<ReturnType<typeof finalizeDoc>>, FinalizeOk>>
export type _BatchFinalizeReturnMatchesContract = Assert<SameShape<Awaited<ReturnType<typeof batchFinalizeDocs>>, BatchFinalizeOk>>
export type _BatchItemMatchesContract = Assert<SameShape<BatchFinalizeOk['results'][number], BatchFinalizeItem>>
export type _GetContentReturnMatchesContract = Assert<SameShape<Awaited<ReturnType<typeof getContentPayload>>, FileContentPayload>>
export type _SaveReturnMatchesContract = Assert<SameShape<Awaited<ReturnType<typeof saveContent>>, SaveOk>>
export type _ListTrashReturnMatchesContract = Assert<SameShape<Awaited<ReturnType<typeof listTrash>>, TrashEntry[]>>
export type _PlanReturnMatchesContract = Assert<SameShape<Awaited<ReturnType<typeof structurePlan>>, StructurePlanOk>>
export type _ApplyReturnMatchesContract = Assert<SameShape<Awaited<ReturnType<typeof structureApply>>, MergeApplyOk | SplitApplyOk>>

/** 契约里的干跑视图判别值（对齐探针在 documents.conformance.ts，见下方用例④） */
export type _PlanViewIsContractShape = Assert<SameShape<MergePlanView['op'], 'merge'>>
export type _SplitViewIsContractShape = Assert<SameShape<SplitPlanView['op'], 'split'>>

// ── 源码解析助手（服务端漂移闸）──────────────────────────────────────

/** 截出 marker 之后首个 `{ … }` 块（括号配平；本批扫的块内无字符串/注释） */
function literalBlockAfter(src: string, marker: string): string {
  const at = src.indexOf(marker)
  if (at < 0) throw new Error(`未找到标记：${marker}`)
  return matchBrace(src, src.indexOf('{', at))
}

/** 截出**包含** marker 的最内层 `{ … }` 块（向前找最近的未配对 `{`） */
function innermostBlockContaining(src: string, marker: string): string {
  const at = src.indexOf(marker)
  if (at < 0) throw new Error(`未找到标记：${marker}`)
  let depth = 0
  for (let i = at; i >= 0; i--) {
    if (src[i] === '}') depth++
    else if (src[i] === '{') {
      if (depth === 0) return matchBrace(src, i)
      depth--
    }
  }
  throw new Error(`未找到包裹块：${marker}`)
}

/** 从 open（指向 `{`）配平到对应 `}`，返回含两侧花括号的整块文本 */
function matchBrace(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error('括号未配平')
}

/** JS 字面量关键字——三元分支（`? x : undefined`）会被「标识符 + 冒号」形态误捕 */
const LITERAL_KEYWORDS = new Set(['undefined', 'null', 'true', 'false'])

/** 对象字面量的键集：`key:` 形态（排除 `obj.key:`）+ 简写形态（`{ ok: true, results }` 的 results） */
function objectLiteralKeys(block: string): string[] {
  const keys = new Set<string>()
  for (const m of block.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*:/g)) {
    if (!LITERAL_KEYWORDS.has(m[1]!)) keys.add(m[1]!)
  }
  for (const m of block.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g)) {
    if (!LITERAL_KEYWORDS.has(m[1]!)) keys.add(m[1]!)
  }
  return [...keys].sort()
}

/** 契约里某个 interface 的字段名（顶层两空格缩进的 `key?:` 行） */
function contractKeys(interfaceName: string): string[] {
  const src = readFileSync(CONTRACT, 'utf8')
  const block = literalBlockAfter(src, `export interface ${interfaceName} `)
  const keys = new Set<string>()
  for (const m of block.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)) keys.add(m[1]!)
  return [...keys].sort()
}

describe('R0916-7-P3-21: 回包类型共享契约机制', () => {
  it('机制探针：契约是精确形状——服务端加字段而契约未同步即编译期报错', () => {
    // @ts-expect-error 未知字段（模拟「服务端加了 newFieldFromServer 而契约未同步」）
    const drifted: FinalizeOk = { ok: true, status: 'final', skipped: false, newFieldFromServer: 1 }
    expect('newFieldFromServer' in drifted).toBe(true)
  })

  it('服务端漂移闸：finalize 回包字面量键集 ≡ 契约 FinalizeOk', () => {
    const block = innermostBlockContaining(readFileSync(SERVER_SAVE, 'utf8'), 'status: outcome.status')
    expect(objectLiteralKeys(block)).toEqual(contractKeys('FinalizeOk'))
  })

  it('服务端漂移闸：批量定稿逐项字面量键集 ≡ 契约 BatchFinalizeItem', () => {
    const block = literalBlockAfter(readFileSync(SERVER_SAVE, 'utf8'), 'results.push(')
    expect(objectLiteralKeys(block)).toEqual(contractKeys('BatchFinalizeItem'))
  })

  it('服务端漂移闸：批量定稿回包字面量键集 ≡ 契约 BatchFinalizeOk', () => {
    const block = innermostBlockContaining(readFileSync(SERVER_SAVE, 'utf8'), 'ok: true, results')
    expect(objectLiteralKeys(block)).toEqual(contractKeys('BatchFinalizeOk'))
  })

  it('迁移面锚：api/documents.ts 只转发契约类型，不再手抄回包形状', () => {
    const src = readFileSync(API_DOCUMENTS, 'utf8')
    for (const name of [
      'FinalizeOk',
      'BatchFinalizeOk',
      'BatchFinalizeItem',
      'SaveOk',
      'CreateOk',
      'FileContentPayload',
      'MergePlanView',
      'SplitPlanView',
      'MergeApplyOk',
      'SplitApplyOk',
      'MergeUndoOk',
      'TrashEntry',
      'StructurePlanOk',
    ]) {
      expect(src).not.toContain(`interface ${name} `)
      expect(src).not.toContain(`interface ${name} {`)
    }
    expect(src).toContain("from '../../../../shared/contract/documents'")
  })

  it('对齐探针在位：契约的干跑视图由 documents.conformance.ts 钉在服务端文档层类型上', () => {
    const probe = readFileSync('src/shared/contract/documents.conformance.ts', 'utf8')
    for (const anchor of [
      "from '../../document/structure-merge.js'",
      "from '../../document/structure-split.js'",
      'MergePlanViewAligned',
      'SplitPlanViewAligned',
      'MergeApplyOkAligned',
      'MergeUndoOkAligned',
    ]) {
      expect(probe).toContain(anchor)
    }
    // 探针只归根 tsc（import 服务端层整图会连带编译服务端既有报错，见其头注）——
    // 前端 src 与 webnext 测试都不得 import 它
    expect(probe).toContain('只被根 tsc 编译')
  })
})
