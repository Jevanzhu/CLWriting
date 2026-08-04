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

/** token 用量（OpenAI 格式 prompt_tokens / completion_tokens） */
interface FakeUsage {
  input: number
  output: number
}

/** 脚本条目 —— 每条对应一次请求的响应 */
export type FakeResponse =
  | { type: 'text'; content: string; usage?: FakeUsage }
  | { type: 'tool'; name: string; input: unknown; id?: string; usage?: FakeUsage }
  | { type: 'error'; status: number; message: string }
  | { type: 'max_tokens'; partial: string; usage?: FakeUsage }

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
    req.on('end', () => {
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

      // 错误响应（非流式）
      if (resp.type === 'error') {
        res.writeHead(resp.status, { 'Content-Type': 'application/json' })
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
        writeChunk({ id: 'fake-chatcmpl', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } })
      } else if (resp.type === 'tool') {
        // tool_use 增量（一次性吐完 arguments）
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: resp.id ?? `call_${callIdx - 1}`,
                type: 'function',
                function: { name: resp.name, arguments: JSON.stringify(resp.input) },
              }],
            },
            finish_reason: null,
          }],
        })
        // finish
        writeChunk({
          id: 'fake-chatcmpl',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        })
        // usage 尾包
        writeChunk({ id: 'fake-chatcmpl', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } })
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
        writeChunk({ id: 'fake-chatcmpl', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output } })
      }

      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
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
    })
  })
}
