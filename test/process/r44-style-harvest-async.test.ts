/**
 * R44-13（四十四轮批 B5）回归——收割异步链轨迹枚举异步化（listTrackedDocsAsync）。
 *
 * 缺陷：harvestStyleCandidatesAsync 源1 顶部仍调同步 listTrackedDocs——git 后端走
 * for-each-ref spawnSync（15s 超时），与 R37-5「HTTP 链不再同步 spawnSync」的收口
 * 注释相悖（R36-5/R37-5 同族漏网：git 无响应（网盘挂载 .git/杀软锁）时阻塞事件
 * 循环最长 15s，本链挂在 style.ts harvest 端点上）。
 *
 * 覆盖：
 * - 异步面：listTrackedDocsAsync 恰好 1 次异步 spawn（for-each-ref）、0 次
 *   spawnSync；harvestStyleCandidatesAsync 全程 0 次 spawnSync
 * - 等价性：listTrackedDocsAsync 与同步孪生同输入同结果（git 后端多 doc + legacy
 *   ref 段反解；版本档案后端委托同步版）；双书同构下 async 收割产物与 sync 逐位一致
 * - 失败面：坏 .git → resolve 空表（永不 reject，轨迹旁路语义不变）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listTrackedDocs,
  listTrackedDocsAsync,
  recordAiVersion,
  recordAiVersionAsync,
} from '../../src/git/ai-track.js'
import {
  harvestStyleCandidates,
  harvestStyleCandidatesAsync,
} from '../../src/process/style-harvest.js'
import { legacyId } from '../../src/document/stable-id.js'
import { readCandidates, CANDIDATES_DIR } from '../../src/format/style-candidate.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { execFileSync } from 'node:child_process'

// 包装 spawn/spawnSync 记录调用（真实实现保留）——断言收割异步链零同步 spawnSync、
// for-each-ref 改走异步 spawn（r37-5 同款机理断言手法）
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) }
})
import { spawn, spawnSync } from 'node:child_process'
const mockSpawn = vi.mocked(spawn)
const mockSpawnSync = vi.mocked(spawnSync)

let root = ''

beforeEach(() => {
  root = mkdtempTracked(join(tmpdir(), 'clw-r44-13-harvest-'))
  mockSpawn.mockClear()
  mockSpawnSync.mockClear()
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/** git init + 身份配置（execFileSync 直连，不经过被计数的 git() 执行器） */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
}

/** 建带 git 轨迹的最小书：正文一章（长作者段 vs AI 版成 gap）+ AI 轨迹 ref。
 *  docId 用树的 legacyId 派生口径（无文档清单时叶子 docId = legacyId(path)），
 *  收割源1 按 docId 反查树路径。 */
const AI_TEXT = 'AI 生成的第一段草稿，用语平淡而机械，节奏均匀没有任何起伏，像是从模板里抄出来的句子。'
const AUTHOR_BODY =
  '雨点砸在铁皮屋檐上，他数到第七声才推门，门轴的锈味混着煤烟扑了满脸，柜台后的老人头也不抬，只把一枚铜纽扣推过桌面。'

function makeTrackedGitBook(dir: string): string {
  mkdirSync(join(dir, '写作', '正文'), { recursive: true })
  mkdirSync(join(dir, '文风'), { recursive: true })
  writeFileSync(join(dir, 'book.yaml'), 'spec_version: 1\nkind: short\nbook:\n  title: 异步收割\n')
  writeFileSync(
    join(dir, '写作', '正文', '001-雨夜.md'),
    `---\n章号: 1\n标题: 雨夜\n---\n\n${AUTHOR_BODY}`,
  )
  writeFileSync(join(dir, '文风', '文风铁律.md'), '# 文风铁律\n- 正文纯文本\n')
  initGitRepo(dir)
  const docId = legacyId('写作/正文/001-雨夜.md')
  recordAiVersion(dir, docId, AI_TEXT)
  return docId
}

describe('R44-13: listTrackedDocsAsync 异步孪生（直接调用面）', () => {
  it('git 后端：恰好 1 次异步 spawn（for-each-ref）、0 次 spawnSync；结果与同步孪生一致（含 legacy ref 段反解）', async () => {
    initGitRepo(root) // git 后端臂：轨迹走 refs/clwriting/ai/*（无 .git 会落版本档案后端）
    recordAiVersion(root, 'doc_A', 'AI 版本一')
    recordAiVersion(root, 'doc_A', 'AI 版本二')
    recordAiVersion(root, 'doc_B', '别的文档')
    recordAiVersion(root, 'legacy:0123456789abcdef', 'legacy 轨迹')

    // 同步孪生先取（消耗 spawnSync 不计入断言窗口）
    const syncList = [...listTrackedDocs(root)].sort()
    mockSpawn.mockClear()
    mockSpawnSync.mockClear()

    const asyncList = await listTrackedDocsAsync(root)

    expect([...asyncList].sort()).toEqual(syncList) // 同输入同结果（顺序随 Set 插入序，排序后比对）
    expect(asyncList).toContain('doc_A')
    expect(asyncList).toContain('doc_B')
    expect(asyncList).toContain('legacy:0123456789abcdef') // legacy:<hex> ref 段反解口径与同步版同源

    expect(mockSpawnSync).toHaveBeenCalledTimes(0) // 修复点：git 后端枚举不再同步 spawnSync
    expect(mockSpawn).toHaveBeenCalledTimes(1) // 恰好一次异步 spawn（for-each-ref）
    expect(mockSpawn.mock.calls[0]![0]).toBe('git')
    expect(mockSpawn.mock.calls[0]![1]).toEqual(['for-each-ref', '--format=%(refname)', 'refs/clwriting/ai/'])
  })

  it('失败面：坏 .git → resolve 空表，永不 reject（旁路证据不阻断主流程）', async () => {
    mkdirSync(join(root, '.git'), { recursive: true }) // 空 .git → for-each-ref 快速失败
    mockSpawnSync.mockClear()
    await expect(listTrackedDocsAsync(root)).resolves.toEqual([])
    expect(mockSpawnSync).toHaveBeenCalledTimes(0) // 失败路径同样只走异步 spawn
  })

  it('版本档案后端（无 git 书库）：委托同步版（本地小文件读），零子进程、结果一致', async () => {
    const plain = mkdtempTracked(join(tmpdir(), 'clw-r44-13-plain-'))
    try {
      await recordAiVersionAsync(plain, 'doc_A', 'AI 版本一')
      mockSpawn.mockClear()
      mockSpawnSync.mockClear()
      const asyncList = await listTrackedDocsAsync(plain)
      expect([...asyncList].sort()).toEqual([...listTrackedDocs(plain)].sort())
      expect(asyncList).toContain('doc_A')
      expect(mockSpawn).toHaveBeenCalledTimes(0)
      expect(mockSpawnSync).toHaveBeenCalledTimes(0)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('R44-13: harvestStyleCandidatesAsync 端到端（收割链清零同步 spawnSync）', () => {
  it('git 后端全书收割：全程 0 次 spawnSync；轨迹枚举 for-each-ref 走异步 spawn', async () => {
    makeTrackedGitBook(root)
    mockSpawn.mockClear()
    mockSpawnSync.mockClear()

    const r = await harvestStyleCandidatesAsync(root, 'short', '2026-09-04')

    expect(mockSpawnSync).toHaveBeenCalledTimes(0) // 修复点：源1 顶部枚举不再漏网
    // 轨迹枚举的 for-each-ref（%(refname) 单列格式）确实经异步 spawn 发出
    const trackedListCall = mockSpawn.mock.calls.find(
      (c) => c[0] === 'git' && (c[1] as string[]).join(' ') === 'for-each-ref --format=%(refname) refs/clwriting/ai/',
    )
    expect(trackedListCall).toBeDefined()
    expect(r.created.length).toBeGreaterThanOrEqual(1) // 轨迹确实被枚举到（gap 段成样章候选）
  })

  it('双书同构：async 收割产物与 sync 孪生逐位一致（created/skipped/候选内容）', async () => {
    const bookA = mkdtempTracked(join(tmpdir(), 'clw-r44-13-twinA-'))
    const bookB = mkdtempTracked(join(tmpdir(), 'clw-r44-13-twinB-'))
    try {
      makeTrackedGitBook(bookA)
      makeTrackedGitBook(bookB) // 同构双书（ref ulid 不同不影响内容信号）

      const syncR = harvestStyleCandidates(bookA, 'short', '2026-09-04')
      const asyncR = await harvestStyleCandidatesAsync(bookB, 'short', '2026-09-04')

      expect(asyncR.created).toHaveLength(syncR.created.length)
      expect(asyncR.skipped).toBe(syncR.skipped)
      expect(syncR.created.length).toBeGreaterThanOrEqual(1) // 非平凡臂：确有候选落盘

      // created 含 ulid 文件名（两书必然不同）→ 比候选内容（机器可复现字段）
      const pick = (bookRoot: string): string[] => {
        const cs = readCandidates(join(bookRoot, CANDIDATES_DIR)).candidates
        return cs
          .map((c) =>
            JSON.stringify([c.类型, c.场景, c.来源, c.正文, c.状态, c.创建, c.章号, c.相似度, c.AI版]),
          )
          .sort()
      }
      expect(pick(bookB)).toEqual(pick(bookA))
    } finally {
      rmSync(bookA, { recursive: true, force: true })
      rmSync(bookB, { recursive: true, force: true })
    }
  })
})
