/**
 * Z 系列（第五十八轮）回归集一：服务端 + AI 链（Z-1 / Z-4 / Z-9 / Z-12）。
 *
 * Z-1：/rewrite 端点注入整章正文 → llm/call 事件 promptMeta.files 须登记源文件（铁律①）。
 *      手法：providers.json 指向不可达端点——runTask 错误尝试同样落 llm/call（带 promptMeta），
 *      无需真实网络往返即可断言登记链。
 * Z-4：同一调用 chapter=1 落 llm/call（章记账块生效标志）。
 * Z-9：providers.test 畸形 JSON body → 400 BAD_INPUT（不再被 catch-all 包成 500 GEN_FAIL）。
 * Z-12：buildDegradeAttempts 降级链存在性锁定（degraded 标记的语义前提；适配器双 attempt
 *      行为级验证依赖 SDK 流 mock，此处锁参数面构造）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../../src/studio/server/index.js'
import { openSessionStore, bookHash } from '../../../src/events/store.js'

let baseUrl = ''
let server: http.Server | undefined
let token = ''
const workDir = mkdtempSync(join(tmpdir(), 'clw-z1-'))
const userDataPath = mkdtempSync(join(tmpdir(), 'clw-z1-ud-'))

function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const u = new URL(baseUrl)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
          'x-studio-token': token,
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }))
      },
    )
    r.on('error', () => resolve({ status: 0, text: '' }))
    if (payload) r.write(payload)
    r.end()
  })
}

beforeAll(async () => {
  const bookRoot = join(workDir, '书Z')
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), '标题: 书Z\n')
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外玉佩轻响。')
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    JSON.stringify({ version: 1, type: 'clwriting-manifest' }) + '\n' +
      JSON.stringify({ id: 'doc_z1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null }) + '\n',
  )
  // provider 指向不可达端口：runTask 错误尝试照落 llm/call（promptMeta 恒随）
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [{ id: 'p1', name: 'dead', protocol: 'openai', auth: 'bearer', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-x', caps: { connected: true, streaming: true } }],
      currentId: 'p1',
      currentModel: 'm1',
    }),
  )
  server = startServer({ workDir, port: 0, userDataPath })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await req('GET', '/api/boot')
  token = ((boot.text.match(/"token":"([^"]+)"/)) ?? [])[1] ?? ''
})
afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('Z-1/Z-4: /rewrite 端点登记与章预算', () => {
  it('llm/call 事件 promptMeta.files 含正文源 + chapter 落 1', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent('书Z')}/documents/doc_z1/rewrite`, { instruction: '更紧凑' })
    // 不可达 provider → 500 GEN_FAIL（业务失败不影响登记断言）
    expect(r.status).toBe(500)
    const store = openSessionStore(userDataPath, join(workDir, '书Z'))!
    const evs = store.listEvents(bookHash(join(workDir, '书Z')))
    const call = evs.find((e) => e.type === 'llm/call') as { data: { promptMeta?: { files?: string[] }; chapter?: number } } | undefined
    expect(call).toBeDefined()
    expect(call!.data.promptMeta!.files).toContain('写作/正文/0001-开篇.md') // Z-1
    expect(call!.data.chapter).toBe(1) // Z-4
  }, 30_000)
})

describe('Z-9: providers.test 坏 JSON → 400', () => {
  it('畸形 JSON body → 400 BAD_INPUT（不再 500 GEN_FAIL）', async () => {
    const u = new URL(baseUrl)
    const r = await new Promise<{ status: number; text: string }>((resolve) => {
      const payload = '{not-json'
      const rr = http.request(
        {
          host: u.hostname, port: u.port,
          path: `/api/providers/xxx/test`,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length), 'x-studio-token': token },
        },
        (res) => {
          let d = ''
          res.on('data', (c) => (d += c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: d }))
        },
      )
      rr.on('error', () => resolve({ status: 0, text: '' }))
      rr.write(payload)
      rr.end()
    })
    expect(r.status).toBe(400)
    expect(r.text).toContain('BAD_INPUT')
  })
})

describe('Z-12: 降级链参数面存在性', () => {
  it('structured 模式下 attempts 含首发 + 剥除面', async () => {
    const { buildDegradeAttempts } = await import('../../../src/ai/provider/adapter-errors.js')
    const plan = buildDegradeAttempts(
      { systemPrompt: 's', messages: [], structured: { name: 'x' }, tools: [{ name: 't', description: 'd', input_schema: {} }], maxTokens: 100 } as never,
      'json_schema',
      { id: 'p', model: 'm' },
      undefined,
    )
    expect(plan.attempts.length).toBeGreaterThan(1)
    expect(plan.stripStructured).not.toBeNull()
  })
})
