import { test, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectState, buildRecap, formatRecap, enter } from '../../src/state/state.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'

/** 建一本干净的书（态 7 基础），git init + book.yaml + 初始 commit。 */
function makeCleanBook(): string {
  const root = mkdtempSync(join(tmpdir(), '态8-'))
  execSync('git init', { cwd: root, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: root, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: root, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  mkdirSync(join(root, '大纲', '伏笔'), { recursive: true })
  mkdirSync(join(root, '定稿', '正文'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '.cache'), { recursive: true })
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return root
}

/** 在待定稿建完成章目录（连写产出形态：含草稿/细纲，无审稿.md）。 */
function seedPendingChapter(bookRoot: string, chapter: number, title: string): string {
  const dir = join(bookRoot, '工作区', '待定稿', `${String(chapter).padStart(4, '0')}-${title}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '草稿-1.md'), `---\n章号: ${chapter}\n标题: ${title}\n---\n正文。\n`, 'utf-8')
  writeFileSync(join(dir, '细纲.md'), `${title}细纲`, 'utf-8')
  return dir
}

test('态 8: 待定稿有完成章 → detectState 返回态 8（不落态 7）', () => {
  const root = makeCleanBook()
  seedPendingChapter(root, 2, '第二章')
  seedPendingChapter(root, 3, '第三章')

  const detected = detectState(root, DEFAULT_CONFIG)
  expect(detected.state).toBe(8)
  if (detected.state === 8) {
    expect(detected.pendingChapters).toEqual([2, 3])
  }

  rmSync(root, { recursive: true, force: true })
})

test('态 8: 空工作区（无待定稿）仍落态 7（零回归）', () => {
  const root = makeCleanBook()
  const detected = detectState(root, DEFAULT_CONFIG)
  expect(detected.state).toBe(7)
  rmSync(root, { recursive: true, force: true })
})

test('态 8: 路由 action=pending-batch-review + 人话含章数', () => {
  const root = makeCleanBook()
  seedPendingChapter(root, 5, '第五章')

  const detected = detectState(root, DEFAULT_CONFIG)
  // 用 enter 全链路验证
  const result = enter(root)
  expect(result.route.state).toBe(8)
  expect(result.route.action).toBe('pending-batch-review')
  expect(result.route.humanMsg).toContain('1 章待审稿')
  expect(result.route.humanMsg).toContain('第 5 章')
  expect(result.route.humanMsg).toContain('clwriting review batch')

  rmSync(root, { recursive: true, force: true })
})

test('态 8: .isolated/ 隔离章不计入待审', () => {
  const root = makeCleanBook()
  seedPendingChapter(root, 2, '好章')
  // 隔离章（.isolated 下，不计数）
  const isoDir = join(root, '工作区', '待定稿', '.isolated', '0003-坏章')
  mkdirSync(isoDir, { recursive: true })
  writeFileSync(join(isoDir, '草稿-1.md'), '坏章', 'utf-8')

  const detected = detectState(root, DEFAULT_CONFIG)
  expect(detected.state).toBe(8)
  if (detected.state === 8) {
    expect(detected.pendingChapters).toEqual([2]) // 只有好章，隔离章不计
  }

  rmSync(root, { recursive: true, force: true })
})

test('态 8: recap batchPause 读 .auto-batch.json paused', () => {
  const root = makeCleanBook()
  seedPendingChapter(root, 2, '第二章')
  // 写 .auto-batch.json 带 paused
  writeFileSync(
    join(root, '工作区', '待定稿', '.auto-batch.json'),
    JSON.stringify({
      start_chapter: 2, target_count: 3, next_chapter: 3,
      completed: [2], isolated: [],
      paused: { at_chapter: 3, reason: 'budget', detail: '第3章调用触顶', paused_at: '2026-06-18T10:00:00Z' },
      started_at: '2026-06-18T09:00:00Z',
    }),
    'utf-8',
  )

  const detected = detectState(root, DEFAULT_CONFIG)
  const recap = buildRecap(root, DEFAULT_CONFIG, detected)
  expect(recap.batchPause).toBeDefined()
  expect(recap.batchPause!.atChapter).toBe(3)
  expect(recap.batchPause!.reason).toBe('budget')

  // formatRecap 应出暂停提示行
  const text = formatRecap(recap)
  expect(text).toContain('连写暂停')
  expect(text).toContain('第 3 章暂停')
  expect(text).toContain('auto --resume')

  rmSync(root, { recursive: true, force: true })
})

test('态 8: 无 paused 时 recap.batchPause 为 undefined（不误报）', () => {
  const root = makeCleanBook()
  seedPendingChapter(root, 2, '第二章')
  // 无 .auto-batch.json 或 paused=null
  const detected = detectState(root, DEFAULT_CONFIG)
  const recap = buildRecap(root, DEFAULT_CONFIG, detected)
  expect(recap.batchPause).toBeUndefined()

  rmSync(root, { recursive: true, force: true })
})

test('态 8: 半截章在工作区根优先态 4（态 4 先于态 8）', () => {
  const root = makeCleanBook()
  seedPendingChapter(root, 3, '第三章') // 待定稿有完成章
  // 工作区根有半截章（态 4 应优先）
  writeFileSync(join(root, '工作区', '细纲.md'), '半截细纲', 'utf-8')
  writeFileSync(join(root, '工作区', '.confirm.json'), JSON.stringify({ chapter: 4, outline_hash: 'x', confirmed_at: 't', mode: 'auto' }), 'utf-8')

  const detected = detectState(root, DEFAULT_CONFIG)
  expect(detected.state).toBe(4) // 态 4 优先于态 8（先单章续完再进待审）

  rmSync(root, { recursive: true, force: true })
})
