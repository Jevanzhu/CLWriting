/**
 * R26-61（二十六轮）回归：rag-build 收尾回调 set 前复检书仍注册。
 *
 * 背景：ragBuildTasks 模块级任务表挂书名键，删书/改名经 forgetRagBuildTask 清条目；
 * buildIndex 落定晚于清理时，收尾回调的无条件 set 会把已清条目「复活」成死状态
 * （同名重建书 /rag/status 读到陈旧 lastResult）。修复后收尾 set 前经 resolveBook
 * 复检书仍注册，已删则丢弃结果。
 *
 * 驱动方式：桩 buildIndex 为手动放行的 Deferred（真实 build + embed 桩下落定时机
 * 不可控）；「书已删」用直接改写 books.jsonl + 删目录构造——服务端 DELETE 在闸持有
 * 期本就被 busyGate 409（M-4 闸后复查），本测复现的是评审指出的清理已完成、任务
 * 收尾在后的窗口（跨进程删除/未来重构均可落入）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { forgetRagBuildTask } from '../../src/studio/server/api/rag.js' // 删书/改名侧清理入口（books.ts 同款）

const R26 = vi.hoisted(() => ({
  /** Deferred 放行柄：buildIndex 桩挂起，测试显式放行结果 */
  release: null as null | ((result: unknown) => void),
}))

vi.mock('../../src/rag/index.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/rag/index.js')>()
  return {
    ...orig,
    buildIndex: () =>
      new Promise((resolve) => {
        R26.release = (result: unknown) => resolve(result)
      }),
  }
})

const BOOK = 'R26复活书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function bookYaml(): string {
  return 'spec_version: 1\nkind: long\nbook:\n  title: R26复活书\n  genre: 玄幻\nhost: cc\nrag:\n  enabled: true\n  endpoint: http://stub-legacy\n  model: stub-model\n'
}

function registerBook(): void {
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  mkdirSync(join(workDir, BOOK), { recursive: true })
  writeFileSync(join(workDir, BOOK, 'book.yaml'), bookYaml())
}

function unregisterBook(): void {
  rmSync(join(workDir, BOOK), { recursive: true, force: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), '')
}

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
  workDir = mkdtempSync(join(tmpdir(), 'clw-r26-rag-revive-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  // 旧版内联 RAG 配置 + rag.secret 落 key（rag-api.test.ts 同款前置，走 legacy 回落）
  writeFileSync(join(workDir, '.clwriting', 'rag.secret'), 'sk-r26-legacy-key\n', 'utf8')
  registerBook()

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  token = ((await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }).token
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('R26-61: rag-build 收尾回调不复活已删书的任务条目', () => {
  it('书删除后 buildIndex 才落定 → 不复活条目；同名重建书 status 不见陈旧 lastResult', async () => {
    // 1. 触发建索引（后台 Deferred 挂起，闸持有中）
    const build = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/rag/build`, {})
    expect(build.status).toBe(200)
    expect(R26.release).not.toBeNull()

    // 2. 任务在途期间书被删：forgetRagBuildTask 清任务表条目（books.ts 删书/改名
    // 同款调用）+ 登记移除 + 目录删除
    forgetRagBuildTask(BOOK)
    unregisterBook()
    expect(existsSync(join(workDir, BOOK))).toBe(false)

    // 3. buildIndex 此刻才落定——收尾回调复检书已不在注册表，丢弃结果
    R26.release!({ ok: true, chunkCount: 0, chapterCount: 0 })
    await new Promise((r) => setTimeout(r, 50)) // 等 then/finally 微任务链走完

    // 4. 同名重建书 → status 不得读到被复活的陈旧 lastResult
    registerBook()
    const status = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/rag/status`)
    expect(status.status).toBe(200)
    const j = status.json as { running: boolean; lastResult: unknown }
    expect(j.running).toBe(false)
    expect(j.lastResult).toBeNull()
  })
})
