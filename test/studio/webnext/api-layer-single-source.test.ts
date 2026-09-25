/**
 * R0916-7-P3-26 / R0916-7-P3-21（0916-7 批）回归：api 层单源与对外面收口锚。
 *
 * ① apiFetch 对外只留 `(path, init)`——递归重试标记（_retried）与超时计量/重放出参
 *    （_gauge/_replayed）此前是对外形参，调用方可见内部状态；现收进私有 apiFetchCore。
 *    源码锚钉两件事：导出签名恰为两参、内部递归只发生在私有函数里。
 * ② 可重放性由调用方显式声明（init.replayable），**不得**再从 body 嗅探 operationId
 *    （原实现对 PUT 做 JSON.parse 找幂等键——每请求多一次全量体解析，且「键名落 body
 *    = 幂等」是隐式契约）。行为面见 client-401-replay-idempotency.test.ts + 下方声明点锚。
 * ③ 截断函数单源：chat-dispatch 的码点截断 import 根 shared/text（P3-26 截断函数项，
 *    本地副本已删）——复活本地副本即红。
 * ④ 工具展示面单源：ChatMessages 的中文名/参数摘要取自根 ai/contract/tool-meta.ts
 *    （P3-21 工具名派生项），不得回落手写工具名清单。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const CLIENT = 'src/studio/web-next/src/api/client.ts'
const DOCUMENTS = 'src/studio/web-next/src/api/documents.ts'
const CHAT_DISPATCH = 'src/studio/web-next/src/stores/chat-dispatch.ts'
const CHAT_MESSAGES = 'src/studio/web-next/src/components/panels/chat/ChatMessages.vue'

describe('R0916-7-P3-26: apiFetch 对外面与编码层单源', () => {
  it('apiFetch 导出签名恰为两参 (path, init)；内部管道不对外', () => {
    const src = readFileSync(CLIENT, 'utf8')
    const m = /export async function apiFetch\(([^)]*)\)/.exec(src)
    expect(m).not.toBeNull()
    expect(m![1]).toBe('path: string, init: ApiFetchInit = {}')
    // 递归重试只发生在私有 apiFetchCore（下一步的 fetch 装配与 401 重放都在其中）
    expect(/^async function apiFetchCore\(/m.test(src)).toBe(true)
    expect(/^export async function apiFetchCore/m.test(src)).toBe(false)
    // apiJson 走私有函数（带计量/重放出参），不经过薄壳
    expect(src).toContain('apiFetchCore(path, { ...reqInit, signal: controller.signal }, false, gauge, replayed)')
  })

  it('删掉靠 JSON.parse 嗅探 operationId 的启发式；重放性只由显式声明驱动', () => {
    const src = readFileSync(CLIENT, 'utf8')
    expect(src).not.toContain('JSON.parse(body)')
    expect(src).toContain('replayable?: boolean')
    expect(src).toContain('return declared === true')
  })

  it('声明点：文档保存（幂等 operationId）显式声明可重放', () => {
    const src = readFileSync(DOCUMENTS, 'utf8')
    expect(src).toContain('replayable: true')
  })

  it('截断函数单源：chat-dispatch 引根 shared/text，本地 clipByCodePoints 副本不存在', () => {
    const src = readFileSync(CHAT_DISPATCH, 'utf8')
    expect(src).toContain("import { codePointLength, clipByCodePoints } from '../../../../shared/text'")
    expect(src).not.toContain('function clipByCodePoints')
  })

  it('工具展示面单源：ChatMessages 的中文名/摘要取自根 tool-meta.ts', () => {
    const src = readFileSync(CHAT_MESSAGES, 'utf8')
    expect(src).toContain("import { toolLabel, toolSummary, type ChapterNameLookup } from '../../../../../../ai/contract/tool-meta'")
  })
})
