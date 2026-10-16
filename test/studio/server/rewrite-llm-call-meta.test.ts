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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../../helpers/safe-port.js'
import { openSessionStore, bookHash } from '../../../src/events/store.js'
import { ERROR_CODES } from '../../../src/studio/server/http.js'

let baseUrl = ''
let server: http.Server | undefined
let token = ''
const workDir = mkdtempSync(join(tmpdir(), 'clw-z1-'))
const userDataPath = mkdtempSync(join(tmpdir(), 'clw-z1-ud-'))

function req(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
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
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
            : {}),
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
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外玉佩轻响。',
  )
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    JSON.stringify({ version: 1, type: 'clwriting-manifest' }) +
      '\n' +
      JSON.stringify({ id: 'doc_z1', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null }) +
      '\n',
  )
  // provider 指向不可达端口：runTask 错误尝试照落 llm/call（promptMeta 恒随）
  writeFileSync(
    join(userDataPath, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'p1',
          name: 'dead',
          protocol: 'openai',
          auth: 'bearer',
          baseUrl: 'http://127.0.0.1:1',
          apiKey: 'sk-x',
          caps: { connected: true, streaming: true },
        },
      ],
      currentId: 'p1',
      currentModel: 'm1',
    }),
  )
  server = await startServerSafe({ workDir, port: 0, userDataPath })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await req('GET', '/api/boot')
  token = (boot.text.match(/"token":"([^"]+)"/) ?? [])[1] ?? ''
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
    const r = await req('POST', `/api/books/${encodeURIComponent('书Z')}/documents/doc_z1/rewrite`, {
      instruction: '更紧凑',
    })
    // 不可达 provider → 500 GEN_FAIL（业务失败不影响登记断言）
    expect(r.status).toBe(500)
    const store = openSessionStore(userDataPath, join(workDir, '书Z'))!
    const evs = store.listEvents(bookHash(join(workDir, '书Z')))
    const call = evs.find((e) => e.type === 'llm/call') as
      { data: { promptMeta?: { files?: string[] }; chapter?: number } } | undefined
    expect(call).toBeDefined()
    expect(call!.data.promptMeta!.files).toContain('写作/正文/0001-开篇.md') // Z-1
    expect(call!.data.chapter).toBe(1) // Z-4
  }, 30_000)
})

// ai-version 端点：载荷契约（parse）+ 临界段书注册重验（bookMovedFailure）。
// 前者把「行内 typeof 临时判定」收成同族声明式 parse；后者把 await readJson 窗口内
// 书被改名/删除时对旧捕获路径写入成孤儿 ref 的面挡在 409 BOOK_MOVED。
describe('POST /documents/:docId/ai-version：载荷校验与临界段书注册重验', () => {
  const AI_VERSION = `/api/books/${encodeURIComponent('书Z')}/documents/doc_z1/ai-version`

  it('空载荷 / 纯空白 content → 400 BAD_INPUT（parse 契约拦截，码在词表内）', async () => {
    const empty = await req('POST', AI_VERSION, {})
    expect(empty.status).toBe(400)
    expect((JSON.parse(empty.text) as { code: string }).code).toBe('BAD_INPUT')

    const blank = await req('POST', AI_VERSION, { content: '   ' })
    expect(blank.status).toBe(400)
    expect((JSON.parse(blank.text) as { code: string }).code).toBe('BAD_INPUT')
  })

  it('长度上限取内容档口径：越旧 1MB 缺省、未越 16MB 内容档的大载荷照常受理', async () => {
    // 内容档上限 single source = CONTENT_BODY_LIMIT_BYTES（16MB）——旧 handler 用
    // readJson 缺省 1MB 档会把 2MB 的整章 AI 版拒成 413；本档须按内容档放行。
    const big = '文'.repeat(1_000_000) // ≈3MB UTF-8，越 1MB 缺省、远未越 16MB 内容档
    const r = await req('POST', AI_VERSION, { content: big })
    expect(r.status).toBe(200)
    expect((JSON.parse(r.text) as { ok: boolean }).ok).toBe(true)
  }, 30_000)

  it('超长载荷（越 CONTENT_BODY_LIMIT_BYTES 内容档上限）→ 413 PAYLOAD_TOO_LARGE 且码在词表内', async () => {
    const huge = 'a'.repeat(17 * 1024 * 1024)
    const r = await req('POST', AI_VERSION, { content: huge })
    expect(r.status).toBe(413)
    const code = (JSON.parse(r.text) as { code: string }).code
    expect(code).toBe('PAYLOAD_TOO_LARGE')
    expect(ERROR_CODES).toContain(code)
  }, 30_000)

  it('窗口内书被改名/移走 → 409 BOOK_MOVED（写前重验，不静默落写）', async () => {
    // 书目录搬走但 books.jsonl 登记仍在（改名端点「搬盘先行、登记后改」的窗口形态）：
    // 入口 resolveBookOrReply 读登记仍解析出旧 bookRoot，只有写前 bookMovedFailure
    // 的盘面校验能识破。
    const bookRoot = join(workDir, '书Z')
    const movedRoot = join(workDir, '书Z-moved')
    renameSync(bookRoot, movedRoot)
    try {
      const r = await req('POST', AI_VERSION, { content: 'AI 版正文' })
      expect(r.status).toBe(409)
      const j = JSON.parse(r.text) as { code: string; error: string }
      expect(j.code).toBe('BOOK_MOVED')
      expect(typeof j.error).toBe('string')
    } finally {
      renameSync(movedRoot, bookRoot)
    }
  })
})
