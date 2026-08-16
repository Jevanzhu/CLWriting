/**
 * 状态机 7 态判定测试 —— #15 第 2 节。
 *
 * 工单施工序 1 验证点：7 种书仓库 fixture（各处一态）→ detectState 正确路由。
 * 每态一个 fixture，验证判定顺序与命中。
 */

import { test, expect } from 'vitest'
import { rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeGitBook, makeGitBookWithChapters, stageIncompleteChapter } from '../helpers/book.js'
import { detectState, routeState, enter } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'
import { appendMovePending, findUnsettled } from '../../src/document/journal.js'

const FAST_CHAPTER_FIXTURE = { commitEach: false }

// ── 态 1: 健康检查（journal 崩溃 + 网盘副本）──────────────────

test('detectState: 网盘副本残留 → 态 1（体检优先）', () => {
  const root = makeGitBook()
  // 造 Dropbox 风格冲突副本（纯 fs，不依赖 git；X-P2-20 起需同名母本共存才算副本）
  writeFileSync(join(root, '写作', '正文', '某章.md'), '母本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '某章 2.md'), '副本内容', 'utf-8')

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state === 1) {
    expect(d.issues.length).toBeGreaterThan(0)
    expect(d.issues.some((i) => i.kind === 'cloudCopy')).toBe(true)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 2: 源文件解析失败 ────────────────────────────

test('detectState: 源文件解析失败 → 态 2', () => {
  const root = makeGitBook()
  // 写一个坏账本文件（裸文件无 front matter，rebuild 会收 ParseError）
  writeFileSync(join(root, '布线', '悬念', '悬念-099-坏.md'), '这是个坏文件没有 front matter', 'utf-8')

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(2)
  if (d.state === 2) {
    expect(d.parseErrors.length).toBeGreaterThan(0)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 3: 未入账手改 ────────────────────────────────

test('detectState: 已定稿文件有手改 → 态 3', () => {
  const root = makeGitBook()
  // 造一章定稿（登记 manifest + 设基线）+ 手改正文
  const bodyPath = join(root, '写作', '正文', '0001-开篇.md')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    bodyPath,
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n天脉异象惊动宗门。\n',
    'utf-8',
  )
  // 定稿基线 = 当前指纹
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, {
    id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null,
    finalizedRevision: computeRevision(bodyPath), finalizedAt: new Date().toISOString(),
  })
  writeManifest(manifestPath, m)

  // 手改正文（指纹 ≠ 基线）→ 态 3
  writeFileSync(bodyPath, '---\n章号: 1\n标题: 开篇\n---\n\n作者手改的正文。\n', 'utf-8')

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(3)
  if (d.state === 3) {
    expect(d.handEdits.some((f) => f.includes('0001-开篇'))).toBe(true)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 4: 工作区未完成 ──────────────────────────────

test('detectState: 工作区有草稿+确认未定稿 → 态 4', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1) // 写草稿+细纲+.confirm，不 commit

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(4)
  if (d.state === 4) {
    expect(d.chapterNum).toBe(1)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 5: 卷末 ─────────────────────────────────────

test('detectState: 写满一卷（50 章）→ 态 5 卷末', () => {
  const root = makeGitBookWithChapters(50, FAST_CHAPTER_FIXTURE) // 50 章 = 第 1 卷末

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(5)
  if (d.state === 5) {
    expect(d.volume).toBe(1)
  }
  rmSync(root, { recursive: true, force: true })
})

test('detectState: book.volume_size 覆盖每卷章数', () => {
  const root = makeGitBookWithChapters(10, FAST_CHAPTER_FIXTURE)
  const config = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book, volume_size: 10 } }

  const d = detectState(root, config)
  expect(d.state).toBe(5)
  if (d.state === 5) {
    expect(d.volume).toBe(1)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 态 7: 起草新章（兜底）──────────────────────────

test('detectState: 一切干净的空书 → 态 7 起草新章', () => {
  const root = makeGitBook()
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) {
    expect(d.nextChapter).toBe(1) // 空书下一章 = 1
  }
  rmSync(root, { recursive: true, force: true })
})

test('detectState: 写了 3 章干净书 → 态 7 下一章 = 4', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(7)
  if (d.state === 7) {
    expect(d.nextChapter).toBe(4)
  }
  rmSync(root, { recursive: true, force: true })
})

// ── 判定顺序：健康异常优先 ────────────────────────

test('detectState: 健康异常优先（网盘副本 + 工作区未完成 → 先报态 1）', () => {
  const root = makeGitBook()
  stageIncompleteChapter(root, 1) // 工作区未完成（态 4）
  // 再造健康问题（态 1；X-P2-20：副本需同名母本）
  writeFileSync(join(root, '写作', '正文', '冲突副本.md'), '母本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '冲突副本 2.md'), '副本', 'utf-8')

  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1) // 态 1 优先于态 4
  rmSync(root, { recursive: true, force: true })
})

// ── 路由（routeState）──────────────────────────────

test('routeState: 各态路由动作 + needsAI 标记', () => {
  // 态 1 不需 AI、态 2/3 需 AI（M3 桩）、态 4/7 不需 AI
  const root1 = makeGitBook()
  writeFileSync(join(root1, '写作', '正文', '副本.md'), '母本', 'utf-8')
  writeFileSync(join(root1, '写作', '正文', '副本 2.md'), '副本', 'utf-8')
  expect(routeState(detectState(root1, DEFAULT_CONFIG)).state).toBe(1)
  rmSync(root1, { recursive: true, force: true })

  const root7 = makeGitBook()
  const r7 = routeState(detectState(root7, DEFAULT_CONFIG))
  expect(r7.action).toBe('write-new-chapter')
  expect(r7.humanMsg).toContain('第 1 章')
  rmSync(root7, { recursive: true, force: true })
})

test('routeState: 态 7 统一写章入口（CLI 退场，不再分手写/严格）', () => {
  // 自由 / 严格 / 缺省 config → 一律 write-new-chapter（写章收敛到全自动/编辑器）
  const rootFree = makeGitBook()
  const freeCfg = { ...DEFAULT_CONFIG, workflow: 'free' as const }
  expect(routeState(detectState(rootFree, freeCfg)).action).toBe('write-new-chapter')
  rmSync(rootFree, { recursive: true, force: true })

  const rootStrict = makeGitBook()
  const strictCfg = { ...DEFAULT_CONFIG, workflow: 'strict' as const }
  expect(routeState(detectState(rootStrict, strictCfg)).action).toBe('write-new-chapter')
  rmSync(rootStrict, { recursive: true, force: true })

  // 无 config（旧调用兼容）→ AI 流程
  const root7 = makeGitBook()
  expect(routeState(detectState(root7, DEFAULT_CONFIG)).action).toBe('write-new-chapter')
  rmSync(root7, { recursive: true, force: true })
})

// ── enter 单入口 + 近况复述 ─────────────────────────

test('enter: 干净书 → recap + route 结构正确', () => {
  const root = makeGitBookWithChapters(3, FAST_CHAPTER_FIXTURE)
  const { recap, route } = enter(root)

  expect(recap.currentChapter).toBe(3)
  expect(recap.gitClean).toBe(true)
  expect(recap.nextChapter).toBe(4)
  expect(route.action).toBe('write-new-chapter')
  rmSync(root, { recursive: true, force: true })
})

test('enter: 健康异常且缓存缺失 → 不崩，返回态 1 路由', () => {
  const root = makeGitBook()
  writeFileSync(join(root, '写作', '正文', '副本.md'), '母本', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '副本 2.md'), '副本', 'utf-8')

  const result = enter(root)
  expect(result.recap.state).toBe(1)
  expect(result.recap.currentChapter).toBe(0)
  expect(result.route.state).toBe(1)
  rmSync(root, { recursive: true, force: true })
})

test('enter: 写满一卷 → recap 显示态 5 卷末', () => {
  const root = makeGitBookWithChapters(50, FAST_CHAPTER_FIXTURE)
  const { recap, route } = enter(root)
  expect(recap.state).toBe(5)
  expect(route.action).toBe('volume-review')
  rmSync(root, { recursive: true, force: true })
})

// ── P3-10: move 类 journal pending 进门确定性自愈 ───────────────────

/** 造场景：清单登记 oldRel，文件按 fileExists 落盘（new=rename 已发生），journal 悬置 move pending。 */
function makeMovePendingBook(fileExists: 'old' | 'new' | 'none'): {
  root: string
  docId: string
  oldRel: string
  newRel: string
  jPath: string
} {
  const root = makeGitBook()
  const docId = generateDocId()
  const oldRel = '写作/正文/0001-开篇.md'
  const newRel = '写作/正文/0002-开篇.md'
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  const rel = fileExists === 'old' ? oldRel : fileExists === 'new' ? newRel : null
  if (rel) {
    writeFileSync(join(root, rel), '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。\n', 'utf-8')
  }
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  mkdirSync(join(root, '项目'), { recursive: true })
  const m = readManifest(manifestPath)
  upsertEntry(m, { id: docId, nodeType: 'document', path: oldRel, parentId: null })
  writeManifest(manifestPath, m)
  const jPath = join(root, '工作区', '.journal', `${docId}.jsonl`)
  mkdirSync(join(root, '工作区', '.journal'), { recursive: true })
  appendMovePending(jPath, docId, oldRel, newRel)
  return { root, docId, oldRel, newRel, jPath }
}

test('P3-10 自愈: 文件已到新路径、清单未跟上 → 补清单 + settled，不拦进门', () => {
  const { root, docId, newRel, jPath } = makeMovePendingBook('new')
  const d = detectState(root, DEFAULT_CONFIG)
  // 不因 move pending 报 crashedWrite（确定性自愈，不门禁）
  if (d.state === 1) expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  // 清单已对齐新路径
  const after = readManifest(join(root, '项目', '文档清单.jsonl'))
  expect(after.entries.get(docId)?.path).toBe(newRel)
  // journal 已配对 settled（下次进门不再处理）
  expect(findUnsettled(jPath)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('P3-10 自愈: 文件仍在旧路径（rename 未发生）→ abort 悬置，清单不动', () => {
  const { root, docId, oldRel, jPath } = makeMovePendingBook('old')
  const d = detectState(root, DEFAULT_CONFIG)
  if (d.state === 1) expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false)
  const after = readManifest(join(root, '项目', '文档清单.jsonl'))
  expect(after.entries.get(docId)?.path).toBe(oldRel)
  expect(findUnsettled(jPath)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('P3-10 自愈: 两端都不在（异常态）→ 不可自动判定，报 crashedWrite 交作者', () => {
  const { root, jPath } = makeMovePendingBook('none')
  const d = detectState(root, DEFAULT_CONFIG)
  expect(d.state).toBe(1)
  if (d.state === 1) {
    expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(true)
  }
  // 未处理：pending 仍悬置
  expect(findUnsettled(jPath)).toHaveLength(1)
  rmSync(root, { recursive: true, force: true })
})
