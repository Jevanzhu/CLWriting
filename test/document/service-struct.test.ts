/**
 * W2A T4 —— DocumentService 结构性操作（createDocument/moveDocument/renameDocument）单测。
 * 与 W1 save 测试分文件。覆盖：落盘+清单登记+docId、ALREADY_EXISTS、CAPABILITY_DENIED、
 * PATH_ESCAPE、跨卷移动章号不变、清单 path 更新、移动前 snapshot、rename、NOT_FOUND。
 */
import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { getBookTreeIndex } from '../../src/document/tree.js'
import { legacyId } from '../../src/document/stable-id.js'
import { findUnsettled } from '../../src/document/journal.js'

/** 造书：写作/正文/第一卷/0001-开篇 + 项目清单登记 doc_ch01 + git init。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'w2a-svc-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  mkdirSync(join(root, '大纲', '卷纲'), { recursive: true })
  mkdirSync(join(root, '工作区'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: 1\n标题: 开篇\n---\n正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ch01","nodeType":"document","path":"写作/正文/第一卷/0001-开篇.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

test('createDocument: 落盘 + 分配 doc_ 前缀 docId + 清单登记', async () => {
  const { root, svc } = makeBookWithChapter()
  getBookTreeIndex(root) // 预热缓存（验证后续 invalidate 重建）
  const r = await svc.createDocument({ relPath: '写作/正文/第一卷/0002-迷雾.md', content: '---\n章号: 2\n---\n迷雾正文' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.docId).toMatch(/^doc_/)
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0002-迷雾.md'))).toBe(true)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain(r.docId)
  rmSync(root, { recursive: true, force: true })
})

test('createDocument: 已存在 → ALREADY_EXISTS', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.createDocument({ relPath: '写作/正文/第一卷/0001-开篇.md', content: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('ALREADY_EXISTS')
  rmSync(root, { recursive: true, force: true })
})

test('createDocument: 只读位置（定稿/摘要）→ CAPABILITY_DENIED', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '定稿', '摘要'), { recursive: true })
  const r = await svc.createDocument({ relPath: '定稿/摘要/0001.md', content: '摘要' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('CAPABILITY_DENIED')
  rmSync(root, { recursive: true, force: true })
})

test('createDocument: 路径越出 → PATH_ESCAPE', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.createDocument({ relPath: '../etc/passwd', content: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('PATH_ESCAPE')
  rmSync(root, { recursive: true, force: true })
})

test('moveDocument: 跨卷移动，文件名不变（章号稳定 §11）+ 清单 path 更新 + snapshot 留底', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '写作', '正文', '第二卷'), { recursive: true })
  const r = await svc.moveDocument({ docId: 'doc_ch01', toDir: '写作/正文/第二卷' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第二卷/0001-开篇.md') // 文件名（含章号）不变
  expect(existsSync(join(root, '写作', '正文', '第二卷', '0001-开篇.md'))).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  const m = readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')
  expect(m).toContain('写作/正文/第二卷/0001-开篇.md')
  expect(m).not.toContain('写作/正文/第一卷/0001-开篇.md')
  // snapshot 留底
  const snapDir = join(root, '工作区', '.版本', 'doc_ch01')
  expect(existsSync(snapDir)).toBe(true)
  expect(readdirSync(snapDir).length).toBeGreaterThan(0)
  // P3-10：journal 兜底——移动全程 move pending → settled 配对，无悬置
  const jPath = join(root, '工作区', '.journal', 'doc_ch01.jsonl')
  expect(existsSync(jPath)).toBe(true)
  expect(readFileSync(jPath, 'utf-8')).toContain('"kind":"move"')
  expect(findUnsettled(jPath)).toHaveLength(0)
  rmSync(root, { recursive: true, force: true })
})

test('moveDocument: docId 未登记 → NOT_FOUND', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '写作', '正文', '第二卷'), { recursive: true })
  const r = await svc.moveDocument({ docId: 'doc_unknown', toDir: '写作/正文/第二卷' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('moveDocument: 定稿/摘要（只读 note，rename/move=false）→ CAPABILITY_DENIED', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '定稿', '摘要'), { recursive: true })
  writeFileSync(join(root, '定稿', '摘要', '0001.md'), '摘要', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_ro","nodeType":"document","path":"定稿/摘要/0001.md","parentId":null}',
    ].join('\n') + '\n',
  )
  const r = await svc.moveDocument({ docId: 'doc_ro', toDir: '素材' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('CAPABILITY_DENIED')
  rmSync(root, { recursive: true, force: true })
})

test('renameDocument: 改文件名，目录不变', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.renameDocument({ docId: 'doc_ch01', newName: '0001-序章.md' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第一卷/0001-序章.md')
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-序章.md'))).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

test('updateChapterMeta: 改标题 → fm 标题 + 文件名同步（章号-标题.md）', () => {
  const { root, svc } = makeBookWithChapter()
  const r = svc.updateChapterMeta('doc_ch01', { 标题: '序章' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第一卷/0001-序章.md')
  const fm = readFileSync(join(root, '写作', '正文', '第一卷', '0001-序章.md'), 'utf-8')
  expect(fm).toContain('标题: 序章')
  expect(fm).toContain('章号: 1') // 章号不变
  expect(fm).toContain('正文') // body 保留
  rmSync(root, { recursive: true, force: true })
})

test('updateChapterMeta: 改章号 → fm 章号 + 文件名同步', () => {
  const { root, svc } = makeBookWithChapter()
  const r = svc.updateChapterMeta('doc_ch01', { 章号: 5 })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第一卷/0005-开篇.md')
  const fm = readFileSync(join(root, '写作', '正文', '第一卷', '0005-开篇.md'), 'utf-8')
  expect(fm).toContain('章号: 5')
  expect(fm).toContain('标题: 开篇') // 标题不变
  rmSync(root, { recursive: true, force: true })
})

test('updateChapterMeta: 未知 docId → NOT_FOUND', () => {
  const { root, svc } = makeBookWithChapter()
  const r = svc.updateChapterMeta('doc_unknown', { 标题: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

/** 造短篇书：写作/正文/1-原标.md + book.yaml(kind=short) + 清单登记 doc_p01。 */
function makeBookWithPiece(): { root: string; svc: DocumentService } {
  const root = mkdtempSync(join(tmpdir(), 'w2a-piece-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(join(root, 'book.yaml'), 'kind: short\n', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '1-原标.md'), '---\n章号: 1\n标题: 原标\n---\n短篇正文', 'utf-8')
  writeFileSync(
    join(root, '项目', '文档清单.jsonl'),
    [
      '{"version":1,"type":"header"}',
      '{"id":"doc_p01","nodeType":"document","path":"写作/正文/1-原标.md","parentId":null,"status":"final"}',
    ].join('\n') + '\n',
  )
  execSync('git add -A && git commit -m init', { cwd: root, stdio: 'pipe' })
  return { root, svc: new DocumentService({ bookRoot: root }) }
}

test('updateChapterMeta（短篇）: 改标题 → fm 标题 + 文件名 rename（docId 不变）', () => {
  const { root, svc } = makeBookWithPiece()
  const r = svc.updateChapterMeta('doc_p01', { 标题: '新标' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 章号 1 → 3 位补零 001；标题更新
  expect(r.path).toBe('写作/正文/001-新标.md')
  expect(existsSync(join(root, '写作', '正文', '001-新标.md'))).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '1-原标.md'))).toBe(false)
  const fm = readFileSync(join(root, '写作', '正文', '001-新标.md'), 'utf-8')
  expect(fm).toContain('标题: 新标')
  expect(fm).toContain('章号: 1') // 章号不变
  expect(fm).toContain('短篇正文') // body 保留
  // docId 不变（清单 path 更新）
  const m = readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')
  expect(m).toContain('doc_p01')
  expect(m).toContain('写作/正文/001-新标.md')
  expect(m).not.toContain('写作/正文/1-原标.md')
  rmSync(root, { recursive: true, force: true })
})

test('updateChapterMeta（短篇）: 改章号 → fm 章号 + 文件名 rename（3 位补零）', () => {
  const { root, svc } = makeBookWithPiece()
  const r = svc.updateChapterMeta('doc_p01', { 章号: 12, 标题: '原标' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/012-原标.md')
  expect(existsSync(join(root, '写作', '正文', '012-原标.md'))).toBe(true)
  const fm = readFileSync(join(root, '写作', '正文', '012-原标.md'), 'utf-8')
  expect(fm).toContain('章号: 12')
  expect(fm).toContain('标题: 原标')
  rmSync(root, { recursive: true, force: true })
})

test('updateDocMeta: 改卷纲字段 → fm 更新，文件名不变', () => {
  const { root, svc } = makeBookWithChapter()
  writeFileSync(join(root, '大纲', '卷纲', '第一卷.md'), '---\n卷名: 第一卷\n---\n卷纲正文', 'utf-8')
  appendFileSync(
    join(root, '项目', '文档清单.jsonl'),
    '{"id":"doc_vol1","nodeType":"document","path":"大纲/卷纲/第一卷.md","parentId":null}\n',
  )
  const r = svc.updateDocMeta('doc_vol1', { 卷主线: '主角崛起', 字数目标: 300000 })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('大纲/卷纲/第一卷.md') // 文件名不变
  const fm = readFileSync(join(root, '大纲', '卷纲', '第一卷.md'), 'utf-8')
  expect(fm).toContain('卷主线: 主角崛起')
  expect(fm).toContain('字数目标: 300000')
  expect(fm).toContain('卷纲正文') // body 保留
  rmSync(root, { recursive: true, force: true })
})

test('updateDocMeta: 未知 docId → NOT_FOUND', () => {
  const { root, svc } = makeBookWithChapter()
  const r = svc.updateDocMeta('doc_unknown', { 主题: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('updateDocMeta: 裸 md 无 fm → 自动包裹 fm 写字段', () => {
  const { root, svc } = makeBookWithChapter()
  writeFileSync(join(root, '大纲', '总纲.md'), '# 总纲\n\n（待补）\n', 'utf-8')
  appendFileSync(
    join(root, '项目', '文档清单.jsonl'),
    '{"id":"doc_syn","nodeType":"document","path":"大纲/总纲.md","parentId":null}\n',
  )
  const r = svc.updateDocMeta('doc_syn', { 主题: '复仇', 字数目标: 2000000 })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const fm = readFileSync(join(root, '大纲', '总纲.md'), 'utf-8')
  expect(fm).toContain('主题: 复仇')
  expect(fm).toContain('字数目标: 2000000')
  expect(fm).toContain('# 总纲') // 原裸 md 正文保留为 body
  rmSync(root, { recursive: true, force: true })
})

test('copyDocument: 复制内容 + 新 docId + 清单登记 + 源不变', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.copyDocument({ docId: 'doc_ch01', relPath: '写作/正文/第一卷/0002-开篇 副本.md' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.docId).toMatch(/^doc_/)
  expect(r.docId).not.toBe('doc_ch01')
  expect(r.path).toBe('写作/正文/第一卷/0002-开篇 副本.md')
  // 副本内容同源（fm + body 原样复制）
  const copy = readFileSync(join(root, '写作', '正文', '第一卷', '0002-开篇 副本.md'), 'utf-8')
  expect(copy).toContain('章号: 1')
  expect(copy).toContain('正文')
  // 源文件不变
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'))).toBe(true)
  // 清单登记新 docId + 副本 path
  const m = readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')
  expect(m).toContain(r.docId)
  expect(m).toContain('0002-开篇 副本.md')
  rmSync(root, { recursive: true, force: true })
})

test('copyDocument: 源 docId 未登记 → NOT_FOUND', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.copyDocument({ docId: 'doc_unknown', relPath: '写作/正文/第一卷/0002-x.md' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})

test('copyDocument: 目标已存在 → ALREADY_EXISTS', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.copyDocument({ docId: 'doc_ch01', relPath: '写作/正文/第一卷/0001-开篇.md' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('ALREADY_EXISTS')
  rmSync(root, { recursive: true, force: true })
})

test('copyDocument: 路径越出 → PATH_ESCAPE', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.copyDocument({ docId: 'doc_ch01', relPath: '../etc/passwd' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('PATH_ESCAPE')
  rmSync(root, { recursive: true, force: true })
})

test('结构性操作触发旧书建清单（W0 §4.2）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'w2a-nomanifest-'))
  execSync('git init && git config user.email t@t.com && git config user.name t && git config commit.gpgsign false', { cwd: root, stdio: 'pipe' })
  mkdirSync(join(root, '工作区'), { recursive: true })
  const svc = new DocumentService({ bookRoot: root })
  // 旧书无清单
  expect(existsSync(join(root, '项目', '文档清单.jsonl'))).toBe(false)
  // create 触发建清单
  const r = await svc.createDocument({ relPath: '素材/灵感.md', content: '---\n---\n灵感' })
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, '项目', '文档清单.jsonl'))).toBe(true) // 清单已建
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain(r.ok ? r.docId : '')
  rmSync(root, { recursive: true, force: true })
})

// ── legacy 临时 ID 兜底（旧书/外部落盘的文件无清单登记）────────────

test('trashDocument: legacy 临时 ID → 扫盘反查 + 补登记清单后删除成功', async () => {
  const { root, svc } = makeBookWithChapter()
  // 外部落盘的设定文件：不在清单里，树给它 legacyId(path) 当运行期 ID
  mkdirSync(join(root, '设定', '伏笔'), { recursive: true })
  writeFileSync(join(root, '设定', '伏笔', '神秘印记.md'), '---\n标题: 神秘印记\n---\n正文', 'utf-8')
  const relPath = '设定/伏笔/神秘印记.md'
  const docId = legacyId(relPath)
  expect(docId).toMatch(/^legacy:/)

  const r = await svc.trashDocument({ docId })
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, relPath))).toBe(false) // 已移入回收站
  // 软删会把条目从文档清单移除，故落地痕迹看回收站清单（登记的正是这个 legacy ID）
  expect(readFileSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'), 'utf-8')).toContain(docId)
  rmSync(root, { recursive: true, force: true })
})

test('renameDocument: legacy 临时 ID 同样可改名（清单 path 跟随更新）', async () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '设定', '角色'), { recursive: true })
  writeFileSync(join(root, '设定', '角色', '林远.md'), '---\n姓名: 林远\n---\n主角', 'utf-8')

  const r = await svc.renameDocument({ docId: legacyId('设定/角色/林远.md'), newName: '林远之.md' })
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, '设定', '角色', '林远之.md'))).toBe(true)
  expect(readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')).toContain('设定/角色/林远之.md')
  rmSync(root, { recursive: true, force: true })
})

test('lookupPathByDocId: 非 legacy 前缀的未知 ID 仍 NOT_FOUND（不扫盘）', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.trashDocument({ docId: 'doc_不存在' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('NOT_FOUND')
  rmSync(root, { recursive: true, force: true })
})
