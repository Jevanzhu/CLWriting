/**
 * kk-P1-4 回归：GET /api/books/:name/state 透传 batchPause（连写暂停元状态）。
 *
 * 状态机 buildRecap 早已叠加 batchPause（state.ts），但 API 层 reply 白名单漏带——
 * 前端 WorkbenchView 的「连写暂停在第 N 章」提示永不可达。本测用最小书仓库 +
 * 手落 .auto-batch.json 暂停记录，验证：有记录 → 响应带 batchPause 原样字段；
 * 无记录 → 响应不带该键（条件展开口径）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '暂停透传测试书'

let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET' },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) })
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-kk14-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '工作区', '待定稿'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 暂停透传测试书\nhost: cc\n',
  )

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()))
  rmSync(workDir, { recursive: true, force: true })
})

describe('kk-P1-4: /state 透传 batchPause', () => {
  it('无暂停记录 → 响应不带 batchPause 键', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/state`)
    expect(r.status).toBe(200)
    expect(r.json.batchPause).toBeUndefined()
  })

  it('有暂停记录 → 原样透传 {atChapter, reason, detail}', async () => {
    writeFileSync(
      join(bookRoot, '工作区', '待定稿', '.auto-batch.json'),
      JSON.stringify({ paused: { at_chapter: 3, reason: 'escalate', detail: '第 3 章三审超阈值，上交裁决' } }),
      'utf8',
    )
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/state`)
    expect(r.status).toBe(200)
    expect(r.json.batchPause).toEqual({
      atChapter: 3,
      reason: 'escalate',
      detail: '第 3 章三审超阈值，上交裁决',
    })
  })
})
