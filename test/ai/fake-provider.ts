/**
 * 进程内 HTTP stub —— OpenAI 兼容端点（AI Harness T1）。
 *
 * 起 node:http 监听随机端口，按脚本吐流式 SSE 响应。
 * baseURL 写入 fixture providers.json → 请求走真实 openai-adapter 全链路
 *（重试 / caps / usage 尾包），这是「非 mock 分支」测试的核心。
 *
 * 与 CLWRITING_DRIVER=mock 互斥：mock 走 tryMockTool/mockText 短路，
 * fake provider 走真实 provider HTTP 路径。测试中显式 delete CLWRITING_DRIVER。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { listenSafe } from '../helpers/safe-port.js'

/** token 用量（OpenAI 格式 prompt_tokens / completion_tokens） */
interface FakeUsage {
  input: number
  output: number
}

/** 脚本条目 —— 每条对应一次请求的响应。
 *  delayMs（任意条目可选）：响应前挂起 N ms——制造「在途请求」窗口，供中断类测试
 *  在生成进行中触发 abort（Z-P1-1）；客户端断开后挂起的响应被静默丢弃。 */
export type FakeResponse =
  | ({ type: 'text'; content: string; usage?: FakeUsage } & { delayMs?: number })
  | ({ type: 'tool'; name: string; input: unknown; id?: string; usage?: FakeUsage } & { delayMs?: number })
  // R64-5：单响应多 tool_use（index 0..n-1 顺序吐出）——驱动 generateTool 丢弃告警路径
  | ({ type: 'tools'; calls: Array<{ name: string; input: unknown; id?: string }>; usage?: FakeUsage } & {
      delayMs?: number
    })
  // R34D-9：传输截断形态——内容增量 + usage 尾包，无 finish_reason 即断流
  //（适配器按 R31-1 判传输截断，随错上抛已见 usage → 驱动 runTask 重试链带 usage 分支）
  | ({ type: 'truncated'; content: string; usage?: FakeUsage } & { delayMs?: number })
  | ({ type: 'error'; status: number; message: string; retryAfter?: string } & { delayMs?: number })
  | ({ type: 'max_tokens'; partial: string; usage?: FakeUsage } & { delayMs?: number })

/** stub 实例句柄 */
export interface FakeProvider {
  /** 写入 providers.json 的 baseUrl（如 http://127.0.0.1:PORT/v1） */
  url: string
  /** 关闭 stub server */
  close: () => Promise<void>
  /** 重置脚本 + 计数器 */
  setScript: (responses: FakeResponse[]) => void
  /** 收到的请求总数 */
  requestCount: () => number
  /** 最后一次请求的 body（验证请求确实打到 stub） */
  lastBody: () => Record<string, unknown> | null
}

/** 默认 token 用量 */
const DEFAULT_USAGE: FakeUsage = { input: 100, output: 50 }

/**
 * 创建进程内 stub server。
 *
 * @param initialScript 初始响应脚本；用尽后重复最后一条
 */
export function createFakeProvider(initialScript: FakeResponse[] = []): Promise<FakeProvider> {
  let script = initialScript
  let callIdx = 0
  let reqCount = 0
  let lastRequestBody: Record<string, unknown> | null = null

  const server = http.createServer((req, res) => {
    // 只响应 chat/completions
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    // 收集请求体
    let bodyChunks = ''
    req.on('data', (c) => (bodyChunks += c))
    req.on('end', async () => {
      reqCount++
      try {
        lastRequestBody = JSON.parse(bodyChunks) as Record<string, unknown>
      } catch {
        lastRequestBody = null
      }

      const resp = script[callIdx] ?? script.at(-1)
      callIdx++

      if (!resp) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'stub 脚本为空' }))
        return
      }

      // delayMs：挂起响应制造在途窗口（Z-P1-1 中断测试用）——期间客户端 abort 会销毁连接，
      // 唤醒后写已死连接无意义，直接丢弃（不写不 end，让 socket 自然回收）
      if (resp.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, resp.delayMs))
        if (res.destroyed || res.writableEnded) return
      }

      // 错误响应（非流式）
      if (resp.type === 'error') {
        // B4：可选 Retry-After 头（429 语义），驱动 runner 退避升级路径
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (resp.retryAfter !== undefined) headers['Retry-After'] = resp.retryAfter
        res.writeHead(resp.status, headers)
        res.end(JSON.stringify({ error: { message: resp.message, type: 'stub_error' } }))
        return
      }

      // 流式 SSE 响应
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      const usage = resp.usage ?? DEFAULT_USAGE

      const writeChunk = (obj: Record<string, unknown>): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }

      if (resp.type === 'text') {
        // 文本增量
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: resp.content }, finish_reason: null }],
        })
        // finish
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
        // usage 尾包（include_usage 模式：空 choices + usage）
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
        })
      } else if (resp.type === 'tool') {
        // tool_use 增量（一次性吐完 arguments）
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: resp.id ?? `call_${callIdx - 1}`,
                    type: 'function',
                    function: { name: resp.name, arguments: JSON.stringify(resp.input) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })
        // finish
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
        // usage 尾包
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
        })
      } else if (resp.type === 'tools') {
        // R64-5：多 tool_use——每块一个 delta（index 递增），finish 'tool_calls' + usage 尾包
        for (let i = 0; i < resp.calls.length; i++) {
          const c = resp.calls[i]!
          writeChunk({
            id: 'fake-chatcmpl',
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: i,
                      id: c.id ?? `call_${callIdx - 1}_${i}`,
                      type: 'function',
                      function: { name: c.name, arguments: JSON.stringify(c.input) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })
        }
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
        })
      } else if (resp.type === 'truncated') {
        // R34D-9：截断流——只有内容增量 + usage 尾包，finish_reason 永不到达（R31-1 形态）
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: resp.content }, finish_reason: null }],
        })
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
        })
      } else if (resp.type === 'max_tokens') {
        // 部分文本 + finish_reason: length
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: resp.partial }, finish_reason: null }],
        })
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
        })
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: usage.input, completion_tokens: usage.output },
        })
      }

      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    listenSafe(server).then(() => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        setScript: (responses) => {
          script = responses
          callIdx = 0
          reqCount = 0
          lastRequestBody = null
        },
        requestCount: () => reqCount,
        lastBody: () => lastRequestBody,
      })
    }, reject)
  })
}

// ─── Anthropic 协议线 stub（0918独立重评修复批 G002） ─────────────────────
//
// 此前 anthropic-adapter 只经进程内假 client（adapter-fixtures fakeSend）间接行使，
// 真线（@anthropic-ai/sdk 的 HTTP/SSE 解析、/v1/messages 拼接、认证头）无测试面。
// 本 stub 与上方 OpenAI 线同款形态：node:http 随机端口、脚本驱动，独立工厂
//（不与 OpenAI stub 共 server——OpenAI 线既有消费件行为逐位不变）。
//
// 事件序列合规（@anthropic-ai/sdk Stream.fromSSEResponse 的 event: 名单硬约束——
// event: 行缺省或不在名单内的 data 行被静默跳过）：
//   message_start（usage.input / cache 两档）→ content_block_start →
//   content_block_delta（text_delta / input_json_delta 分片）→ content_block_stop →
//   message_delta（stop_reason + usage.output）→ message_stop
// SDK 对 event: error 的 SSE 事件直接 throw APIError（status undefined）——
// sse_error 条目即测该形态经适配器 toErrorEvent 的映射。

/** token 用量（Anthropic 格式：input 在 message_start、output 在 message_delta，D4 独立记账） */
export interface AnthropicFakeUsage {
  input: number
  output: number
  /** message_start 的 cache_read_input_tokens（缺省不发字段） */
  cacheRead?: number
  /** message_start 的 cache_creation_input_tokens（缺省不发字段） */
  cacheWrite?: number
}

/** Anthropic 线脚本条目——每条对应一次 POST /v1/messages 的流式 SSE 响应 */
export type AnthropicFakeResponse =
  | ({ type: 'text'; content: string; usage?: AnthropicFakeUsage; stopReason?: string } & { delayMs?: number })
  | ({ type: 'tool'; name: string; input: unknown; id?: string; usage?: AnthropicFakeUsage } & { delayMs?: number })
  // stop_reason: max_tokens——generateText 抛不可重试 GenError(MAX_TOKENS) 的真线形态
  | ({ type: 'max_tokens'; partial: string; usage?: AnthropicFakeUsage } & { delayMs?: number })
  // 流中 error 事件（如 overloaded_error）——SDK Stream 直接 throw APIError 的形态
  | ({ type: 'sse_error'; errorType: string; message: string; usage?: AnthropicFakeUsage } & { delayMs?: number })

/** Anthropic stub 实例句柄 */
export interface FakeAnthropicProvider {
  /** 写入 providers.json 的 baseUrl（如 http://127.0.0.1:PORT/v1；适配器剥尾 /v1 后 SDK 自拼 /v1/messages） */
  url: string
  /** 关闭 stub server */
  close: () => Promise<void>
  /** 重置脚本 + 计数器 */
  setScript: (responses: AnthropicFakeResponse[]) => void
  /** 收到的请求总数 */
  requestCount: () => number
  /** 最后一次请求的 body（验证请求确实打到 stub 与请求拼装形状） */
  lastBody: () => Record<string, unknown> | null
  /** 最后一次请求的认证头三件（x-api-key / authorization / anthropic-version，在位才记）——auth 策略断言用 */
  lastHeaders: () => Record<string, string> | null
}

/**
 * 创建进程内 Anthropic 协议 stub server（POST /v1/messages 流式 SSE）。
 *
 * @param initialScript 初始响应脚本；用尽后重复最后一条
 */
export function createFakeAnthropicProvider(
  initialScript: AnthropicFakeResponse[] = [],
): Promise<FakeAnthropicProvider> {
  let script = initialScript
  let callIdx = 0
  let reqCount = 0
  let lastRequestBody: Record<string, unknown> | null = null
  let lastHeaders: Record<string, string> | null = null

  const server = http.createServer((req, res) => {
    // 只响应 messages 端点（SDK 固定请求 {baseURL}/v1/messages）
    if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }))
      return
    }

    // 收集请求体 + 认证头快照
    let bodyChunks = ''
    req.on('data', (c) => (bodyChunks += c))
    req.on('end', async () => {
      reqCount++
      const picked: Record<string, string> = {}
      for (const k of ['x-api-key', 'authorization', 'anthropic-version']) {
        const v = req.headers[k]
        if (typeof v === 'string') picked[k] = v
      }
      lastHeaders = picked
      try {
        lastRequestBody = JSON.parse(bodyChunks) as Record<string, unknown>
      } catch {
        lastRequestBody = null
      }

      const resp = script[callIdx] ?? script.at(-1)
      callIdx++

      if (!resp) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stub 脚本为空' } }))
        return
      }

      // delayMs：与 OpenAI 线同款在途窗口（中断类测试用）
      if (resp.delayMs !== undefined) {
        await new Promise((r) => setTimeout(r, resp.delayMs))
        if (res.destroyed || res.writableEnded) return
      }

      // 显式注解：DEFAULT_USAGE 是 OpenAI 线 FakeUsage（无 cache 档），不加注解会并宽
      // 联合让 cacheRead/cacheWrite 访问报错（0918独立重评修复批 G002）
      const usage: AnthropicFakeUsage = resp.usage ?? DEFAULT_USAGE

      // 流式 SSE 响应（SDK 按 content-type 事件流解析）
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      // event: 行必须显式（SDK fromSSEResponse 按事件名白名单 yield，见文件头注）
      const writeEvent = (name: string, obj: Record<string, unknown>): void => {
        res.write(`event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`)
      }
      // message_start：input_tokens + cache 两档在此（message_delta 一般缺，适配器 D4/P2-3 口径）
      const messageStart = (): void => {
        writeEvent('message_start', {
          type: 'message_start',
          message: {
            id: `msg_fake_${reqCount}`,
            type: 'message',
            role: 'assistant',
            model: 'fake-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: usage.input,
              ...(usage.cacheRead !== undefined ? { cache_read_input_tokens: usage.cacheRead } : {}),
              ...(usage.cacheWrite !== undefined ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
            },
          },
        })
      }
      // 文本块三连（start → text_delta → stop）
      const textBlock = (text: string): void => {
        writeEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        })
        writeEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        })
        writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      // message_delta：stop_reason + usage.output（适配器 N6 缓存 stop_reason、R27-2 末见 usage）
      const messageDelta = (stopReason: string): void => {
        writeEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: usage.output },
        })
      }

      if (resp.type === 'text') {
        messageStart()
        textBlock(resp.content)
        messageDelta(resp.stopReason ?? 'end_turn')
        writeEvent('message_stop', { type: 'message_stop' })
      } else if (resp.type === 'max_tokens') {
        messageStart()
        textBlock(resp.partial)
        messageDelta('max_tokens')
        writeEvent('message_stop', { type: 'message_stop' })
      } else if (resp.type === 'tool') {
        // tool_use 块：input_json_delta 分片吐 JSON（两片，行使用适配器 jsonBuf 增量拼装面）
        messageStart()
        writeEvent('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: resp.id ?? `toolu_fake_${reqCount}`, name: resp.name, input: {} },
        })
        const json = JSON.stringify(resp.input)
        const cut = Math.max(1, Math.ceil(json.length / 2))
        writeEvent('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) },
        })
        if (json.length > cut) {
          writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: json.slice(cut) },
          })
        }
        writeEvent('content_block_stop', { type: 'content_block_stop', index: 0 })
        messageDelta('tool_use')
        writeEvent('message_stop', { type: 'message_stop' })
      } else if (resp.type === 'sse_error') {
        // message_start 后流中 error 事件——SDK Stream.fromSSEResponse 对 event:error
        // 直接 throw APIError(status undefined)，适配器 catch → toErrorEvent
        messageStart()
        writeEvent('error', { type: 'error', error: { type: resp.errorType, message: resp.message } })
      }

      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    listenSafe(server).then(() => {
      const addr = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        setScript: (responses) => {
          script = responses
          callIdx = 0
          reqCount = 0
          lastRequestBody = null
          lastHeaders = null
        },
        requestCount: () => reqCount,
        lastBody: () => lastRequestBody,
        lastHeaders: () => lastHeaders,
      })
    }, reject)
  })
}
