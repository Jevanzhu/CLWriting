/**
 * R75-D-P3a（批 D）回归：/relations/mine 补编排互斥（orchestrationBusyFor）。
 *
 * 对照 analyze/autotag/infer-meta/analyze-style/outline/onboard-ai/lead-updates 同族：
 * 写稿系编排（self-heal/对话/手动写稿/后台收尾）在途时，关系梳理（分钟级 AI +
 * relations.json 覆盖写、输入含正文节选/角色卡）应 409 BUSY——防覆盖写落盘 +
 * 后续章拿到混合态上下文（R67-13 互斥矩阵补角）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { __setSelfHealRunningForTest } from '../../src/ai/orchestrate/self-heal.js'

const BOOK = 'R75关系互斥书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r75-relmutex-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: R75关系互斥书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n')
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  __setSelfHealRunningForTest(BOOK, false) // 兜底清理，防注入态泄漏到同进程其它用例
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R75-D-P3a：/relations/mine 编排互斥', () => {
  it('self-heal 写稿在途 → 409 BUSY（文案含写稿进行中）；解除后过闸（400 无梳理材料）', async () => {
    __setSelfHealRunningForTest(BOOK, true)
    const busy = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(busy.status).toBe(409)
    expect((busy.json as { error: string }).error).toContain('写稿进行中')

    __setSelfHealRunningForTest(BOOK, false)
    // 空书无梳理材料 → 400 BAD_INPUT（非 409 即证明过了互斥闸 + 自身 action 闸）
    const ok = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/relations/mine`, { force: true })
    expect(ok.status).toBe(400)
    expect((ok.json as { error: string }).error).toContain('没有可梳理的材料')
  })
})
