/**
 * W2A T4 —— DocumentService 结构性操作（createDocument/moveDocument/renameDocument）单测。
 * 与 W1 save 测试分文件。覆盖：落盘+清单登记+docId、ALREADY_EXISTS、CAPABILITY_DENIED、
 * PATH_ESCAPE、跨卷移动章号不变、清单 path 更新、移动前 snapshot、rename、NOT_FOUND。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { DocumentService } from '../../src/document/service.js'
import { parseRealmSystems, splitFrontMatter, parseFlat } from '../../src/format/frontmatter.js'
import { getBookTreeIndex, type TreeNode } from '../../src/document/tree.js'
import { legacyId } from '../../src/document/stable-id.js'
import { findUnsettled } from '../../src/document/journal.js'

/** 深度优先按 docId 找叶子（树索引验证用）。 */
function findNodeByDocId(nodes: TreeNode[], docId: string): TreeNode | undefined {
  for (const n of nodes) {
    if (!n.isDirectory && n.docId === docId) return n
    const hit = findNodeByDocId(n.children, docId)
    if (hit) return hit
  }
  return undefined
}

/** 造书：写作/正文/第一卷/0001-开篇 + 项目清单登记 doc_ch01 + git init。 */
function makeBookWithChapter(): { root: string; svc: DocumentService } {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-svc-'))
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

// ── B-3（第六十轮）：updateChapterMeta 标题消毒走 sanitizeChapterTitle 单源 ──

test('B-3: updateChapterMeta 改标题含 Windows 非法字符/控制字符 → 文件名单源消毒（不再仅替换 \\ /）', () => {
  const { root, svc } = makeBookWithChapter()
  const r = svc.updateChapterMeta('doc_ch01', { 标题: '新:题*目?\n' })
  expect(r.ok).toBe(true)
  if (!r.ok) { rmSync(root, { recursive: true, force: true }); return }
  // : * ? 各自 → _；\n 剥除（修复前仅替换 \\ /，换行/非法字符直进文件名）
  expect(r.path).toBe('写作/正文/第一卷/0001-新_题_目_.md')
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-新_题_目_.md'))).toBe(true)
  rmSync(root, { recursive: true, force: true })
})

test('B-3: updateChapterMeta 超长标题 → 双封顶截断（80 汉字撞 120 字节上限，R-10 口径）', () => {
  const { root, svc } = makeBookWithChapter()
  const longTitle = '长'.repeat(80)
  const r = svc.updateChapterMeta('doc_ch01', { 标题: longTitle })
  expect(r.ok).toBe(true)
  if (!r.ok) { rmSync(root, { recursive: true, force: true }); return }
  // C-3（二十九轮）：rename 落名过 sanitizeCreateSegment 单源后，整段（含 '0001-' 前缀
  // 5 字节）共用 120 字节预算 → floor((120-5)/3) = 38 字，与 createDocument 同源口径
  //（此前标题段单独 120B = 40 字；落名二次消毒按整段封顶收 38 字）。
  if (r.ok) expect(r.path!.split('/').pop()).toBe(`0001-${'长'.repeat(38)}.md`)
  rmSync(root, { recursive: true, force: true })
})

// ── B-6（第六十轮）：doCreate 落盘走 tmp+link 独占创建 ──

test('B-6: createDocument 成功 → 目标目录无 tmp 残留（link 后 tmp 即清）', async () => {
  const { root, svc } = makeBookWithChapter()
  const r = await svc.createDocument({ relPath: '写作/正文/第一卷/0002-新章.md', content: '正文' })
  expect(r.ok).toBe(true)
  const dir = join(root, '写作', '正文', '第一卷')
  expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false)
  expect(readFileSync(join(dir, '0002-新章.md'), 'utf-8')).toBe('正文')
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

test('updateChapterMeta: 非 UTF-8（GBK）文件 → 拒绝写回防字节损坏（第五轮）', () => {
  const { root, svc } = makeBookWithChapter()
  const fp = join(root, '写作', '正文', '第一卷', '0001-开篇.md')
  // GBK「序」(0xD0F2) +「正文」(0xD5FD CEC4)：utf-8 读入产生 U+FFFD 替换符
  const gbk = Buffer.concat([
    Buffer.from('---\n章号: 1\n标题: ', 'utf-8'),
    Buffer.from([0xd0, 0xf2]),
    Buffer.from('\n---\n', 'utf-8'),
    Buffer.from([0xd5, 0xfd, 0xce, 0xc4]),
  ])
  writeFileSync(fp, gbk)
  const before = readFileSync(fp)
  const r = svc.updateChapterMeta('doc_ch01', { 标题: '新标' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('WRITE_ERROR')
  expect(r.reason).toContain('UTF-8')
  // 原始字节一字不动（拒绝即零副作用——文件名/清单也不动）
  expect(readFileSync(fp).equals(before)).toBe(true)
  expect(existsSync(join(root, '写作', '正文', '第一卷', '0001-新标.md'))).toBe(false)
  rmSync(root, { recursive: true, force: true })
})

/** 造短篇书：写作/正文/1-原标.md + book.yaml(kind=short) + 清单登记 doc_p01。 */
function makeBookWithPiece(): { root: string; svc: DocumentService } {
  const root = mkdtempTracked(join(tmpdir(), 'w2a-piece-'))
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

// ── N-7（第十二轮）：短篇章纲跟随改名走清单/journal 纪律 ──

/** 造短篇书 + 已登记章纲（大纲/章纲/1-原标.md → doc_pl01）。 */
function makeBookWithPieceList(): { root: string; svc: DocumentService } {
  const { root, svc } = makeBookWithPiece()
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '章纲', '1-原标.md'), '---\n标题: 原标\n---\n章纲内容', 'utf-8')
  appendFileSync(
    join(root, '项目', '文档清单.jsonl'),
    '{"id":"doc_pl01","nodeType":"document","path":"大纲/章纲/1-原标.md","parentId":null}\n',
  )
  execSync('git add -A && git commit -m piece-list', { cwd: root, stdio: 'pipe' })
  return { root, svc }
}

test('N-7: 章纲已登记 → 跟随改名走 doMoveOrRename——清单 path 同步、docId 稳定、journal 收口、无孤儿条目', () => {
  const { root, svc } = makeBookWithPieceList()
  getBookTreeIndex(root) // 预热缓存（验证 rename 后索引重建按新路径挂 docId）
  const r = svc.updateChapterMeta('doc_p01', { 标题: '新标' })
  expect(r.ok).toBe(true)

  // 章纲文件跟随改名（修复前裸 rename 也做到）
  expect(existsSync(join(root, '大纲', '章纲', '001-新标.md'))).toBe(true)
  expect(existsSync(join(root, '大纲', '章纲', '1-原标.md'))).toBe(false)

  // 修复点①：清单条目 path 同步更新——修复前残留指向旧路径的孤儿条目
  const m = readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')
  expect(m).toContain('"id":"doc_pl01"')
  expect(m).toContain('大纲/章纲/001-新标.md')
  expect(m).not.toContain('大纲/章纲/1-原标.md')

  // 修复点②：docId 稳定——树索引重建后按 docId 反查命中新路径（修复前 miss → 退化 legacyId）
  const byId = findNodeByDocId(getBookTreeIndex(root).nodes, 'doc_pl01')
  expect(byId?.path).toBe('大纲/章纲/001-新标.md')

  // 修复点③：journal 收口（无悬置 pending）+ snapshot 留底（doMoveOrRename 纪律）
  const jDir = join(root, '工作区', '.journal')
  const journals = readdirSync(jDir).filter((n) => n.startsWith('doc_pl01'))
  expect(journals).toHaveLength(1)
  expect(findUnsettled(join(jDir, journals[0]!))).toHaveLength(0)
  expect(existsSync(join(root, '工作区', '.版本', 'doc_pl01'))).toBe(true)

  // 正文 rename 契约不变：路径同样换新
  expect(r.ok && r.path).toBe('写作/正文/001-新标.md')
  rmSync(root, { recursive: true, force: true })
})

test('N-7: 章纲未登记（从未结构性操作）→ 裸 rename 回落：文件跟随改名、清单无章纲条目、正文 rename ok', () => {
  const { root, svc } = makeBookWithPiece()
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  writeFileSync(join(root, '大纲', '章纲', '1-原标.md'), '章纲内容（未登记）', 'utf-8')

  const r = svc.updateChapterMeta('doc_p01', { 标题: '新标' })
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, '大纲', '章纲', '001-新标.md'))).toBe(true)
  expect(existsSync(join(root, '大纲', '章纲', '1-原标.md'))).toBe(false)
  // 无条目可孤儿：清单里只有正文条目（path 已随 doMoveOrRename 更新），无章纲行
  const m = readFileSync(join(root, '项目', '文档清单.jsonl'), 'utf-8')
  expect(m).toContain('写作/正文/001-新标.md')
  expect(m).not.toContain('大纲/章纲/')
  rmSync(root, { recursive: true, force: true })
})

// ── N-11（第十二轮）：引号章号归一（文件名派生不吃字符串劣化）──

test('N-11: 短篇 fm 章号为引号数字串（"7"）→ 文件名仍按 3 位补零派生（007-）', () => {
  const { root, svc } = makeBookWithPiece()
  // 作者手写/外部工具写回的引号包裹章号——parseFlat 读回 string，旧 typeof 判不过
  writeFileSync(join(root, '写作', '正文', '1-原标.md'), '---\n章号: "7"\n标题: 原标\n---\n短篇正文', 'utf-8')
  const r = svc.updateChapterMeta('doc_p01', { 标题: '新标' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/007-新标.md')
  // fm 原值不回写（字节级忠实）：仍是引号串
  expect(readFileSync(join(root, '写作', '正文', '007-新标.md'), 'utf-8')).toContain('章号: "7"')
  rmSync(root, { recursive: true, force: true })
})

test('N-11: 长篇 fm 章号为引号数字串（"12"）→ 文件名仍按 4 位补零派生（0012-）', () => {
  const { root, svc } = makeBookWithChapter()
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), '---\n章号: "12"\n标题: 开篇\n---\n正文', 'utf-8')
  const r = svc.updateChapterMeta('doc_ch01', { 标题: '新标' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.path).toBe('写作/正文/第一卷/0012-新标.md')
  rmSync(root, { recursive: true, force: true })
})

test('N-11: 章号非数字（小数串/空串）→ 维持原 basename 前缀回落，不误派生', () => {
  const { root, svc } = makeBookWithPiece()
  writeFileSync(join(root, '写作', '正文', '1-原标.md'), '---\n章号: "3.5"\n标题: 原标\n---\n短篇正文', 'utf-8')
  const r = svc.updateChapterMeta('doc_p01', { 标题: '新标' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 回落 basename 前缀 1-（原文件名的章号段），不产 3.5 派生名
  expect(r.path).toBe('写作/正文/1-新标.md')
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

// ── R65-1（十三轮）：fm 读改写不得摧毁嵌套结构 ──

const REALM_FILE = [
  '---',
  '名称: 境界体系',
  '体系:',
  '  - 名称: 修真境界',
  '    序列: [炼气, 筑基, 金丹, 元婴]',
  '  - 名称: 武者等级',
  '    序列: [后天, 先天, 宗师]',
  '---',
  '',
].join('\n')

test('R65-1: updateDocMeta 补平铺键 → 境界体系嵌套结构完好（成长线机检不失明）', () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '设定'), { recursive: true })
  writeFileSync(join(root, '设定', '境界体系.md'), REALM_FILE, 'utf-8')
  appendFileSync(
    join(root, '项目', '文档清单.jsonl'),
    '{"id":"doc_realm","nodeType":"document","path":"设定/境界体系.md","parentId":null}\n',
  )
  const r = svc.updateDocMeta('doc_realm', { 标签: ['修真', '升级流'] })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const after = readFileSync(join(root, '设定', '境界体系.md'), 'utf-8')
  // 旧实现：parseFlat RMW 把体系压平成 `体系: ""` + 伪平铺键互相覆盖 → parseRealmSystems 返回 []
  const systems = parseRealmSystems(splitFrontMatter(after)!.fmRaw)
  expect(systems).toEqual([
    { 名称: '修真境界', 序列: ['炼气', '筑基', '金丹', '元婴'] },
    { 名称: '武者等级', 序列: ['后天', '先天', '宗师'] },
  ])
  expect(parseFlat(splitFrontMatter(after)!.fmRaw).get('标签')).toEqual(['修真', '升级流'])
  rmSync(root, { recursive: true, force: true })
})

test('R65-1: updateDocMeta 改嵌套键本体（体系）→ BAD_INPUT 拒绝（fail-loud 防平铺化）', () => {
  const { root, svc } = makeBookWithChapter()
  mkdirSync(join(root, '设定'), { recursive: true })
  writeFileSync(join(root, '设定', '境界体系.md'), REALM_FILE, 'utf-8')
  appendFileSync(
    join(root, '项目', '文档清单.jsonl'),
    '{"id":"doc_realm","nodeType":"document","path":"设定/境界体系.md","parentId":null}\n',
  )
  const r = svc.updateDocMeta('doc_realm', { 体系: 'x' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('BAD_INPUT')
  // 文件未被触碰
  expect(readFileSync(join(root, '设定', '境界体系.md'), 'utf-8')).toBe(REALM_FILE)
  rmSync(root, { recursive: true, force: true })
})

test('updateDocMeta: 非 UTF-8（GBK）文件 → 拒绝写回防字节损坏（第五轮）', () => {
  const { root, svc } = makeBookWithChapter()
  writeFileSync(join(root, '大纲', '卷纲', '第一卷.md'), '---\n卷名: 第一卷\n---\n卷纲正文', 'utf-8')
  appendFileSync(
    join(root, '项目', '文档清单.jsonl'),
    '{"id":"doc_vol1","nodeType":"document","path":"大纲/卷纲/第一卷.md","parentId":null}\n',
  )
  // 覆写为 GBK 编码正文（「正文」= 0xD5FD CEC4，utf-8 读入产生 U+FFFD）
  const fp = join(root, '大纲', '卷纲', '第一卷.md')
  const gbk = Buffer.concat([
    Buffer.from('---\n卷名: 第一卷\n---\n卷纲', 'utf-8'),
    Buffer.from([0xd5, 0xfd, 0xce, 0xc4]),
  ])
  writeFileSync(fp, gbk)
  const before = readFileSync(fp)
  const r = svc.updateDocMeta('doc_vol1', { 卷主线: '主角崛起' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('WRITE_ERROR')
  expect(r.reason).toContain('UTF-8')
  expect(readFileSync(fp).equals(before)).toBe(true)
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

test('P5-数据层（第七轮）copyDocument: 非 UTF-8 原始字节原样复制（GBK 源不经 utf-8 往返转写）', async () => {
  const { root, svc } = makeBookWithChapter()
  // GBK「正文」= D5 FD CE C4（非法 UTF-8）：旧实现 utf-8 读 + utf-8 写会把这 4 字节
  // 转写成 U+FFFD（EF BF BD），副本不再是源的字节级拷贝
  const gbk = Buffer.concat([Buffer.from('---\n章号: 1\n---\n', 'utf-8'), Buffer.from([0xd5, 0xfd, 0xce, 0xc4])])
  writeFileSync(join(root, '写作', '正文', '第一卷', '0001-开篇.md'), gbk)
  const r = await svc.copyDocument({ docId: 'doc_ch01', relPath: '写作/正文/第一卷/0002-开篇 副本.md' })
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const copied = readFileSync(join(root, '写作', '正文', '第一卷', '0002-开篇 副本.md'))
  expect(Buffer.compare(copied, gbk)).toBe(0)
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
  // R61-11（第六十一轮）：补丢内容可捕性——并发窄窗下 atomicWriteFile 会静默覆盖
  // 已建目标；独占创建后目标原内容必须原样保留
  const dstAbs = join(root, '写作/正文/第一卷/0001-开篇.md')
  const before = readFileSync(dstAbs, 'utf8')
  const r = await svc.copyDocument({ docId: 'doc_ch01', relPath: '写作/正文/第一卷/0001-开篇.md' })
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.code).toBe('ALREADY_EXISTS')
  expect(readFileSync(dstAbs, 'utf8')).toBe(before)
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
  const root = mkdtempTracked(join(tmpdir(), 'w2a-nomanifest-'))
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
