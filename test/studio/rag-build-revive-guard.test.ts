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
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（初始登记/目录/book.yaml 同
 * 形态先落盘后起服）；rag.secret 改在起服后、首请求前落 key——readApiKey 经
 * resolveRag 请求时惰性读盘（src/rag/resolve.ts），落 key 时机先后等价。中途
 * unregisterBook/registerBook 的 books.jsonl 直改原样保留（workDir 改绑 harness）。
 */
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
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
let studio!: StudioHarness
let workDir = '' // = studio.workDir（测试精简批改绑 harness）

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

beforeAll(async () => {
  studio = await bootStudio({ book: BOOK, bookYaml: bookYaml(), prefix: 'clw-r26-rag-revive-' })
  workDir = studio.workDir
  // 旧版内联 RAG 配置 + rag.secret 落 key（rag-api.test.ts 同款前置，走 legacy 回落）；
  // 起服后、首请求前落 key 与先落盘后起服等价（readApiKey 请求时惰性读盘，见头注）
  writeFileSync(join(workDir, '.clwriting', 'rag.secret'), 'sk-r26-legacy-key\n', 'utf8')
})

afterAll(async () => {
  await studio.close()
})

describe('R26-61: rag-build 收尾回调不复活已删书的任务条目', () => {
  it('书删除后 buildIndex 才落定 → 不复活条目；同名重建书 status 不见陈旧 lastResult', async () => {
    // 1. 触发建索引（后台 Deferred 挂起，闸持有中）
    const build = await studio.req('POST', `/api/books/${encodeURIComponent(BOOK)}/rag/build`, {})
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
    const status = await studio.req('GET', `/api/books/${encodeURIComponent(BOOK)}/rag/status`)
    expect(status.status).toBe(200)
    const j = status.json as { running: boolean; lastResult: unknown }
    expect(j.running).toBe(false)
    expect(j.lastResult).toBeNull()
  })
})
