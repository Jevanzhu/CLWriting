/**
 * G3 验收：overview state 缓存 + 本地数据完整性。
 * detectState 内部全量 rebuild index.db（clearAllTables 清空重建），G3 加 TTL 缓存避免每请求全量扫。
 * 验证：overview 返回完整结构（state 不阻塞本地数据）+ 连续请求 state 一致（缓存透明不报错）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = 'G3测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function get(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
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
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-g3-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: G3测试书\n  genre: 玄幻\nhost: cc\n',
  )
  // 定稿章让 rebuild 有内容可扫
  mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, '定稿', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文一二三\n',
    'utf8',
  )
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('G3：overview state 缓存 + 本地数据完整', () => {
  it('overview 返回完整结构（identity/progress/state/volumes/timeline 齐全）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    expect(r.status).toBe(200)
    const j = r.json as {
      identity: unknown
      progress: unknown
      state: unknown
      volumes: unknown
      timeline: unknown
    }
    expect(j.identity).toBeDefined()
    expect(j.progress).toBeDefined()
    expect(j.state).toBeDefined()
    expect(j.volumes).toBeDefined()
    expect(j.timeline).toBeDefined()
  })

  it('state 字段含 state/name（判定有结果，非崩溃）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    const j = r.json as { state: { state: number; name: string } }
    expect(typeof j.state.state).toBe('number')
    expect(typeof j.state.name).toBe('string')
  })

  it('连续两次 overview state 一致（缓存透明不报错）', async () => {
    const r1 = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    const r2 = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    const j1 = r1.json as { state: { state: number } }
    const j2 = r2.json as { state: { state: number } }
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(j1.state.state).toBe(j2.state.state)
  })

  it('progress 本地数据不受 state 判定影响（定稿章计数）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    const j = r.json as { progress: { chapters: number; words: number } }
    expect(j.progress.chapters).toBe(1)
    expect(j.progress.words).toBeGreaterThan(0)
  })
})
