/**
 * P1-10 回归：server 启动链书库自愈（repairBooks 接线）。
 *
 * 修复前：repairBooks（books.jsonl 损坏/移书后扫描重建登记）零生产调用方——
 * 登记损坏后作者无路触发自愈（CLI 入口已删），书架静默丢书。修复后 startServer
 * 启动期幂等执行一次：登记完好 no-op 不写盘；缺失/损坏时扫描重建。
 * 本测试验证「磁盘有书、books.jsonl 缺失」→ 启动后书架可见该书 + 登记已落盘。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

let workDir = ''
let server: http.Server | undefined
let baseUrl = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-srvrepair-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  // 磁盘有完整书仓库（book.yaml + 一章正文），但 books.jsonl 缺失——模拟登记损坏/被删
  const bookRoot = join(workDir, '长篇', '失联书')
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 失联书\n  genre: 玄幻\nhost: cc\n',
    'utf8',
  )
  writeFileSync(join(bookRoot, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文。\n')

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('P1-10 server 启动书库自愈', () => {
  it('books.jsonl 缺失 → 启动 repair 重建登记，书架可见该书 + 登记落盘', async () => {
    const r = await fetch(`${baseUrl}/api/books`)
    expect(r.status).toBe(200)
    const json = (await r.json()) as { books: { name: string; title: string }[] }
    expect(json.books.some((b) => b.title === '失联书')).toBe(true)
    // 自愈产物落盘：books.jsonl 已被重建
    expect(existsSync(join(workDir, '.clwriting', 'books.jsonl'))).toBe(true)
  })
})
