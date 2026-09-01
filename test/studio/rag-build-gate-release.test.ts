/**
 * dd 批 4-2 残回归 —— startRagBuild 同步准备段抛出时任务闸必须释放。
 *
 * 修复前：占闸后的同步段（readRagConfig → resolveRag → 验 key）若中途抛出（如读配置
 * 崩溃），闸不释放 → 该书从此所有 rag-build 永远 409 死锁（重启才能解）。修复后同步段
 * 包 try/finally，未交接后台任务的一切出口（含异常上抛）都放闸。本文件 vi.mock
 * readRagConfig 定点抛错构造该路径，断言：500（dispatch 兜底，统一 { error } 信封）+
 * 闸已释放（isTaskGateHeld）+ 重试不再 409。书不配 rag 段 → 重试走「未启用」400，
 * 无需桩 embed、不联网。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServerSafe } from '../helpers/safe-port.js'
import { isTaskGateHeld } from '../../src/studio/server/api/task-gate.js'

// 定点故障开关：true 时 readRagConfig 抛错（vi.hoisted 保证 mock 工厂先行可用；
// 默认透传原实现，不影响同进程其他导入方）
const failRagConfig = vi.hoisted(() => ({ next: false }))
vi.mock('../../src/rag/config.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/rag/config.js')>()
  return {
    ...orig,
    readRagConfig: (bookRoot: string, userDataPath?: string | null) => {
      if (failRagConfig.next) throw new Error('模拟同步段崩溃：读 RAG 配置抛出')
      return orig.readRagConfig(bookRoot, userDataPath)
    },
  }
})

const BOOK = '闸残测书'
let workDir = ''
let userData = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function api(path: string, init?: RequestInit): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}${path}`, {
    ...init,
    headers: { 'x-studio-token': token, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-rag-gate-'))
  userData = mkdtempSync(join(tmpdir(), 'clwriting-rag-gate-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  // 登记名 = book.yaml title = 目录名（启动 repair 以 title 为真相源，构造对齐避免被改）
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  // 故意不配 rag 段：透传时 readRagConfig → { enabled: false }，重试走 400 前置校验
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    `spec_version: 1\nkind: long\nbook:\n  title: ${BOOK}\n  genre: 玄幻\nhost: cc\n`,
    'utf8',
  )
  server = await startServerSafe({ port: 0, workDir, userDataPath: userData })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) {
    // 强制断开 keep-alive 空闲连接，防 close 回调因连接池挂起
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userData) rmSync(userData, { recursive: true, force: true })
})

describe('rag-build 同步段异常放闸（dd 批 4-2 残）', () => {
  it('同步段抛出 → 500 + 闸已释放；重试不再 409 死锁', async () => {
    // 前置：闸未被持有（隔离其他用例可能残留的后台任务）
    expect(isTaskGateHeld(BOOK, 'rag-build')).toBe(false)

    failRagConfig.next = true
    const boom = await api('/rag/build', { method: 'POST', body: '{}' })
    // 异常上抛由 dispatch 兜底 500（统一 { error } 信封，不泄漏原始异常细节）
    expect(boom.status).toBe(500)
    expect(String(boom.json['error'])).toContain('内部错误')
    // 核心回归点：修复前此处闸仍被持有（true）→ 后续所有 rag-build 409 死锁
    expect(isTaskGateHeld(BOOK, 'rag-build')).toBe(false)

    failRagConfig.next = false
    const retry = await api('/rag/build', { method: 'POST', body: '{}' })
    // 死锁的核心症状是重试 409（「已在运行中」）；实际走「未启用」400 证明闸已放、流程正常
    expect(retry.status).not.toBe(409)
    expect(retry.status).toBe(400)
    expect(String(retry.json['error'])).toContain('知识检索未启用')
  })
})
