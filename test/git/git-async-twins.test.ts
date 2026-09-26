/**
 * git 异步孪生（写侧 + 读侧）回归。
 *
 * 档源：原 r36-5-git-async.test.ts（写侧，R36-5）与 r37-5-ai-track-async-read.test.ts
 * （读侧，R37-5）同属「git 执行路径异步化」一族，按被测行为合并；断言逐条保留、
 * 去重 0 条（两文件无语义重复用例）。
 *
 * 写侧（R36-5 三十六轮批 D）：recordAiVersion 异步化——gitAsync / recordAiVersionAsync。
 * - 成功路径：真实临时 git 仓库，gitAsync / recordAiVersionAsync 往返可用
 *   （hash-object + update-ref 两连经异步路径，语义与同步版逐位对齐）
 * - 失败路径（git 报错/不可用）→ 不挂起、resolve ok:false/null 而非 reject
 *   （调用点 await 不落未捕获异常——连写链失败降级语义不变）
 * - 超时有界：注入短超时 + 永不响应/永不发 close 的假子进程 → 在超时档内按失败返回
 *   （不依赖子进程 close 收口：杀软锁 / D-state 等 kill 不生效形态也严格有界）
 * - ENOENT 特判人话（与同步 git() R77-3 同口径）
 * - X-P2-3 版本档案后端（无 git 书库）经异步孪生仍可用
 *
 * 读侧（R37-5 三十七轮批 A）：ai-track 读侧异步孪生（listAiVersionsAsync /
 * readAiVersionAsync）——读侧 listAiVersions（for-each-ref）/ readAiVersion（cat-file）
 * 原走同步 spawnSync，挂在服务 HTTP 请求路径（author-signal ← draft.ts 落盘端点 /
 * self-heal 终稿三连），git 无响应（网盘挂载 .git/杀软锁）时阻塞事件循环最长 15s。
 * - 等价性：真实临时 git 仓，async 版返回与同步版逐位一致（列表/内容/升序）
 * - 异步面：读路径走 spawn（非 spawnSync）——事件循环不冻结的机理断言
 * - 失败面：坏 .git → resolve 空表 / null（永不 reject，轨迹旁路语义不变）
 * - 版本档案后端（无 git 书库）：async list 照常工作（委托同步版本地小文件读）
 * - 端到端：recordAuthorSignal（内部已切 async 读）在 git 书库上信号照常收敛
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitAsync, git, __setGitAsyncTimeoutForTest } from '../../src/git/exec.js'
import {
  recordAiVersionAsync,
  listAiVersions,
  listAiVersionsAsync,
  readAiVersion,
  readAiVersionAsync,
} from '../../src/git/ai-track.js'
import { recordAuthorSignal } from '../../src/ai/author-signal.js'
import { readRuleHits } from '../../src/ai/rule-hits.js'
import { makeGitBook } from '../helpers/book.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 包装 spawn 记录调用（真实实现保留——成功路径仍走真 git）；超时/ENOENT 用例用
// mockImplementationOnce 注入受控假子进程。spawnSync 保持原样（异步面不涉及同步路径）
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

const ORIG_PLATFORM = process.platform

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clwriting-git-async-read-'))
  git(['init'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['config', 'commit.gpgsign', 'false'], root)
})

afterEach(() => {
  __setGitAsyncTimeoutForTest(null)
  Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true })
  if (root) rmSync(root, { recursive: true, force: true })
})

/** RC 源码重审 A-2（Opus-5.5 轮）：git() 统一前置硬化参数（`-c core.fsmonitor=false`
 *  `-c core.hooksPath=…`）——读侧机理断言只关心「哪条子命令走了异步 spawn」，硬化旗
 *  本身的逐字断言在 test/git/exec.test.ts；此处剥掉前置 -c 对。 */
function gitArgsOf(argv: readonly unknown[]): unknown[] {
  const out = [...argv]
  while (out[0] === '-c' && out.length >= 2) out.splice(0, 2)
  return out
}

describe('gitAsync 成功路径（真实 git 仓库）', () => {
  it('rev-parse 往返 ok true + stdout；spawn（而非 spawnSync）被调用（异步路径）', async () => {
    const bookRoot = makeGitBook()
    try {
      mockSpawn.mockClear()
      const r = await gitAsync(['rev-parse', '--is-inside-work-tree'], bookRoot)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.stdout.trim()).toBe('true')
      // 异步路径断言：走的是 spawn 不是 spawnSync（R36-5 关心的就是同步 spawnSync 漏网点）
      expect(mockSpawn).toHaveBeenCalled()
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('hash-object --stdin 输入喂子进程 stdin（recordAiVersion 上游形态）', async () => {
    const bookRoot = makeGitBook()
    try {
      const r = await gitAsync(['hash-object', '-w', '--stdin'], bookRoot, { input: '测试正文内容\n' })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })
})

describe('gitAsync 失败/超时有界', () => {
  it('git 报错（非 0 退出）→ ok:false 人话，不 reject', async () => {
    // 空 .git 目录 = 不是 git 仓库 → git status 快速失败（同 exec.test.ts RB-IF-P1-1 造态）
    const bad = mkdtempTracked(join(tmpdir(), 'clwriting-git-async-bad-'))
    mkdirSync(join(bad, '.git'), { recursive: true })
    const r = await gitAsync(['status', '--porcelain'], bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.humanMsg).toContain('git 操作失败')
  })

  it('超时有界：子进程永不响应/永不 close → 在注入短超时档内按失败返回（不挂起、不依赖 close 收口）', async () => {
    const bookRoot = makeGitBook()
    try {
      __setGitAsyncTimeoutForTest(100)
      const fake = new NeverClosingChild()
      mockSpawn.mockImplementationOnce(() => fake as unknown as ChildProcess)
      const started = Date.now()
      const r = await gitAsync(['rev-parse', 'HEAD'], bookRoot)
      const elapsed = Date.now() - started
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.humanMsg).toContain('git 操作超时')
      expect(elapsed).toBeLessThan(5000) // 远小于同步口 15s；有界断言
      expect(fake.killed).toBe(true) // 超时触发了 kill（best-effort）
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('ENOENT（找不到 git 可执行）→ 人话引导装 Git（与同步 R77-3 同口径），不 reject', async () => {
    // 复审-0913-mac适配 P3-5：三臂全测（r45 platform mock 惯例），与同步口同源断言
    const expectations: Record<'darwin' | 'linux' | 'win32', (msg: string) => void> = {
      darwin: (msg) => {
        expect(msg).toContain('xcode-select --install')
        expect(msg).not.toContain('Git for Windows')
      },
      linux: (msg) => {
        expect(msg).toContain('包管理器')
        expect(msg).not.toContain('Git for Windows')
      },
      win32: (msg) => expect(msg).toContain('Git for Windows'),
    }
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
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
        expectations[platform](r.humanMsg)
      }
    }
  })
})

describe('recordAiVersionAsync（写侧异步孪生）', () => {
  it('成功路径：真 git 书库 hash-object + update-ref 两连 → ref 可查可读回（与同步版语义一致）', async () => {
    const bookRoot = makeGitBook()
    try {
      const content = '第一段。\n\n「他说什么？」\n第二段落。'
      const ref = await recordAiVersionAsync(bookRoot, 'doc_TESTID001', content)
      expect(ref).toMatch(/^refs\/clwriting\/ai\/doc_TESTID001\/[0-9A-Z]{26}$/)
      const versions = listAiVersions(bookRoot, 'doc_TESTID001')
      expect(versions).toHaveLength(1)
      expect(versions[0]!.ref).toBe(ref)
      expect(readAiVersion(bookRoot, 'doc_TESTID001', versions[0]!.sha)).toBe(content)
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })

  it('失败路径：git 报错 → 快速 resolve null（不 reject、不挂起）', async () => {
    // 空 .git 目录 = 坏的 git 书库（hasGitBackend 判 true）→ hash-object 快速失败
    const bad = mkdtempTracked(join(tmpdir(), 'clwriting-git-async-badgit-'))
    mkdirSync(join(bad, '.git'), { recursive: true })
    let value: string | null = 'sentinel'
    let threw: unknown = null
    try {
      value = await recordAiVersionAsync(bad, 'doc_A', '内容')
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
    expect(value).toBeNull()
  })

  it('版本档案后端（无 git 书库）：异步孪生照常落 工作区/.版本，list/read 可回查', async () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-git-async-plain-'))
    const id = await recordAiVersionAsync(plain, 'doc_A', 'AI 版本一')
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const versions = listAiVersions(plain, 'doc_A')
    expect(versions).toHaveLength(1)
    expect(readAiVersion(plain, 'doc_A', versions[0]!.sha)).toBe('AI 版本一')
  })

  it('空内容不记（与同步版逐位对齐）', async () => {
    const bookRoot = makeGitBook()
    try {
      expect(await recordAiVersionAsync(bookRoot, 'doc_A', '   ')).toBeNull()
    } finally {
      rmSync(bookRoot, { recursive: true, force: true })
    }
  })
})

describe('读侧异步孪生与同步版等价', () => {
  it('git 后端：listAiVersionsAsync 与 listAiVersions / readAiVersionAsync 与 readAiVersion 逐位一致', async () => {
    await recordAiVersionAsync(root, 'doc_A', 'AI 版本一')
    await recordAiVersionAsync(root, 'doc_A', 'AI 版本二')
    await recordAiVersionAsync(root, 'doc_B', '别的文档')

    const aSync = listAiVersions(root, 'doc_A')
    const aAsync = await listAiVersionsAsync(root, 'doc_A')
    expect(aAsync).toEqual(aSync) // ref/ulid/sha 全字段一致（升序口径随同步版）
    expect(aAsync).toHaveLength(2)
    expect(await readAiVersionAsync(root, 'doc_A', aAsync[1]!.sha)).toBe('AI 版本二')
    expect(await readAiVersionAsync(root, 'doc_A', aAsync[1]!.sha)).toBe(readAiVersion(root, 'doc_A', aSync[1]!.sha))
    expect(await listAiVersionsAsync(root, 'doc_B')).toHaveLength(1)
    expect(await listAiVersionsAsync(root, 'doc_MISSING')).toEqual([])
  })

  it('读路径走 spawn（非 spawnSync）——HTTP 链上不再同步冻结事件循环', async () => {
    await recordAiVersionAsync(root, 'doc_A', 'AI 版本一')
    mockSpawn.mockClear()
    const versions = await listAiVersionsAsync(root, 'doc_A')
    expect(versions).toHaveLength(1)
    expect(mockSpawn).toHaveBeenCalled() // for-each-ref 经异步 spawn
    await readAiVersionAsync(root, 'doc_A', versions[0]!.sha)
    expect(mockSpawn.mock.calls.some((c) => c[0] === 'git' && gitArgsOf(c[1] as string[])[0] === 'cat-file')).toBe(true)
  })

  it('失败面：坏 .git → 空表 / null，永不 reject（轨迹旁路不阻断主流程）', async () => {
    const bad = mkdtempTracked(join(tmpdir(), 'clwriting-git-async-badgit2-'))
    try {
      mkdirSync(join(bad, '.git'), { recursive: true }) // 空 .git → for-each-ref/cat-file 快速失败
      await expect(listAiVersionsAsync(bad, 'doc_A')).resolves.toEqual([])
      await expect(readAiVersionAsync(bad, 'doc_A', 'deadbeef')).resolves.toBeNull()
    } finally {
      rmSync(bad, { recursive: true, force: true })
    }
  })

  it('版本档案后端（无 git 书库）：async list 照常（委托同步版本地小文件读）', async () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-git-async-plain2-'))
    try {
      await recordAiVersionAsync(plain, 'doc_A', 'AI 版本一')
      await recordAiVersionAsync(plain, 'doc_A', 'AI 版本二')
      const aAsync = await listAiVersionsAsync(plain, 'doc_A')
      expect(aAsync).toEqual(listAiVersions(plain, 'doc_A'))
      expect(aAsync).toHaveLength(2)
      expect(await readAiVersionAsync(plain, 'doc_A', aAsync[1]!.sha)).toBe('AI 版本二')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('recordAuthorSignal 端到端（读侧已切 async 孪生）', () => {
  it('git 书库上作者删除信号照常收敛（读上一版走 listAiVersionsAsync/readAiVersionAsync）', async () => {
    const AI_TEXT = '第一段。\n\n值得一提的是，他走进了房间。\n\n第二段。'
    await recordAiVersionAsync(root, 'doc_SIG', AI_TEXT)
    await recordAuthorSignal(root, 'doc_SIG', '第一段。\n\n第二段。', 'self-heal')
    const hits = readRuleHits(root)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.ruleId).toBe('ai-cliche')
    expect(hits[0]!.hits).toBe(1)
  })
})
