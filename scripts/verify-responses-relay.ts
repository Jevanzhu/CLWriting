#!/usr/bin/env node
/**
 * openai-responses 中转网关真机一次性验证脚本。
 *
 * 用途：
 *   responses-adapter（src/ai/provider/responses-adapter.ts）对 /v1/responses 下发三个
 *   高风险参数：store:false（书稿隐私）、include:['reasoning.encrypted_content']
 *   （store:false 下 gpt-5 多轮工具链的推理延续载体）、parallel_tool_calls:false
 *   （一轮一调契约）。中转网关对它们有两类失败模式：
 *   - 响亮失败：直接 400 拒收，报错文案通常指名参数；
 *   - 静默降质：吞掉 include——reasoning item 不带 encrypted_content，表面一切正常，
 *     但 gpt-5 多轮工具链丢失推理延续。
 *   本脚本两轮真机调用一次测出两种：第 1 轮强制工具调用，看参数容受与加密推理项
 *   是否透出；第 2 轮回插加密推理项 + tool_result，看回插是否被 400 拒。
 *
 * 用法：
 *   npx tsx scripts/verify-responses-relay.ts --base-url <url> --api-key <key> --model <model>
 *   --model 缺省 gpt-5；缺 --base-url / --api-key 时打印用法并以 0 退出。
 *   R61-15（第六十一轮）：key 支持经 env CLW_RELAY_API_KEY 注入（推荐——argv 明文
 *   ps 可见 ~90s 窗口，同 E-9b「凭据只走 env」红线）；仍传 --api-key 时打一行
 *   告警提示改用 env，兼容存量用法。
 *   进程内直连 createOpenAIResponsesProvider 组临时 conf（不落盘、不碰 vault /
 *   providers.json），输出永不回显完整 key。
 *
 * 判读（脚本尾部自动打印判决块）：
 *   ① 可达性——连不上 / 401 / 90s 超时在此暴露；
 *   ② 参数容受——400 文案指名 store / include / parallel_tool_calls 则点名；
 *      「强制工具未产出调用」= 疑参数被 400 拒后适配器剥 tools 降级重试（静默）；
 *   ③ 推理延续三态——开（透传加密推理项）/ 关（include 被静默吞，多轮工具链丢推理
 *      延续）/ 中转拒收回插（第 2 轮回插 400）；
 *   ④ 结论——该中转用于 openai-responses 协议：可用 / 受限 / 不可用。
 */
import process from 'node:process'
import {
  createOpenAIResponsesProvider,
  detectFamily,
  responsesQuirksFor,
} from '../src/ai/provider/index.js'
import type {
  ContentBlock,
  GenRequest,
  ModelProvider,
  ProviderConf,
  TokenUsage,
} from '../src/ai/provider/index.js'

const TIMEOUT_MS = 90_000
const DEFAULT_MODEL = 'gpt-5'

function usage(): void {
  console.log('用法：CLW_RELAY_API_KEY=<key> npx tsx scripts/verify-responses-relay.ts --base-url <url> [--model <model>] [--api-key <key>]')
  console.log('  --base-url  中转网关基地址（OpenAI 兼容根，如 https://relay.example.com/v1）')
  console.log('  --api-key   中转 API Key（兼容保留；推荐 env CLW_RELAY_API_KEY——argv 明文 ps 可见；输出只显示掩码，绝不回显全文）')
  console.log('  --model     模型名，缺省 gpt-5')
  console.log('缺 key（env 与 --api-key 均无）或 --base-url 时仅打印本用法并以 0 退出，不发任何请求。')
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  if (i === -1 || i + 1 >= process.argv.length) return null
  const v = process.argv[i + 1]
  if (v === undefined || v === '' || v.startsWith('--')) return null
  return v
}

const baseUrl = argValue('--base-url')
// R61-15：env 优先，argv 兜底（兼容存量）；argv 传入时告警留痕
const envKey = process.env.CLW_RELAY_API_KEY && process.env.CLW_RELAY_API_KEY !== '' ? process.env.CLW_RELAY_API_KEY : null
const argvKey = argValue('--api-key')
if (argvKey !== null) {
  console.warn('[warn] --api-key 经 argv 传入（ps 可见）；建议改用 env CLW_RELAY_API_KEY')
}
const apiKey = envKey ?? argvKey
const model = argValue('--model') ?? DEFAULT_MODEL

if (!baseUrl || !apiKey) {
  usage()
  process.exit(0)
}

/** 掩码——只露前缀与长度，绝不回显完整 key */
function maskKey(k: string): string {
  return k.length <= 6 ? `***（${k.length} 位）` : `${k.slice(0, 3)}***（${k.length} 位）`
}

function trunc(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : `${t.slice(0, n)}…`
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

interface ErrInfo {
  message: string
  retryable: boolean
  code?: string
  status?: number
}

/** 一轮流式调用的全部观测（encrypted 只留长度与载荷引用，永不打印内容） */
interface RoundOutcome {
  counts: Record<string, number>
  textLen: number
  textPreview: string
  reasoningLen: number
  tool: { id: string; name: string; input: unknown } | null
  reasoningItem: { itemId: string | null; encryptedLen: number; encryptedPayload: string } | null
  done: { stopReason: string; usage: TokenUsage } | null
  error: ErrInfo | null
  timedOut: boolean
}

/** 跑一轮：90s 超时中断，收集全部 GenEvent */
async function runRound(provider: ModelProvider, req: GenRequest): Promise<RoundOutcome> {
  const out: RoundOutcome = {
    counts: {},
    textLen: 0,
    textPreview: '',
    reasoningLen: 0,
    tool: null,
    reasoningItem: null,
    done: null,
    error: null,
    timedOut: false,
  }
  const ac = new AbortController()
  const timer = setTimeout(() => {
    out.timedOut = true
    ac.abort()
  }, TIMEOUT_MS)
  let text = ''
  try {
    for await (const ev of provider.stream(req, ac.signal)) {
      out.counts[ev.type] = (out.counts[ev.type] ?? 0) + 1
      switch (ev.type) {
        case 'text': {
          text += ev.delta
          break
        }
        case 'reasoning': {
          out.reasoningLen += ev.delta.length
          break
        }
        case 'reasoning_item': {
          out.reasoningItem = {
            itemId: ev.itemId ?? null,
            encryptedLen: ev.encrypted.length,
            encryptedPayload: ev.encrypted,
          }
          break
        }
        case 'tool': {
          out.tool = { id: ev.id, name: ev.name, input: ev.input }
          break
        }
        case 'done': {
          out.done = { stopReason: ev.stopReason, usage: ev.usage }
          break
        }
        case 'error': {
          out.error = {
            message: ev.message,
            retryable: ev.retryable,
            ...(ev.code ? { code: ev.code } : {}),
            ...(ev.status !== undefined ? { status: ev.status } : {}),
          }
          break
        }
      }
    }
  } catch (e) {
    // 适配器内部已兜底转 error 事件；此处只防迭代器本身抛出的意外
    out.error = {
      message: e instanceof Error ? e.message : String(e),
      retryable: false,
      code: 'THROWN',
    }
  } finally {
    clearTimeout(timer)
  }
  out.textLen = text.length
  out.textPreview = trunc(text, 60)
  return out
}

function errBrief(e: ErrInfo): string {
  const head = e.code ?? (e.status !== undefined ? `HTTP ${e.status}` : 'ERROR')
  return `[${head}] ${trunc(e.message, 120)}（retryable=${e.retryable}）`
}

function fmtCounts(c: Record<string, number>): string {
  const order = ['text', 'reasoning', 'reasoning_item', 'tool', 'done', 'error']
  const parts: string[] = []
  for (const k of order) if (c[k]) parts.push(`${k}=${c[k]}`)
  for (const k of Object.keys(c)) if (!order.includes(k)) parts.push(`${k}=${c[k]}`)
  return parts.length > 0 ? parts.join(' ') : '（无事件）'
}

function printRound(r: RoundOutcome): void {
  console.log(`事件计数：${fmtCounts(r.counts)}`)
  console.log(`文本产出：${r.textLen} 字${r.textPreview ? `「${r.textPreview}」` : ''}`)
  console.log(`推理增量：${r.reasoningLen} 字`)
  if (r.tool) {
    console.log(`工具调用：${r.tool.name}(${r.tool.id}) input=${trunc(safeJson(r.tool.input), 100)}`)
  } else {
    console.log('工具调用：（无）')
  }
  if (r.reasoningItem) {
    console.log(
      `加密推理项：透出（itemId=${r.reasoningItem.itemId ?? '无'}，encrypted 长度 ${r.reasoningItem.encryptedLen}，内容不打印）`,
    )
  } else {
    console.log('加密推理项：无（reasoning_item 事件未透出）')
  }
  if (r.done) {
    const u = r.done.usage
    console.log(
      `usage：in=${u.inputTokens} out=${u.outputTokens}${u.reasoningTokens !== undefined ? ` reasoning=${u.reasoningTokens}` : ''}（stopReason=${r.done.stopReason}）`,
    )
  }
  if (r.error) console.log(`错误：${errBrief(r.error)}`)
  else console.log('错误：无')
  if (r.timedOut) console.log('（90s 超时，已中断本轮）')
}

const ENC_PARAM = "include:['reasoning.encrypted_content']"

/** 400 报错文案里指名的风险参数 */
function namedParams(e: ErrInfo | null): string[] {
  if (!e) return []
  const hit: string[] = []
  if (/\bstore\b/i.test(e.message)) hit.push('store:false')
  if (/include|encrypted_content/i.test(e.message)) hit.push(ENC_PARAM)
  if (/parallel_tool_calls/i.test(e.message)) hit.push('parallel_tool_calls:false')
  return hit
}

// ── 组临时 conf：直连工厂，不碰 vault / providers.json ──
const conf: ProviderConf = {
  id: 'relay-verify',
  name: 'relay-verify',
  protocol: 'openai-responses',
  auth: 'bearer',
  baseUrl,
  apiKey,
  model,
  caps: null,
}
const provider = createOpenAIResponsesProvider(conf)
const family = detectFamily(model)
const q = responsesQuirksFor(model)

const echoTool = {
  name: 'relay_echo',
  description: '回显文本',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
}

console.log('=== openai-responses 中转真机验证 ===')
console.log(`端点：${baseUrl}`)
console.log(`key：${maskKey(apiKey)}`)
console.log(`模型：${model}（家族 ${family}）`)
console.log(
  '适配器实际下发：store:false 恒发；' +
    (q.responsesWire.echoReasoning === 'encrypted'
      ? 'include:[reasoning.encrypted_content] 下发'
      : `include 不下发（该家族 echoReasoning=${q.responsesWire.echoReasoning}）`) +
    `；${q.parallelControl ? 'parallel_tool_calls:false 下发' : 'parallel_tool_calls 不下发（parallelControl=false）'}` +
    `；指名 tool_choice：${q.toolChoiceMode === 'named' ? '下发' : `不下发（toolChoiceMode=${q.toolChoiceMode}）`}`,
)
console.log(`每轮超时：${TIMEOUT_MS / 1000}s`)

// ── 第 1 轮：强制工具调用 ──
console.log()
console.log('── 第 1 轮：强制工具调用（tool_choice 指名 relay_echo） ──')
const req1: GenRequest = {
  systemPrompt: '你是中转验证助手，严格按用户指示调用工具。',
  messages: [{ role: 'user', content: '调用 relay_echo 工具，参数 text 填 pass' }],
  tools: [echoTool],
  toolChoice: 'tool',
  toolName: 'relay_echo',
  effort: 'low',
  maxTokens: 2000,
}
const r1 = await runRound(provider, req1)
printRound(r1)

// ── 第 2 轮：回插加密推理项 + tool_result（仅当拿到工具调用） ──
let r2: RoundOutcome | null = null
if (r1.tool) {
  const blocks: ContentBlock[] = []
  let reinsertNote = '（第 1 轮无加密推理项，仅回插 tool_use）'
  if (r1.reasoningItem && r1.reasoningItem.encryptedLen > 0) {
    blocks.push({
      type: 'reasoning',
      text: '',
      encrypted: r1.reasoningItem.encryptedPayload,
      ...(r1.reasoningItem.itemId ? { itemId: r1.reasoningItem.itemId } : {}),
    })
    reinsertNote = `（reasoning 块：itemId=${r1.reasoningItem.itemId ?? '无'}，encrypted ${r1.reasoningItem.encryptedLen} 字，内容不打印）`
  }
  blocks.push({ type: 'tool_use', id: r1.tool.id, name: r1.tool.name, input: r1.tool.input })

  console.log()
  console.log('── 第 2 轮：回插加密推理项 + tool_result ──')
  console.log(
    `assistant 轮回插：${reinsertNote} + tool_use ${r1.tool.name}(${r1.tool.id})；user 轮 tool_result「echo: pass」`,
  )
  const req2: GenRequest = {
    systemPrompt: '你是中转验证助手，严格按用户指示调用工具。',
    messages: [
      { role: 'user', content: '调用 relay_echo 工具，参数 text 填 pass' },
      { role: 'assistant', content: blocks },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: r1.tool.id, content: 'echo: pass' }] },
    ],
    tools: [echoTool],
    toolChoice: 'auto',
    effort: 'low',
    maxTokens: 2000,
  }
  r2 = await runRound(provider, req2)
  printRound(r2)
} else {
  console.log()
  console.log('── 第 2 轮：跳过（第 1 轮未取得工具调用，无多轮可回插） ──')
}

// ── 判决 ──
console.log()
console.log('── 判决 ──')

// ① 两轮可达性
const reach1 = r1.error
  ? `第 1 轮不可达（${errBrief(r1.error)}${r1.timedOut ? '，90s 超时中断' : ''}）`
  : `第 1 轮可达${r1.done ? `（stopReason=${r1.done.stopReason}）` : ''}`
const reach2 = r2
  ? r2.error
    ? `第 2 轮不可达（${errBrief(r2.error)}${r2.timedOut ? '，90s 超时中断' : ''}）`
    : '第 2 轮可达'
  : '第 2 轮未执行'
console.log(`① 可达性：${reach1}；${reach2}`)

// ② 参数容受
const named = [...namedParams(r1.error), ...namedParams(r2?.error ?? null)].filter(
  (v, i, a) => a.indexOf(v) === i,
)
let tolerance: string
if (named.length > 0) tolerance = `拒收——400 报错指名：${named.join('、')}`
else if (r1.tool) tolerance = '容忍——store:false / include / parallel_tool_calls:false 实际下发未见 400'
else if (r1.error) tolerance = `无法判定——第 1 轮即失败（${errBrief(r1.error)}）`
else tolerance = '存疑——强制 tool_choice 未产出工具调用，疑参数被 400 拒后适配器剥 tools 降级重试（静默降级）'
if (q.responsesWire.echoReasoning !== 'encrypted') {
  tolerance += `（注意：${model} 非 gpt 家族档，适配器本就不发 include，include 容受未测到）`
}
if (q.toolChoiceMode !== 'named') {
  tolerance += `（注意：该家族 toolChoiceMode=${q.toolChoiceMode}，指名强制未实际下发）`
}
console.log(`② 参数容受：${tolerance}`)

// ③ 推理延续三态
function isRejectedReinsert(round: RoundOutcome | null): boolean {
  const e = round?.error
  if (!e) return false
  return (e.status === 400 || e.code === 'BAD_REQUEST') && /reasoning|encrypted|item/i.test(e.message)
}
const rejectedReinsert = isRejectedReinsert(r2)
let continuation: string
if (!r2) continuation = '无法判定（第 1 轮未取得工具调用，无多轮可测）'
else if (rejectedReinsert) continuation = '中转拒收回插'
else if (r1.reasoningItem && r1.reasoningItem.encryptedLen > 0) {
  continuation = '开（透传加密推理项）'
  continuation += r1.reasoningItem.itemId
    ? '，第 2 轮回插被接受'
    : '，但缺 itemId——适配器双条件不满足不会实际回插，回插路径未测到'
} else {
  continuation = '关（include 被静默吞，多轮工具链丢推理延续）'
  if (r1.done?.usage.reasoningTokens) {
    continuation += '（本轮有推理 token 消耗，坐实模型确实推理而 encrypted 未随响应返回）'
  }
  if (q.responsesWire.echoReasoning !== 'encrypted') {
    continuation += `（${model} 家族适配器本就不发 include——此「关」是客户端不发，非中转吞参）`
  }
}
console.log(`③ 推理延续：${continuation}`)

// ④ 结论
const reasons: string[] = []
if (!r1.tool && r1.error) reasons.push(`第 1 轮即失败：${errBrief(r1.error)}`)
if (named.length > 0) reasons.push(`拒收参数 ${named.join('、')}`)
if (rejectedReinsert) reasons.push('拒收回插加密推理项')
if (!r1.error && !r1.tool && q.toolChoiceMode === 'named') reasons.push('强制工具调用未产出（疑似静默降级）')
if (r2?.error && !rejectedReinsert) reasons.push(`第 2 轮失败：${errBrief(r2.error)}`)
if (continuation.startsWith('关') && q.responsesWire.echoReasoning === 'encrypted') {
  reasons.push('推理延续丢失')
}
const verdict = !r1.tool && r1.error ? '不可用' : reasons.length > 0 ? '受限' : '可用'
const tail =
  verdict === '可用'
    ? '两轮全通，加密推理项透传且回插被接受'
    : reasons.join('；')
console.log(`④ 结论：该中转用于 openai-responses 协议：${verdict}——${tail}`)
