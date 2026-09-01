/**
 * R36-5（三十六轮批 D）：recordAiVersion 异步化回归——异步 git 执行路径（gitAsync）
 * 与 recordAiVersionAsync。
 *
 * 覆盖：
 * - 成功路径：真实临时 git 仓库，gitAsync / recordAiVersionAsync 往返可用
 *   （hash-object + update-ref 两连经异步路径，语义与同步版逐位对齐）
 * - 失败路径（git 报错/不可用）→ 不挂起、resolve ok:false/null 而非 reject
 *   （调用点 await 不落未捕获异常——连写链失败降级语义不变）
 * - 超时有界：注入短超时 + 永不响应/永不发 close 的假子进程 → 在超时档内按失败返回
 *   （不依赖子进程 close 收口：杀软锁 / D-state 等 kill 不生效形态也严格有界）
 * - ENOENT 特判人话（与同步 git() R77-3 同口径）
 * - X-P2-3 版本档案后端（无 git 书库）经异步孪生仍可用
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitAsync, __setGitAsyncTimeoutForTest } from '../../src/git/exec.js'
import { recordAiVersionAsync, listAiVersions, readAiVersion } from '../../src/git/ai-track.js'
import { makeGitBook } from '../helpers/book.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 包装 spawn 记录调用（真实实现保留——成功路径仍走真 git）；超时/ENOENT 用例用
// mockImplementationOnce 注入受控假子进程。spawnSync 保持原样（本文件不涉及同步面）
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
const mockSpawn = vi.mocked(spawn)

/** 假子进程：stdout/stderr/stdin 用 PassThrough（duck-type stream），kill 只记标记、
 *  不发 close——专门验证「子进程永不收口」形态下 gitAsync 仍由超时定时器有界收口。 */
class NeverClosingChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = {
    on: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  }
  killed = false
  kill(): boolean {
    this.killed = true
    return true // 不 emit close：模拟 kill 不生效/进程忽略信号的最坏形态
  }
}

afterEach(() => {
  __setGitAsyncTimeoutForTest(null)
})

describe('gitAsync 成功路径（真实 git 仓库）', () => {
  it('rev-parse 往返 ok true + stdout；spawn（而非 spawnSync）被调用（异步路径）', async () => {
    const root = makeGitBook()
    try {
      mockSpawn.mockClear()
      const r = await gitAsync(['rev-parse', '--is-inside-work-tree'], root)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.stdout.trim()).toBe('true')
      // 异步路径断言：走的是 spawn 不是 spawnSync（R36-5 关心的就是同步 spawnSync 漏网点）
      expect(mockSpawn).toHaveBeenCalled()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hash-object --stdin 输入喂子进程 stdin（recordAiVersion 上游形态）', async () => {
    const root = makeGitBook()
    try {
      const r = await gitAsync(['hash-object', '-w', '--stdin'], root, { input: '测试正文内容\n' })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('gitAsync 失败/超时有界', () => {
  it('git 报错（非 0 退出）→ ok:false 人话，不 reject', async () => {
    // 空 .git 目录 = 不是 git 仓库 → git status 快速失败（同 exec.test.ts RB-IF-P1-1 造态）
    const bad = mkdtempTracked(join(tmpdir(), 'clwriting-r36-5-bad-'))
    mkdirSync(join(bad, '.git'), { recursive: true })
    const r = await gitAsync(['status', '--porcelain'], bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.humanMsg).toContain('git 操作失败')
  })

  it('超时有界：子进程永不响应/永不 close → 在注入短超时档内按失败返回（不挂起、不依赖 close 收口）', async () => {
    const root = makeGitBook()
    try {
      __setGitAsyncTimeoutForTest(100)
      const fake = new NeverClosingChild()
      mockSpawn.mockImplementationOnce(() => fake as unknown as ChildProcess)
      const started = Date.now()
      const r = await gitAsync(['rev-parse', 'HEAD'], root)
      const elapsed = Date.now() - started
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.humanMsg).toContain('git 操作超时')
      expect(elapsed).toBeLessThan(5000) // 远小于同步口 15s；有界断言
      expect(fake.killed).toBe(true) // 超时触发了 kill（best-effort）
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ENOENT（找不到 git 可执行）→ 人话引导装 Git（与同步 R77-3 同口径），不 reject', async () => {
    const fake = new NeverClosingChild()
    mockSpawn.mockImplementationOnce(() => {
      process.nextTick(() => {
        fake.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
      })
      return fake as unknown as ChildProcess
    })
    const r = await gitAsync(['status'], tmpdir())
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.humanMsg).toContain('未检测到 Git')
      expect(r.humanMsg).toContain('Git for Windows')
    }
  })
})

describe('recordAiVersionAsync（R36-5 异步孪生）', () => {
  it('成功路径：真 git 书库 hash-object + update-ref 两连 → ref 可查可读回（与同步版语义一致）', async () => {
    const root = makeGitBook()
    try {
      const content = '第一段。\n\n「他说什么？」\n第二段落。'
      const ref = await recordAiVersionAsync(root, 'doc_TESTID001', content)
      expect(ref).toMatch(/^refs\/clwriting\/ai\/doc_TESTID001\/[0-9A-Z]{26}$/)
      const versions = listAiVersions(root, 'doc_TESTID001')
      expect(versions).toHaveLength(1)
      expect(versions[0]!.ref).toBe(ref)
      expect(readAiVersion(root, 'doc_TESTID001', versions[0]!.sha)).toBe(content)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('失败路径：git 报错 → 快速 resolve null（不 reject、不挂起）', async () => {
    // 空 .git 目录 = 坏的 git 书库（hasGitBackend 判 true）→ hash-object 快速失败
    const root = mkdtempTracked(join(tmpdir(), 'clwriting-r36-5-badgit-'))
    mkdirSync(join(root, '.git'), { recursive: true })
    let value: string | null = 'sentinel'
    let threw: unknown = null
    try {
      value = await recordAiVersionAsync(root, 'doc_A', '内容')
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(value).toBeNull()
  })

  it('版本档案后端（无 git 书库）：异步孪生照常落 工作区/.版本，list/read 可回查', async () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-r36-5-plain-'))
    const id = await recordAiVersionAsync(plain, 'doc_A', 'AI 版本一')
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const versions = listAiVersions(plain, 'doc_A')
    expect(versions).toHaveLength(1)
    expect(readAiVersion(plain, 'doc_A', versions[0]!.sha)).toBe('AI 版本一')
  })

  it('空内容不记（与同步版逐位对齐）', async () => {
    const root = makeGitBook()
    try {
      expect(await recordAiVersionAsync(root, 'doc_A', '   ')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})