import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateFinalizedRevisions } from '../../src/install/migrate-finalized-revision.js'
import { readManifest, writeManifest } from '../../src/document/manifest.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clw-migrate-fin-'))
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

test('无 git（v3 新书）：no-op，全部保持 draft（X-P1-1）', () => {
  scaffold([
    ['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文'],
    ['设定/角色/主角.md', '---\n姓名: 主角\n---\n角色设定'],
  ])
  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(0)
  const m = manifest()
  for (const e of m.entries.values()) {
    expect(e.finalizedRevision).toBeUndefined()
  }
})

// ── 有 git：clean → final，dirty → 不设 ──────────

test('有 git：committed 干净文件建基线，dirty/untracked 不建', () => {
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

  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(1) // 只有 clean 的 0001 建基线

  const m = manifest()
  const e1 = [...m.entries.values()].find((e) => e.path.endsWith('0001-开篇.md'))!
  const e2 = [...m.entries.values()].find((e) => e.path.endsWith('0002-中篇.md'))!
  expect(typeof e1.finalizedRevision).toBe('string')
  expect(e2.finalizedRevision).toBeUndefined()
})

// ── 幂等 ──────────────────────────────────────────

test('幂等：已有基线 → 跳过（第二次 0）', () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文']], true)
  execSync('git add -A && git commit -m init', { cwd: tmp, stdio: 'pipe' })
  const r1 = migrateFinalizedRevisions(tmp)
  expect(r1).toBe(1)
  const r2 = migrateFinalizedRevisions(tmp)
  expect(r2).toBe(0)
})

test('幂等：任一 entry 已有基线 → 整书跳过 git 反推', () => {
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

  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(0) // 幂等闸：不再 git 反推
})

// ── 无 manifest no-op ─────────────────────────────

test('无清单：no-op', () => {
  mkdirSync(join(tmp, '写作', '正文'), { recursive: true })
  writeFileSync(join(tmp, '写作/正文/0001-x.md'), '正文', 'utf-8')
  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(0)
})

// ── 文件缺失跳过 ─────────────────────────────────

test('manifest 登记但文件不存在 → 跳过不建基线', () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n正文']], true)
  execSync('git add -A && git commit -m init', { cwd: tmp, stdio: 'pipe' })
  // 手动加一个悬空 entry
  const m = manifest()
  m.entries.set('doc-ghost', { id: 'doc-ghost', nodeType: 'document', path: '写作/正文/0099-幽灵.md', parentId: null })
  writeManifest(join(tmp, '项目', '文档清单.jsonl'), m)

  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(1) // 只有存在的 0001
})

// ── RB-IF-P1-1：git 状态不可读 → fail-closed ──────
// 空 .git 使 git status 失败（statusPorcelain → null）。修复前 fail-open 返回 ''，
// 脏集为空 → dirty/untracked 的 entry 全部误写 finalizedRevision（正是头注释要避免的误判 final 断写）。

test('RB-IF-P1-1: git 状态不可读 → 跳过迁移不写基线 + 告警', () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n标题: 开篇\n---\n未 commit 的草稿']], true)
  // 不 commit（全 dirty）且破坏 .git 使 porcelain 失败
  rmSync(join(tmp, '.git'), { recursive: true, force: true })
  mkdirSync(join(tmp, '.git'))

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const n = migrateFinalizedRevisions(tmp)
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

test('低级项（第六轮）：含空格路径的 dirty 文件不建基线（porcelain 引号转义失配）', () => {
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

  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(1) // 只给干净的 0001 建基线
  const m = manifest()
  const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
  expect(byPath.get('写作/正文/0001-干净.md')?.finalizedRevision).toMatch(/^sha256:/)
  // 引号路径原先与 manifest 失配 → dirty 漏判 clean → 误标 final（断写红线）
  expect(byPath.get('写作/正文/0002-带 空格.md')?.finalizedRevision).toBeUndefined()
})

test('低级项（第六轮）：非 ASCII 文件名的 untracked 不建基线（porcelain 八进制转义路径）', () => {
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

  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(1) // 只有 clean 的 0001 建基线
  const m = manifest()
  const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
  expect(byPath.get('写作/正文/0001-开篇.md')?.finalizedRevision).toMatch(/^sha256:/)
  expect(byPath.get(rel)?.finalizedRevision).toBeUndefined()
})

test('P5-数据层（第七轮）：文件名含字面 " -> " 的 untracked 不建基线（仅 R 状态才切箭头）', () => {
  scaffold([['写作/正文/0001-开篇.md', '---\n章号: 1\n---\n正文']], true)
  execSync('git add -A && git commit -m base', { cwd: tmp, stdio: 'pipe' })
  // untracked 文件名里就带 " -> "：旧代码对非 R 行也无条件按 indexOf(' -> ') 切，
  // 路径被截成「新.md」→ dirty 失配 → 误判 clean 给未提交文件建定稿基线（断写红线）
  const rel = '写作/正文/0002-旧 -> 新.md'
  const segs = rel.split('/')
  mkdirSync(join(tmp, ...segs.slice(0, -1)), { recursive: true })
  writeFileSync(join(tmp, ...segs), '未跟踪草稿', 'utf-8')
  const m0 = manifest()
  m0.entries.set('doc-arrow', { id: 'doc-arrow', nodeType: 'document', path: rel, parentId: null })
  writeManifest(join(tmp, '项目', '文档清单.jsonl'), m0)

  const n = migrateFinalizedRevisions(tmp)
  expect(n).toBe(1) // 只有 committed 干净的 0001 建基线
  const m = manifest()
  const byPath = new Map([...m.entries.values()].map((e) => [e.path, e]))
  expect(byPath.get(rel)?.finalizedRevision).toBeUndefined()
  expect(byPath.get('写作/正文/0001-开篇.md')?.finalizedRevision).toMatch(/^sha256:/)
})
