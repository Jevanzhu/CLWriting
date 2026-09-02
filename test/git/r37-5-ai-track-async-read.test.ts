/**
 * R37-5（三十七轮批 A）回归——ai-track 读侧异步孪生（listAiVersionsAsync /
 * readAiVersionAsync）。
 *
 * 缺陷：读侧 listAiVersions（for-each-ref）/ readAiVersion（cat-file）仍走同步
 * spawnSync，调用链挂在服务 HTTP 请求路径（author-signal ← draft.ts 落盘端点 /
 * self-heal 终稿三连）——git 无响应（网盘挂载 .git/杀软锁）时阻塞事件循环最长 15s
 * （写侧 recordAiVersion 已在 R36-5 异步化，读侧漏网）。
 *
 * 覆盖：
 * - 等价性：真实临时 git 仓，async 版返回与同步版逐位一致（列表/内容/升序）
 * - 异步面：读路径走 spawn（非 spawnSync）——事件循环不冻结的机理断言（r36-5 同款）
 * - 失败面：坏 .git → listAiVersionsAsync resolve 空表 / readAiVersionAsync resolve
 *   null（永不 reject，轨迹旁路语义不变）
 * - 版本档案后端（无 git 书库）：async list 照常工作（委托同步版本地小文件读）
 * - 端到端：recordAuthorSignal（内部已切 async 读）在 git 书库上信号照常收敛
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  recordAiVersionAsync,
  listAiVersions,
  listAiVersionsAsync,
  readAiVersion,
  readAiVersionAsync,
} from '../../src/git/ai-track.js'
import { git } from '../../src/git/exec.js'
import { recordAuthorSignal } from '../../src/ai/author-signal.js'
import { readRuleHits } from '../../src/ai/rule-hits.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// 包装 spawn/spawnSync 记录调用（真实实现保留）——断言读侧异步路径用 spawn
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
import { spawn } from 'node:child_process'
const mockSpawn = vi.mocked(spawn)

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clwriting-r37-5-read-'))
  git(['init'], root)
  git(['config', 'user.email', 'test@test.com'], root)
  git(['config', 'user.name', 'test'], root)
  git(['config', 'commit.gpgsign', 'false'], root)
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('R37-5: 读侧异步孪生与同步版等价', () => {
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
    expect(mockSpawn.mock.calls.some((c) => c[0] === 'git' && (c[1] as string[])[0] === 'cat-file')).toBe(true)
  })

  it('失败面：坏 .git → 空表 / null，永不 reject（轨迹旁路不阻断主流程）', async () => {
    const bad = mkdtempTracked(join(tmpdir(), 'clwriting-r37-5-badgit-'))
    try {
      const { mkdirSync } = await import('node:fs')
      mkdirSync(join(bad, '.git'), { recursive: true }) // 空 .git → for-each-ref/cat-file 快速失败
      await expect(listAiVersionsAsync(bad, 'doc_A')).resolves.toEqual([])
      await expect(readAiVersionAsync(bad, 'doc_A', 'deadbeef')).resolves.toBeNull()
    } finally {
      rmSync(bad, { recursive: true, force: true })
    }
  })

  it('版本档案后端（无 git 书库）：async list 照常（委托同步版本地小文件读）', async () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clwriting-r37-5-plain-'))
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

describe('R37-5: recordAuthorSignal 端到端（读侧已切 async 孪生）', () => {
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
