/**
 * R67-13 / R67-14 / R67-15（十五轮）服务端纪律回归：
 * - R67-13 编排互斥矩阵补角：self-heal 在途时生成长任务端点（outline 为代表）409 BUSY；
 *   orchestrationBusyFor 单元三态（self-heal/chat/background → 文案；空闲 → null）
 * - R67-14 replyError 单源脱敏：error 文本中的凭据形态在信封出口被 redactSecret 清洗
 * - R67-15 书键 TTL 结果缓存随删书清理：health styleScan 缓存条目随 DELETE 失效
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { ServerResponse } from 'node:http'
import { startServerSafe } from '../helpers/safe-port.js'
import { replyError } from '../../src/studio/server/http.js'
import { orchestrationBusyFor } from '../../src/studio/server/api/task-gate.js'
import { __setSelfHealRunningForTest } from '../../src/ai/orchestrate/self-heal.js'
import { __setSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'
import { __styleScanCacheHasForTest } from '../../src/studio/server/api/health.js'

const BOOK = 'R67纪律书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: any = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r67-disc-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), ['spec_version: 1', 'book:', `  title: ${BOOK}`, '  genre: 玄幻'].join('\n') + '\n', 'utf-8')
  // R70-5：auto-write/chat 端点要求 ctx.userDataPath（缺省 400 NO_USERDATA 先于闸检查）
  mkdirSync(join(workDir, 'userData'), { recursive: true })
  server = await startServerSafe({ port: 0, workDir, userDataPath: join(workDir, 'userData') })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  rmSync(workDir, { recursive: true, force: true })
})

// ── R67-13：编排互斥矩阵 ──────────────────────────────

describe('R67-13: orchestrationBusyFor 互斥矩阵补角', () => {
  it('self-heal 在途 → 拒收文案；收口后 → null', () => {
    __setSelfHealRunningForTest(BOOK, true)
    try {
      expect(orchestrationBusyFor(BOOK)).toMatch(/自愈写稿进行中/)
      expect(orchestrationBusyFor(BOOK)).not.toBeNull()
    } finally {
      __setSelfHealRunningForTest(BOOK, false)
    }
    expect(orchestrationBusyFor(BOOK)).toBeNull()
  })

  it('端点接线：self-heal 在途时 POST outline → 409 BUSY（不再并发生成细纲）', async () => {
    __setSelfHealRunningForTest(BOOK, true)
    try {
      const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, { chapter: 1 })
      expect(r.status).toBe(409)
      expect(r.json?.code).toBe('BUSY')
      expect(String(r.json?.error)).toMatch(/自愈写稿进行中/)
    } finally {
      __setSelfHealRunningForTest(BOOK, false)
    }
  })
})

// ── R67-14：replyError 单源脱敏 ──────────────────────

describe('R67-14: replyError 错误信封单源脱敏', () => {
  function callReplyError(error: string): { status: number; body: string } {
    const calls: Array<{ status: number; body: string }> = []
    const res = {
      writeHead(status: number) {
        calls.push({ status, body: '' })
      },
      end(body: string) {
        calls[0]!.body = body
      },
    } as unknown as ServerResponse
    replyError(res, 500, 'GEN_FAIL', error)
    return calls[0]!
  }

  it('错误文本中的 API Key 形态被清洗（裸 key / URL query / Bearer）', () => {
    const r = callReplyError(`请求失败: sk-abcdef0123456789abcdef01 和 https://gw.example.com/v1?api_key=topsecret123 以及 Bearer eyJhbGciOi.9999`)
    const env = JSON.parse(r.body) as { error: string }
    expect(env.error).not.toContain('sk-abcdef0123456789abcdef01')
    expect(env.error).not.toContain('topsecret123')
    expect(env.error).not.toContain('eyJhbGciOi')
    expect(env.error).toContain('***REDACTED***')
    // 人话部分保留
    expect(env.error).toContain('请求失败')
  })

  it('幂等：已脱敏文本再过出口不变；正常人话不受影响', () => {
    const once = callReplyError('上游报错 sk-abcdef0123456789abcdef01 泄漏')
    const twice = callReplyError(JSON.parse(once.body).error)
    expect(JSON.parse(twice.body).error).toBe(JSON.parse(once.body).error)
    const plain = callReplyError('本书已有分析任务在跑，请等待完成后再试')
    expect(JSON.parse(plain.body).error).toBe('本书已有分析任务在跑，请等待完成后再试')
  })
})

// ── R67-15：书键 TTL 缓存随删书清理 ──────────────────

describe('R67-15: health styleScan 缓存随删书失效', () => {
  it('GET health/style 填充缓存 → DELETE 书 → 缓存条目清除（TTL 外正向失效）', async () => {
    const bookRoot = join(workDir, BOOK)
    // 预置一章定稿让扫描有内容（book 目录已建；空书也可，扫描空目录返回空样本）
    writeFileSync(join(bookRoot, '写作', '正文', '1-章一.md'), '---\n章号: 1\n标题: 章一\n---\n正文内容。', 'utf-8')
    const h = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/health/style`)
    expect(h.status).toBe(200)
    expect(__styleScanCacheHasForTest(bookRoot)).toBe(true) // 端点填充

    const d = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(d.status).toBe(200)
    expect(__styleScanCacheHasForTest(bookRoot)).toBe(false) // 删书清理（R67-15 接线）
  })
})

describe('R70-3/R70-5: 互斥矩阵补角（rewrite×spawn 反向 / auto-write·chat×生成闸）', () => {
  // R67-15 用例已删除 BOOK——本组自建独立书（books.jsonl 追加 + 目录 + book.yaml）
  const BOOK2 = 'R70互斥书'
  beforeAll(async () => {
    const line = JSON.stringify({ name: BOOK2, path: BOOK2, kind: 'long' }) + '\n'
    appendFileSync(join(workDir, '.clwriting', 'books.jsonl'), line)
    const root2 = join(workDir, BOOK2)
    mkdirSync(join(root2, '写作', '正文'), { recursive: true })
    writeFileSync(join(root2, 'book.yaml'), ['spec_version: 1', 'book:', `  title: ${BOOK2}`, '  genre: 玄幻'].join('\n') + '\n', 'utf-8')
  })

  it('R70-3：spawn 在途 → POST /documents/:id/rewrite 409 BUSY（手动写稿文案）', async () => {
    __setSpawnRunning(BOOK2, true)
    try {
      const r = await req('POST', `/api/books/${encodeURIComponent(BOOK2)}/documents/doc_x/rewrite`, {
        instruction: '压缩',
      })
      expect(r.status).toBe(409)
      expect(r.json.error).toContain('手动写稿')
    } finally {
      __setSpawnRunning(BOOK2, false)
    }
  })

  it('R70-5：生成任务闸（outline）在途 → POST auto-write / chat.send 均 409 BUSY', async () => {
    const release = acquireTaskGate(BOOK2, 'outline')
    expect(release).not.toBeNull()
    try {
      const aw = await req('POST', `/api/books/${encodeURIComponent(BOOK2)}/auto-write`, { chapter: 1 })
      expect(aw.status).toBe(409)
      expect(aw.json.error).toContain('任务在跑')
      const ch = await req('POST', `/api/books/${encodeURIComponent(BOOK2)}/chat`, { message: '你好' })
      expect(ch.status).toBe(409)
      expect(ch.json.error).toContain('任务在跑')
    } finally {
      release!()
    }
  })
})
