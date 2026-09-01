/**
 * 低级项（第六轮）回归：总览写作热力只统计已定稿章。
 * 写作中的草稿保存也刷 mtime，原先被计入「定稿产出」（热力图/连续天数虚高）。
 * 通过 manifest finalizedRevision 区分：定稿章计数、草稿章不计数；无清单保持全量。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const BOOK = '热力定稿测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: any = null
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-heat-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 热力定稿测试书\n  genre: 玄幻\nhost: cc\n',
  )
  // 两章正文：0001 已定稿（manifest 有 finalizedRevision）、0002 草稿（无）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n定稿正文\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '写作', '正文', '0002-草稿.md'),
    '---\n章号: 2\n标题: 草稿\n---\n\n草稿正文（未定稿）\n',
    'utf8',
  )
  // manifest：header + 两条目（0001 带定稿指纹，0002 无）
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({
        id: 'doc_0001', nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null,
        finalizedRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        finalizedAt: '2026-08-21T00:00:00.000Z',
      }),
      JSON.stringify({ id: 'doc_0002', nodeType: 'document', path: '写作/正文/0002-草稿.md', parentId: null }),
    ].join('\n') + '\n',
    'utf8',
  )

  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(() => {
  server?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('总览热力图：只统计已定稿章', () => {
  it('草稿章不计入 timeline / streak（即便 mtime 同日）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/overview`)
    expect(r.status).toBe(200)
    const timeline: { date: string; count: number }[] = r.json.timeline ?? []
    const total = timeline.reduce((sum, t) => sum + t.count, 0)
    expect(total).toBe(1) // 只有 0001 定稿章；0002 草稿不计数
  })
})
