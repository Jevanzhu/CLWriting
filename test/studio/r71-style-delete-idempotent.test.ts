/**
 * R71-11（总七十一轮）style 删条目幂等回归：
 * 条目已不存在时 statSync(safe.abs) ENOENT 裸抛 → dispatch 兜底 500。修复后按不存在
 * 处理（幂等删除 200，与 rmSync force 语义一致）；目录形态递归删（R70-23）不回归。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'

const BOOK = 'R71删条目书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clw-r71-style-del-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '文风', '条目', '手法'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R71删条目书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R71-11: DELETE /style/entries 幂等（不存在条目不再 500）', () => {
  it('删除从未存在的条目路径 → 200（修复前 statSync ENOENT 裸抛 500）', async () => {
    const p = '文风/条目/手法/不存在-001.md'
    expect(existsSync(join(bookRoot, p))).toBe(false)
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: p })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true })
  })

  it('删除已存在条目 → 200 且落盘删除；重复删同一（已消失）条目 → 仍 200 幂等', async () => {
    const p = '文风/条目/手法/通用-001.md'
    writeFileSync(join(bookRoot, p), '---\n场景: 通用\n---\n对话不用提示语。', 'utf-8')
    const first = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: p })
    expect(first.status).toBe(200)
    expect(existsSync(join(bookRoot, p))).toBe(false)

    // 第二次删除（条目已不在）——幂等 200，不再 500
    const second = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: p })
    expect(second.status).toBe(200)
    expect(second.json).toMatchObject({ ok: true })
  })

  it('目录形态条目（R70-23）递归删不回归', async () => {
    const dirRel = '文风/条目/样章'
    mkdirSync(join(bookRoot, dirRel, '战斗'), { recursive: true })
    writeFileSync(join(bookRoot, dirRel, '战斗', '战斗-001.md'), '刀光没入雪雾。', 'utf-8')
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: dirRel })
    expect(r.status).toBe(200)
    expect(existsSync(join(bookRoot, dirRel))).toBe(false)
  })
})
