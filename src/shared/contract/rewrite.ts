/**
 * 改写回包契约（前端 api/rewrite.ts 与服务端 rewrite 端点共用）。
 *
 * 服务端权威类型 = src/process/rewrite-prompt.ts 的 DiffLine；RewriteResult 是端点
 * 回包字面量，服务端以 `satisfies RewriteResult` 接入多余属性检查。漂移由
 * rewrite.conformance.ts 钉住。
 */

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

/** POST /documents/:docId/rewrite 回包。 */
export interface RewriteResult {
  ok: true
  mode: 'local' | 'whole' | 'append'
  original: string
  rewritten: string
  diff: DiffLine[]
}

/** POST /documents/:docId/ai-version 回包。 */
export interface AiVersionResult {
  ok: true
  recorded: boolean
}
