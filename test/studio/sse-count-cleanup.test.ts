/**
 * R-18（第十六轮）回归：删书 / 清空对话清理 per-book SSE 计数。
 *
 * sseConnections 只在 req close 时递减——删书/清空对话成功路径此前不清理，
 * 残留计数会让同名重建书被旧计数顶到 MAX_SSE_PER_BOOK(5) 的 429 上限。
 * 修复：stream.ts 导出 forgetSseCount(bookName)，books.delete 与 chat.clear 成功
 * 路径接线；本测试经 __getSseConnections 观测钩子断言。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { __getSseConnections } from '../../src/studio/server/api/stream.js'

const BOOK = 'SSE计数清理书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const openStreams: AbortController[] = []

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

/** 打开一条 SSE 订阅（保持连接，收尾统一 abort）。 */
async function openStream(name: string): Promise<void> {
  const ac = new AbortController()
  openStreams.push(ac)
  const r = await fetch(
    `${baseUrl}/api/books/${encodeURIComponent(name)}/stream?token=${encodeURIComponent(token)}`,
    { signal: ac.signal },
  )
  expect(r.status).toBe(200)
  expect(r.headers.get('content-type')).toContain('text/event-stream')
  // 挂后台消费，防背压缓冲占满（只要连接活着即可）
  void r.body?.getReader().read().catch(() => { /* abort 后抛错忽略 */ })
}

/** 等计数稳定（连接建立→计数递增是即时的，给一拍事件循环余量）。 */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50))
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-sse-count-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: SSE计数清理书\n  genre: 玄幻\nhost: cc\n',
  )
  server = await startServerSafe({ port: 0, workDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  for (const ac of openStreams) ac.abort()
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

// S2（五十九轮）：原裸数字计数在 chat.clear 直接 delete 后，旧连接 close 回调对新
// 账目 -1（漂移下限 0）——连接上限可被绕空。现按句柄集合记账：clear 销毁该书全部
// 在途连接并同步清账，旧连接 close 对新账目零影响。
describe('S2: SSE 计数按实际存活连接记账（chat.clear 不再 -1 漂移）', () => {
  it('clear 后旧连接 close 不侵蚀新账目；新连接计数从真实存活数起算', async () => {
    // 第一轮：1 条旧连接 + clear（旧连接被销毁、账目清空）
    await openStream(BOOK)
    const acOld = openStreams[openStreams.length - 1]!
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(1)
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
    expect(r.status).toBe(200)
    expect(__getSseConnections().has(BOOK)).toBe(false)
    // 第二轮：clear 后再开 2 条新连接——旧连接（acOld）close 时不得对新账目 -1
    await openStream(BOOK)
    await openStream(BOOK)
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(2)
    acOld.abort() // 旧连接（clear 时已被服务端销毁）迟到的 close 事件到达
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(2) // S2：无漂移
    // 收尾：关闭本轮两条连接，不污染后续 R-18 用例的计数断言
    const acA = openStreams[openStreams.length - 2]!
    const acB = openStreams[openStreams.length - 1]!
    acA.abort()
    acB.abort()
    await tick()
    expect(__getSseConnections().has(BOOK)).toBe(false)
  })
})

describe('R-18: per-book SSE 计数随书级生命周期清理', () => {
  it('清空对话成功 → 计数清零（残留计数会顶 429 上限）', async () => {
    await openStream(BOOK)
    await openStream(BOOK)
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(2) // 连接在途：计数为 2
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/chat/clear`)
    expect(r.status).toBe(200)
    expect(__getSseConnections().has(BOOK)).toBe(false) // R-18：立即清，不等连接散场
  })

  it('删书成功 → 计数清零', async () => {
    await openStream(BOOK)
    await tick()
    expect(__getSseConnections().get(BOOK)).toBe(1)
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`)
    expect(r.status).toBe(200)
    expect(__getSseConnections().has(BOOK)).toBe(false) // R-18：同名重建书不被旧计数顶上限
  })
})

// R65-44（总六十五轮）：rename 清理序列补 forgetSseCount(oldName)（对齐 delete:261 的
// R-18）——改名后旧名残留计数，随后新建同名书 SSE 配额被旧连接占用 429。
describe('R65-44: rename 清理序列补 forgetSseCount(oldName)', () => {
  it('改名成功 → 旧名 SSE 计数随清（在途连接被销毁、账目清空）', async () => {
    // R-18 用例已删除 BOOK——登记一本新书专供改名
    const OLD = '改名计数书'
    const NEW = '改名计数书2'
    const reg = join(workDir, '.clwriting', 'books.jsonl')
    writeFileSync(reg, readFileSync(reg, 'utf8') + JSON.stringify({ name: OLD, path: OLD, kind: 'long' }) + '\n')
    const bookRoot = join(workDir, OLD)
    // 目录结构对齐 beforeAll 的 BOOK fixture（ensureSession/建流路径依赖）；
    // 长篇/ 为 bookStoragePath(long) 的目标父目录（renameSync 需其存在）
    mkdirSync(join(workDir, '长篇'), { recursive: true })
    mkdirSync(join(bookRoot, '定稿', '正文', '第一卷'), { recursive: true })
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    mkdirSync(join(bookRoot, '大纲'), { recursive: true })
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    writeFileSync(
      join(bookRoot, 'book.yaml'),
      'spec_version: 1\nkind: long\nbook:\n  title: 改名计数书\n  genre: 玄幻\nhost: cc\n',
    )
    // 旧名挂一条在途连接（残留计数的前置态）
    await openStream(OLD)
    await tick()
    expect(__getSseConnections().get(OLD)).toBe(1)
    // 改名：修复前旧名计数残留（forgetSseCount 缺席，close 回调也因书已改名无归零通路）
    const r = await req('POST', `/api/books/${encodeURIComponent(OLD)}/rename`, { name: NEW })
    expect(r.status).toBe(200)
    expect(__getSseConnections().has(OLD)).toBe(false) // R65-44：随改名清理
    await tick()
  })
})
