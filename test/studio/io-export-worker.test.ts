/**
 * B-23 + B-24（第六十轮补修）回归：
 *
 * - B-24：/export 端点改经 worker 线程执行同步导出内核（此前直调 exportBook，
 *   大书导出独占服务进程事件循环——全部书的 SSE 心跳/保存停摆；S3 task-gate 只
 *   闸每书并发数）。本文件以**真实 worker 往返**断言成功/业务失败两路域契约，
 *   另直测 run-async 超时拒绝与非阻塞语义（注入慢 worker）。
 * - B-23：业务失败回 422 {code:'EXPORT_FAILED', error} 错误信封——原 200
 *   {ok:false} 是全域错误信封唯一豁免点（「apiJson 吞诊断」旧理由已被 dv-01
 *   错误信封判别取代）；前端侧对齐见 test/studio/webnext/api-io.test.ts。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { runExportBookAsync } from '../../src/export/run-async.js'

const BOOK_OK = '导出worker测试书'
const BOOK_EMPTY = '导出空书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
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
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-export-worker-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [BOOK_OK, BOOK_EMPTY].map((n) => JSON.stringify({ name: n, path: n, kind: 'long' })).join('\n') + '\n',
  )
  const okRoot = join(workDir, BOOK_OK)
  mkdirSync(join(okRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(okRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 导出worker测试书\n  genre: 玄幻\nhost: cc\n')
  writeFileSync(join(okRoot, '写作', '正文', '1-第一章.md'), '---\n章号: 1\n标题: 第一章\n---\n雪落在了城墙上。')
  // 空书：book.yaml 在、无 写作/正文 目录 → exportBook 业务失败「没有定稿正文可导出」
  const emptyRoot = join(workDir, BOOK_EMPTY)
  mkdirSync(emptyRoot, { recursive: true })
  writeFileSync(join(emptyRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 导出空书\n  genre: 玄幻\nhost: cc\n')
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

describe('B-24: /export 经 worker 线程执行（真实 worker 往返）', () => {
  it('有定稿正文 → 200 域形状（chapterCount/unit/files，worker 内核执行）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK_OK)}/export`, { format: 'merged' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; chapterCount?: number; unit?: string }
    expect(body.ok).toBe(true)
    expect(body.chapterCount).toBe(1)
    expect(body.unit).toBe('章')
  })

  it('B-23: 无定稿正文 → 422 EXPORT_FAILED 错误信封（原 200 {ok:false} 豁免点收口）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK_EMPTY)}/export`, { format: 'both' })
    expect(r.status).toBe(422)
    const body = r.json as { code: string; error: string }
    expect(body.code).toBe('EXPORT_FAILED')
    expect(body.error).toBe('没有定稿正文可导出。')
  })
})

describe('B-24: runExportBookAsync 直测（注入 workerUrl/timeoutMs）', () => {
  it('超时拒绝：慢 worker（300ms）× timeoutMs 20 → 抛「导出超时」且终止线程', async () => {
    const slow = new URL('./io-export-slow-worker.ts', import.meta.url)
    await expect(
      runExportBookAsync({ bookRoot: '/nonexistent', format: 'merged', platform: 'generic' }, { workerUrl: slow, timeoutMs: 20 }),
    ).rejects.toThrow('导出超时')
  })

  it('非阻塞语义：慢 worker 在途期间事件循环可推进（定时器先于导出完成）', async () => {
    const slow = new URL('./io-export-slow-worker.ts', import.meta.url)
    const pending = runExportBookAsync(
      { bookRoot: '/nonexistent', format: 'merged', platform: 'generic' },
      { workerUrl: slow, timeoutMs: 5_000 },
    )
    let ticked = false
    await new Promise((r) => setTimeout(() => { ticked = true; r(null) }, 50))
    expect(ticked).toBe(true) // 若同步内核仍在服务线程，此 await 前的定时器无法兑现
    const result = await pending
    expect(result).toEqual({ ok: true, via: 'slow-worker' })
  })
})
