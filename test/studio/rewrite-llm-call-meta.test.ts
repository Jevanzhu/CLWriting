/**
 * Z-1 / Z-4（五十八轮 Z 系列）回归：/rewrite 端点的 llm/call 事件登记面。
 *
 * - Z-1：注入整章正文 → llm/call 事件 promptMeta.files 须登记源文件（铁律①）。
 *   手法：providers.json 指向不可达端点——runTask 错误尝试同样落 llm/call（带
 *   promptMeta），无需真实网络往返即可断言登记链。
 * - Z-4：同一调用 chapter=1 落 llm/call（章记账块生效标志）。
 *
 * 来源记档（2026-09-26 测试资产行为化批）：自批号目录 y2/z-head-regressions.test.ts
 * （Z 系列杂烩）按行为拆立；Z-9 → providers-test-bad-input、Z-12 →
 * degrade-attempts-chain。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { openSessionStore, bookHash } from '../../src/events/store.js'

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
  server = await startServerSafe({ workDir, port: 0, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await req('GET', '/api/boot')
  token = ((boot.text.match(/"token":"([^"]+)"/)) ?? [])[1] ?? ''
})
afterAll(() => {
  server?.close()
  try {
    rmSync(workDir, { recursive: true, force: true })
    rmSync(userDataPath, { recursive: true, force: true })
  } catch {
    // Windows 清理竞态（句柄/防病毒占用偶发 EPERM）——best-effort 忽略
  }
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
