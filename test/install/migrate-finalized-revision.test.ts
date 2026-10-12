/**
 * 定稿基线迁移（异步孪生）行为回归。
 *
 * 迁移链的唯一消费方是启动段（layout-migrations → studio/server 组装根的 listen
 * 前段），而迁移判定要跑一次 git status。同步 spawnSync 在网盘挂载 / 杀软锁 .git 时
 * 会把服务进程事件循环连续占满（单次上限 15s），逐书叠加即启动整体停摆。本文件末尾
 * 对「慢 git 期间事件循环可让出」的断言锚此：git 读走异步孪生（spawn + 有界超时），
 * 迁移照常完成序不变；同步实现下事件循环被占满，该断言即红。
 */

import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { migrateFinalizedRevisionsAsync } from '../../src/install/migrate-finalized-revision.js'
import { readManifest, writeManifest } from '../../src/document/manifest.js'

// 包装 spawn/spawnSync 记录调用（真实实现保留——其它用例照走真 git）：
// 慢 git 用例以 mockImplementationOnce 注入受控慢子进程，并断言迁移期间
// 同步 spawnSync 零调用（有调用 = 迁移把事件循环同步占满）。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) }
})
import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
const mockSpawn = vi.mocked(spawn)
const mockSpawnSync = vi.mocked(spawnSync)

/** 慢子进程：stallMs 后吐 stdout 再按 exitCode 退出（模拟网盘挂载 .git 下的 git
 *  status 迟缓/后续失败——两种形态都不得同步冻住事件循环）。 */
class SlowGitChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = {
    on: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  }
  constructor(stdoutText: string, stallMs: number, exitCode = 0) {
    super()
    setTimeout(() => {
      this.stdout.write(stdoutText)
      this.emit('close', exitCode)
    }, stallMs)
  }
}

let tmp: string
beforeEach(() => {
  tmp = mkdtempTracked(join(tmpdir(), 'clw-migrate-fin-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 写文件 + 建 manifest（header + 若干 document entry）。 */
function scaffold(files: Array<[string, string]>, git = false): void {
  for (const [rel, content] of files) {
    const segs = rel.split('/')
    mkdirSync(join(tmp, ...segs.slice(0, -1)), { recursive: true })
    writeFileSync(join(tmp, ...segs), content, 'utf-8')
  }
  const entries = files.map(([rel], i) => ({
    id: `doc-${i}`,
    nodeType: 'document',
    path: rel,
    parentId: null,
  }))
  mkdirSync(join(tmp, '项目'), { recursive: true })
  writeFileSync(
    join(tmp, '项目', '文档清单.jsonl'),
    [JSON.stringify({ version: 1, type: 'header' }), ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n',
    'utf-8',
  )
  if (git) {
    execSync('git init', { cwd: tmp, stdio: 'pipe' })
    execSync('git config user.email t@t.com', { cwd: tmp, stdio: 'pipe' })
    execSync('git config user.name t', { cwd: tmp, stdio: 'pipe' })
    execSync('git config commit.gpgsign false', { cwd: tmp, stdio: 'pipe' })
  }
}

function manifest(): ReturnType<typeof readManifest> {
  return readManifest(join(tmp, '项目', '文档清单.jsonl'))
}

// ── 无 git（v3 新书）：不迁移（X-P1-1）──────────────
// v3 scaffold 不再 git init，新书永无 .git——「无 git = 旧书坍缩 final」假设失效，
// 误标会把新书正常草稿判成已定稿（ensureChapterNotFinalized 拦截写章 + 手改误报）。

test('无 git（v3 新书）：no-op，全部保持 draft（X-P1-1）', async () => {
  scaffold([
    ['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文'],
    ['设定/角色/主角.md', '---\n姓名: 主角\n---\n角色设定'],
  ])
  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(0)
  const m = manifest()
  for (const e of m.entries.values()) {
    expect(e.finalizedRevision).toBeUndefined()
  }
})

// ── 有 git：clean → final，dirty → 不设 ──────────

test('有 git：committed 干净文件建基线，dirty/untracked 不建', async () => {
  scaffold(
    [
      ['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文'],
      ['写作/正文/0002-中篇.md', '---\n章号: 2\n标题: 中篇\n---\n正文2'],
    ],
    true,
  )
  execSync('git add -A && git commit -m init', { cwd: tmp, stdio: 'pipe' })
  // 0002 改脏（未 commit）
  writeFileSync(join(tmp, '写作/正文/0002-中篇.md'), '---\n章号: 2\n标题: 中篇\n---\n改过的正文', 'utf-8')

  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(1) // 只有 clean 的 0001 建基线

  const m = manifest()
  const e1 = [...m.entries.values()].find((e) => e.path.endsWith('0001-开篇.md'))!
  const e2 = [...m.entries.values()].find((e) => e.path.endsWith('0002-中篇.md'))!
  expect(typeof e1.finalizedRevision).toBe('string')
  expect(e2.finalizedRevision).toBeUndefined()
})

// ── 幂等 ──────────────────────────────────────────

test('幂等：已有基线 → 跳过（第二次 0）', async () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文']], true)
  execSync('git add -A && git commit -m init', { cwd: tmp, stdio: 'pipe' })
  const r1 = await migrateFinalizedRevisionsAsync(tmp)
  expect(r1).toBe(1)
  const r2 = await migrateFinalizedRevisionsAsync(tmp)
  expect(r2).toBe(0)
})

test('幂等：任一 entry 已有基线 → 整书跳过 git 反推', async () => {
  scaffold(
    [
      ['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文'],
      ['写作/正文/0002-中篇.md', '---\n章号: 2\n标题: 中篇\n---\n正文2'],
    ],
    true,
  )
  execSync('git add -A && git commit -m init', { cwd: tmp, stdio: 'pipe' })
  // 0002 改脏
  writeFileSync(join(tmp, '写作/正文/0002-中篇.md'), '---\n章号: 2\n标题: 中篇\n---\n改脏', 'utf-8')
  // 0001 手工建基线 → 整书已迁移
  const m = manifest()
  m.entries.get('doc-0')!.finalizedRevision = 'sha256:preset'
  writeManifest(join(tmp, '项目', '文档清单.jsonl'), m)

  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(0) // 幂等闸：不再 git 反推
})

// ── 无 manifest no-op ─────────────────────────────

test('无清单：no-op', async () => {
  mkdirSync(join(tmp, '写作', '正文'), { recursive: true })
  writeFileSync(join(tmp, '写作/正文/0001-x.md'), '正文', 'utf-8')
  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(0)
})

// ── 文件缺失跳过 ─────────────────────────────────

test('manifest 登记但文件不存在 → 跳过不建基线', async () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文']], true)
  execSync('git add -A && git commit -m init', { cwd: tmp, stdio: 'pipe' })
  // 手动加一个悬空 entry
  const m = manifest()
  m.entries.set('doc-ghost', { id: 'doc-ghost', nodeType: 'document', path: '写作/正文/0099-幽灵.md', parentId: null })
  writeManifest(join(tmp, '项目', '文档清单.jsonl'), m)

  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(1) // 只有存在的 0001
})

// ── RB-IF-P1-1：git 状态不可读 → fail-closed ──────
// 空 .git 使 git status 失败（statusPorcelain → null）。修复前 fail-open 返回 ''，
// 脏集为空 → dirty/untracked 的 entry 全部误写 finalizedRevision（正是头注释要避免的误判 final 断写）。

test('RB-IF-P1-1: git 状态不可读 → 跳过迁移不写基线 + 告警', async () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n未 commit 的草稿']], true)
  // 不 commit（全 dirty）且破坏 .git 使 porcelain 失败
  rmSync(join(tmp, '.git'), { recursive: true, force: true })
  mkdirSync(join(tmp, '.git'))

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const n = await migrateFinalizedRevisionsAsync(tmp)
    expect(n).toBe(0)
    // 未 commit 的草稿不得被误标已定稿
    const m = manifest()
    for (const e of m.entries.values()) {
      expect(e.finalizedRevision).toBeUndefined()
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('跳过定稿基线迁移')
  } finally {
    warn.mockRestore()
  }
})
// ── 低级项（第六轮）：porcelain 路径归一（空格/引号/rename）──────────────

test('低级项（第六轮）：含空格路径的 dirty 文件不建基线（porcelain 引号转义失配）', async () => {
  scaffold(
    [
      ['写作/正文/0001-干净.md', '---\n章号: 1\n标题: 干净\n---\n正文'],
      ['写作/正文/0002-带 空格.md', '---\n章号: 2\n标题: 带空格\n---\n正文'],
    ],
    true,
  )
  // 全部提交（clean 基线）后改写 0002（tracked → dirty；路径含空格 → porcelain 加引号）
  execSync('git add -A && git commit -m base', { cwd: tmp, stdio: 'pipe' })
  writeFileSync(join(tmp, '写作/正文/0002-带 空格.md'), '---\n章号: 2\n标题: 带空格\n---\n改过的正文', 'utf-8')

  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(1) // 只给干净的 0001 建基线
  const m = manifest()
  const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
  expect(byPath.get('写作/正文/0001-干净.md')?.finalizedRevision).toMatch(/^sha256:/)
  // 引号路径原先与 manifest 失配 → dirty 漏判 clean → 误标 final（断写红线）
  expect(byPath.get('写作/正文/0002-带 空格.md')?.finalizedRevision).toBeUndefined()
})

test('低级项（第六轮）：非 ASCII 文件名的 untracked 不建基线（porcelain 八进制转义路径）', async () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n---\n正文']], true)
  execSync('git add -A && git commit -m base', { cwd: tmp, stdio: 'pipe' })
  // untracked 且文件名含非 ASCII + 空格（git core.quotePath 默认八进制转义 + 引号）
  const rel = '写作/正文/0002-设定 章.md'
  const segs = rel.split('/')
  mkdirSync(join(tmp, ...segs.slice(0, -1)), { recursive: true })
  writeFileSync(join(tmp, ...segs), '未跟踪草稿', 'utf-8')
  // 补登记 manifest（untracked 文件也有清单条目）
  const m0 = manifest()
  m0.entries.set('doc-new', { id: 'doc-new', nodeType: 'document', path: rel, parentId: null })
  writeManifest(join(tmp, '项目', '文档清单.jsonl'), m0)

  const n = await migrateFinalizedRevisionsAsync(tmp)
  expect(n).toBe(1) // 只有 clean 的 0001 建基线
  const m = manifest()
  const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
  expect(byPath.get('写作/正文/0001-开篇.md')?.finalizedRevision).toMatch(/^sha256:/)
  expect(byPath.get(rel)?.finalizedRevision).toBeUndefined()
})

// 含 > 的文件名仅 POSIX 可建（win 上落盘即失败）——skipIf 保原输入，字面箭头断言不因适配空转
test.skipIf(process.platform === 'win32')(
  'P5-数据层（第七轮）：文件名含字面 " -> " 的 untracked 不建基线（仅 R 状态才切箭头）',
  async () => {
    scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n---\n正文']], true)
    execSync('git add -A && git commit -m base', { cwd: tmp, stdio: 'pipe' })
    // untracked：旧实现非 R 行也可能按 indexOf(' -> ') 切，路径被截 → dirty 失配 →
    // 误判 clean 给未提交文件建定稿基线（断写红线）
    const rel = '写作/正文/0002-旧 -> 新.md'
    const segs = rel.split('/')
    mkdirSync(join(tmp, ...segs.slice(0, -1)), { recursive: true })
    writeFileSync(join(tmp, ...segs), '未跟踪草稿', 'utf-8')
    const m0 = manifest()
    m0.entries.set('doc-arrow', { id: 'doc-arrow', nodeType: 'document', path: rel, parentId: null })
    writeManifest(join(tmp, '项目', '文档清单.jsonl'), m0)

    const n = await migrateFinalizedRevisionsAsync(tmp)
    expect(n).toBe(1) // 只有 committed 干净的 0001 建基线
    const m = manifest()
    const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
    expect(byPath.get(rel)?.finalizedRevision).toBeUndefined()
    expect(byPath.get('写作/正文/0001-开篇.md')?.finalizedRevision).toMatch(/^sha256:/)
  },
)

// 含 > 的文件名仅 POSIX 可建（win 上落盘即失败）——skipIf 保原输入，引号内箭头断言不因适配空转
test.skipIf(process.platform === 'win32')(
  'L-D7（第八轮）：R 行引号路径任一侧字面含 " -> " —— 引号外箭头定位不切引号内',
  async () => {
    scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n---\n正文']], true)
    execSync('git add -A && git commit -m base', { cwd: tmp, stdio: 'pipe' })
    // 改名：旧名含字面箭头（引号内）→ git porcelain 输出 `"…旧 -> 名" -> "…新名"`。
    // 首匹配 indexOf 会切在引号内箭头处，得残路径「名" -> "…新名"」→ rename 失配。
    const oldRel = '写作/正文/0002-旧 -> 名.md'
    const newRel = '写作/正文/0002-新名.md'
    mkdirSync(join(tmp, '写作', '正文'), { recursive: true })
    writeFileSync(join(tmp, ...oldRel.split('/')), '改名内容', 'utf-8')
    execSync(`git add -A && git commit -m "添加待改名"`, { cwd: tmp, stdio: 'pipe' })
    execSync(`git mv "${oldRel}" "${newRel}"`, { cwd: tmp, stdio: 'pipe' })
    execSync('git commit -m "改名"', { cwd: tmp, stdio: 'pipe' }) // 提交后 R 历史在、工作区 clean
    const m0 = manifest()
    m0.entries.set('doc-r-arrow', { id: 'doc-r-arrow', nodeType: 'document', path: newRel, parentId: null })
    writeManifest(join(tmp, '项目', '文档清单.jsonl'), m0)

    const n = await migrateFinalizedRevisionsAsync(tmp)
    expect(n).toBe(2) // 0001 与改名后的 0002 均 clean 建基线（残路径场景会 rename 失配跳过 0002）
    const m = manifest()
    const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
    expect(byPath.get(newRel)?.finalizedRevision).toMatch(/^sha256:/)
  },
)

// ── 异步孪生：慢 git 不再同步冻住启动链 ─────────────

test('慢 git 状态下事件循环仍可让出：定时器先于迁移完成兑现，迁移结果与基线照常落盘', async () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文']], true)
  // 慢 git：状态输出推迟到 300ms——同步实现会把这段等待整段占满事件循环
  mockSpawnSync.mockClear()
  mockSpawn.mockClear()
  mockSpawn.mockImplementationOnce(
    () => new SlowGitChild('', 300) as unknown as ChildProcess,
  )

  let tickedAt = 0
  const tick = new Promise<void>((r) =>
    setTimeout(() => {
      tickedAt = Date.now()
      r()
    }, 50),
  )
  const startedAt = Date.now()
  const pending = migrateFinalizedRevisionsAsync(tmp).then((n) => ({ n, doneAt: Date.now() }))
  await tick
  expect(tickedAt).toBeGreaterThan(0)
  const { n, doneAt } = await pending

  // 让出断言：50ms 的定时器在迁移（≥300ms 慢 git）完成之前兑现
  expect(doneAt).toBeGreaterThan(tickedAt)
  expect(doneAt - startedAt).toBeGreaterThanOrEqual(300)
  // 迁移照常生效：clean 的 0001 建基线（慢 git 只延后，不改判定）
  expect(n).toBe(1)
  expect(manifest().entries.get('doc-0')?.finalizedRevision).toMatch(/^sha256:/)
  // 异步实现断言：git 状态走 spawn；同步 spawnSync 在迁移期间零调用
  expect(mockSpawn).toHaveBeenCalled()
  expect(mockSpawnSync).not.toHaveBeenCalled()
})

test('git 状态读取失败（不可读）时迁移照常收口：不抛、不写基线、链上后续步骤不受影响', async () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文']], true)
  // 慢 git 后非 0 退出（不可读形态）——迁移须按 fail-closed 跳过而非抛出
  mockSpawn.mockImplementationOnce(
    () => new SlowGitChild('', 150, 128) as unknown as ChildProcess,
  )
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const n = await migrateFinalizedRevisionsAsync(tmp)
    expect(n).toBe(0)
    expect(manifest().entries.get('doc-0')?.finalizedRevision).toBeUndefined()
  } finally {
    warn.mockRestore()
  }
})
