import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBook } from '../../src/export/index.js'
import { SUBMISSION_TEMPLATES } from '../../src/metrics/short-index.js'

// ── 辅助 fixture ────────────────────────────────

/** 造一个最小长篇书库（book.yaml + 空的 写作/正文/） */
function makeLongBook(title: string): string {
  const root = mkdtempSync(join(tmpdir(), 'export-long-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  return root
}

/** 写一章长篇定稿（front matter + 正文） */
function writeLongChapter(root: string, num: number, title: string, body: string, fileName = title): void {
  // ff-P1-2：源文件名单段须 ≤255 字节可移植（ext4 CI 腿按字节判，APFS 按码位判）——
  // 超长标题只进 front matter 内容，不进源文件名；导出侧截断由 fm 标题驱动，不受影响。
  writeFileSync(
    join(root, '写作', '正文', `${num}-${fileName}.md`),
    `---\n章号: ${num}\n标题: ${title}\n---\n${body}`,
    'utf-8',
  )
}

// ── 剥 front matter（#36 §6 净化）─────────────────

test('exportBook: 导出产物不含 front matter', () => {
  const root = makeLongBook('剥fm测试')
  writeLongChapter(root, 1, '北境的雪', '雪落在了城墙上。')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    const merged = readFileSync(join(root, '工作区', '导出', '全本-剥fm测试.md'), 'utf-8')
    // front matter 被剥干净
    expect(merged).not.toContain('---')
    expect(merged).not.toContain('章号')
    // 标题 + 正文保留
    expect(merged).toContain('# 北境的雪')
    expect(merged).toContain('雪落在了城墙上')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── #% 批注行过滤（W0 §6 过渡期，导出不泄漏批注）────

test('exportBook: #% 批注行被过滤', () => {
  const root = makeLongBook('批注过滤')
  // P3-14：行首整行批注 + 行中批注尾巴（正文#%批注）都要滤净
  writeLongChapter(root, 1, '批注测试', '#% 这是作者批注\n正文内容#%行中批注\n#% 又一条批注')
  try {
    exportBook({ bookRoot: root, format: 'merged' })
    const merged = readFileSync(join(root, '工作区', '导出', '全本-批注过滤.md'), 'utf-8')
    expect(merged).not.toContain('#%')
    expect(merged).not.toContain('作者批注')
    expect(merged).not.toContain('行中批注')
    expect(merged).toContain('正文内容')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 长篇正常导出（多章 + both 形态）──────────────

test('exportBook: 长篇多章 both 导出（merged + split）', () => {
  const root = makeLongBook('多章书')
  // 故意倒序写入，验证按章号数值排序（非文件名序）
  writeLongChapter(root, 2, '第二章', '第二章正文。')
  writeLongChapter(root, 1, '第一章', '第一章正文。')
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(2)
    expect(r.unit).toBe('章')

    // merged：含两章、按章号排序、章间 --- 分隔
    const merged = readFileSync(join(root, '工作区', '导出', '全本-多章书.md'), 'utf-8')
    expect(merged).toContain('# 第一章')
    expect(merged).toContain('# 第二章')
    expect(merged.indexOf('第一章')).toBeLessThan(merged.indexOf('第二章'))
    expect(merged).toContain('---') // 章间分隔线

    // split：按章号数值排序 + 3 位补零文件名（长短统一）
    expect(r.files.some((f) => f.includes('分章/001-第一章.md'))).toBe(true)
    expect(r.files.some((f) => f.includes('分章/002-第二章.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 短篇分支（kind: short）──────────────────────

test('exportBook: 短篇分支产全本 + 分章 + 投稿视图', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-short-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 短篇集', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(root, '写作', '正文', '1-雪夜.md'),
    '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。',
    'utf-8',
  )
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.unit).toBe('章')
    expect(r.chapterCount).toBe(1)
    // 短篇必出投稿视图
    expect(r.files.some((f) => f.includes('投稿视图-短篇集.md'))).toBe(true)
    // merged 文件名为「全本-」前缀
    expect(r.files.some((f) => f.includes('全本-短篇集.md'))).toBe(true)
    // split 目录为「分章」+ 3 位补零
    expect(r.files.some((f) => f.includes('分章/001-雪夜.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 平台配置化（P2-PROD-5）────────────────────────

test('exportBook: 新平台只需注册模板表即生效（配置化，无需改导出代码）', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-platform-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 平台书', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。', 'utf-8')
  // 注册一个新平台（模拟新增平台只需加模板表一项）
  const custom = { platform: 'custom', label: '自定义平台', titleStyle: '自定义标题风格', introLength: '99-199 字', sellingPoints: ['自定义卖点'] }
  SUBMISSION_TEMPLATES.custom = custom
  try {
    const r = exportBook({ bookRoot: root, format: 'merged', platform: 'custom' })
    expect(r.ok).toBe(true)
    const view = readFileSync(join(root, '工作区', '导出', '投稿视图-平台书-自定义平台.md'), 'utf-8')
    expect(view).toContain('自定义标题风格')
    expect(view).toContain('99-199 字')
    expect(view).toContain('自定义卖点')
  } finally {
    delete SUBMISSION_TEMPLATES.custom // 清理，不污染其他用例
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 未知平台 fallback generic（不崩溃）', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-unkplat-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 未知平台书', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged', platform: 'not-exist' })
    expect(r.ok).toBe(true)
    const view = readFileSync(join(root, '工作区', '导出', '投稿视图-未知平台书.md'), 'utf-8')
    expect(view).toContain('平台模板：通用') // generic fallback
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 低级项（第六轮）：投稿视图旧产物清理（对齐「全本-」第五轮口径）——书改名后同槽位
// 旧文件残留会让作者拿错稿。P5-管线（第七轮）口径更新：槽位归属由「当前书名+平台后缀」
// 精确名判定——他平台的「旧书名」残留同属拿错稿风险，一并清；各平台「当前书名」
// 产物仍保留（多平台视图不互删，见下一样式的精确保护测试）
test('exportBook: 投稿视图清同槽位旧文件（改名形变）；他平台旧书名产物同属拿错稿风险一并清', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-subm-clear-'))
  const writeCfg = (title: string): void => {
    writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'kind: short', '', 'book:', `  title: ${title}`, '  genre: 悬疑'].join('\n'), 'utf-8')
  }
  writeCfg('旧名书')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。', 'utf-8')
  try {
    exportBook({ bookRoot: root, format: 'merged' }) // generic 槽位：投稿视图-旧名书.md
    exportBook({ bookRoot: root, format: 'merged', platform: 'wechat' }) // 公众号槽位：投稿视图-旧名书-公众号.md
    writeCfg('新名书')
    exportBook({ bookRoot: root, format: 'merged' }) // generic 槽位：投稿视图-新名书.md
    const names = readdirSync(join(root, '工作区', '导出')).filter((f) => f.startsWith('投稿视图-'))
    expect(names).toContain('投稿视图-新名书.md')
    expect(names).not.toContain('投稿视图-旧名书.md') // 同槽位旧产物已清（拿错稿防线）
    // 第七轮口径：旧名公众号产物与新名 generic 槽位同为「拿错稿」形态，不再按
    // 尾部后缀猜测归属而永久保留
    expect(names).not.toContain('投稿视图-旧名书-公众号.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// P5-管线（第七轮）：平台槽位归属「前缀（当前书名）+平台后缀」精确判定——书名恰以
// 平台 label（如「-公众号」）结尾时，generic 旧产物在文件名上与他平台形态无异，
// 旧 endsWith 判定把它永远当成他平台产物保留；各平台「当前书名」产物仍精确保留
test('exportBook: 书名以平台 label 结尾时 generic 旧产物照清；各平台当前产物精确保留', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-subm-label-'))
  const writeCfg = (title: string): void => {
    writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'kind: short', '', 'book:', `  title: ${title}`, '  genre: 悬疑'].join('\n'), 'utf-8')
  }
  writeCfg('夜航-公众号')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。', 'utf-8')
  try {
    exportBook({ bookRoot: root, format: 'merged' }) // generic 槽位：投稿视图-夜航-公众号.md
    writeCfg('夜航贰')
    // 模拟他平台「当前书名」产物在位（多平台视图，应精确保留）
    writeFileSync(join(root, '工作区', '导出', '投稿视图-夜航贰-公众号.md'), '公众号当前产物', 'utf-8')
    exportBook({ bookRoot: root, format: 'merged' }) // generic 槽位：投稿视图-夜航贰.md
    const names = readdirSync(join(root, '工作区', '导出')).filter((f) => f.startsWith('投稿视图-'))
    expect(names).toContain('投稿视图-夜航贰.md')
    // 旧 endsWith 归属判定下，这个旧 generic 产物以 -公众号.md 结尾 → 被误当他平台产物永不清
    expect(names).not.toContain('投稿视图-夜航-公众号.md')
    expect(names).toContain('投稿视图-夜航贰-公众号.md') // 他平台当前产物精确保留
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 空正文边界 ──────────────────────────────────

test('exportBook: 无定稿目录 → ok:false', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-nodir-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'book:', '  title: 空书'].join('\n'),
    'utf-8',
  )
  try {
    const r = exportBook({ bookRoot: root })
    expect(r.ok).toBe(false)
    expect(r.chapterCount).toBe(0)
    expect(typeof r.error).toBe('string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 定稿目录存在但无章节文件 → ok:false', () => {
  const root = makeLongBook('空目录书')
  try {
    const r = exportBook({ bookRoot: root })
    expect(r.ok).toBe(false)
    expect(r.chapterCount).toBe(0)
    expect(typeof r.error).toBe('string')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 路径穿越净化（K1）──────────────────────────────

test('exportBook: 书名含路径分隔符 → 文件名净化不越出导出目录', () => {
  // bookTitle 来自 book.yaml（不可信），含 ../ 时须净化，防 join 后上跳到导出目录外
  const root = makeLongBook('../evil')
  writeLongChapter(root, 1, '安全标题', '正文内容。')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    // 路径分隔符被替换为 _，文件路径不含 ../ 穿越
    expect(r.files.every((f) => !f.includes('../'))).toBe(true)
    // 净化后文件确实落在导出目录内（../evil → .._evil）
    const merged = readFileSync(join(root, '工作区', '导出', '全本-.._evil.md'), 'utf-8')
    expect(merged).toContain('安全标题')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── V-P2-2：导出滤未定稿（「导出定稿正文」名要符实）──────────────────

import { readManifest, writeManifest } from '../../src/document/manifest.js'
import type { ManifestEntry } from '../../src/document/manifest.js'

/** 在书库写文档清单（含可选定稿基线）。entry.path 为书仓库相对路径。 */
function writeManifestFile(root: string, entries: ManifestEntry[]): void {
  const m = readManifest(join(root, '项目', '文档清单.jsonl')) // 无文件 → 默认骨架
  for (const e of entries) m.entries.set(e.id, e)
  mkdirSync(join(root, '项目'), { recursive: true })
  writeManifest(join(root, '项目', '文档清单.jsonl'), m)
}

function finalizedEntry(id: string, path: string): ManifestEntry {
  return { id, nodeType: 'document', path, parentId: null, finalizedRevision: 'sha256:fin-' + id }
}

test('exportBook: 未定稿章被滤出导出（V-P2-2），skippedDrafts 计数', () => {
  const root = makeLongBook('滤草稿')
  writeLongChapter(root, 1, '已定稿章', '定稿内容。')
  writeLongChapter(root, 2, '未定稿章', '还在写的半成品。')
  writeManifestFile(root, [
    finalizedEntry('doc_1', '写作/正文/1-已定稿章.md'),
    { id: 'doc_2', nodeType: 'document', path: '写作/正文/2-未定稿章.md', parentId: null },
  ])
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.skippedDrafts).toBe(1)
    const merged = readFileSync(join(root, '工作区', '导出', '全本-滤草稿.md'), 'utf-8')
    expect(merged).toContain('定稿内容')
    expect(merged).not.toContain('半成品')
    expect(r.files.some((f) => f.includes('分章/002-'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 全部未定稿 → ok:false + 人话提示', () => {
  const root = makeLongBook('全草稿')
  writeLongChapter(root, 1, '草稿章', '内容。')
  writeManifestFile(root, [{ id: 'doc_1', nodeType: 'document', path: '写作/正文/1-草稿章.md', parentId: null }])
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未定稿')
    expect(r.skippedDrafts).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('exportBook: 短篇投稿视图同口径滤未定稿', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-shortfin-'))
  writeFileSync(
    join(root, 'book.yaml'),
    ['spec_version: 1', 'kind: short', '', 'book:', '  title: 短篇滤稿', '  genre: 悬疑'].join('\n'),
    'utf-8',
  )
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-成品.md'), '---\n章号: 1\n标题: 成品\n---\n成品正文内容足够长。', 'utf-8')
  writeFileSync(join(root, '写作', '正文', '2-草稿.md'), '---\n章号: 2\n标题: 草稿\n---\n草稿正文内容足够长。', 'utf-8')
  writeManifestFile(root, [finalizedEntry('doc_s1', '写作/正文/1-成品.md')])
  try {
    const r = exportBook({ bookRoot: root, format: 'both' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    const view = readFileSync(join(root, '工作区', '导出', '投稿视图-短篇滤稿.md'), 'utf-8')
    expect(view).toContain('成品')
    expect(view).not.toContain('| 002 |')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── X-P2-4：超长文件名截断 + 单章级问题降级为警告 ──

test('X-P2-4: 超长章标题文件名截断（80 码位封顶，ASCII 不触字节封顶），不再因文件名过长写失败', () => {
  const root = makeLongBook('长标题书')
  const longTitle = 'a'.repeat(300)
  writeLongChapter(root, 1, longTitle, '正文。', 'long-title')
  try {
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    const names = readdirSync(join(root, '工作区', '导出', '分章'))
    expect(names).toHaveLength(1)
    // 码位封顶：`001-` + 标题截 80 码位（ASCII 80 字节，远未触字节封顶）+ `.md`；字节封顶见 FF-F3
    expect(Array.from(names[0]!).length).toBe('001-'.length + 80 + '.md'.length)
    expect(Buffer.byteLength(names[0]!, 'utf8')).toBeLessThanOrEqual(255)
    // 只有文件名截，内容里标题完整
    const body = readFileSync(join(root, '工作区', '导出', '分章', names[0]!), 'utf-8')
    expect(body.startsWith(`# ${longTitle}`)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FF-F3: 4 字节字符标题按字节封顶——码位 80 × 4B = 320B 超限，截到单段 ≤255 字节', () => {
  const root = makeLongBook('字节截断书')
  const emojiTitle = '🎉'.repeat(120)
  writeLongChapter(root, 1, emojiTitle, '正文。', 'emoji-title')
  try {
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    const names = readdirSync(join(root, '工作区', '导出', '分章'))
    expect(names).toHaveLength(1)
    // 字节预算 = (255 - 52 原子写临时名预留) - 4('001-') - 3('.md') = 196B → 49 个 4 字节字符
    // （临时名 `.{名}.{pid}.{uuid}.tmp` 会再占 ≤49B，故最终名不能贴 255B 截——ext4 CI 实证）
    expect(Buffer.byteLength(names[0]!, 'utf8')).toBeLessThanOrEqual(255)
    expect(Array.from(names[0]!).length).toBe('001-'.length + 49 + '.md'.length)
    // 不变量自查（平台无关）：最终名 + 最长临时后缀 `.{pid7}.{uuid36}.tmp` 仍须 ≤255B，
    // 否则 ext4 上 ENAMETOOLONG 而 APFS 本地恒绿
    expect(Buffer.byteLength(names[0]!, 'utf8') + 1 + 7 + 1 + 36 + 4).toBeLessThanOrEqual(255)
    // 内容里标题完整不截
    const body = readFileSync(join(root, '工作区', '导出', '分章', names[0]!), 'utf-8')
    expect(body.startsWith(`# ${emojiTitle}`)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-4: 个别坏章（解析失败）跳过并记警告，不再拖垮整本导出', () => {
  const root = makeLongBook('坏章降级')
  writeLongChapter(root, 1, '好章', '好章正文。')
  // 无 front matter 的残留草稿 → readChapterDir 解析失败
  writeFileSync(join(root, '写作', '正文', '0002-坏章.md'), '没有 front matter 的草稿文件。', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings![0]).toContain('0002-坏章.md')
    const merged = readFileSync(join(root, '工作区', '导出', '全本-坏章降级.md'), 'utf-8')
    expect(merged).toContain('好章正文。')
    expect(merged).not.toContain('草稿文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-4: 正文为空的单章跳过（警告），其余照常导出', () => {
  const root = makeLongBook('空章降级')
  writeLongChapter(root, 1, '有肉', '有正文的章。')
  writeFileSync(join(root, '写作', '正文', '2-空章.md'), '---\n章号: 2\n标题: 空章\n---\n', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    expect(r.chapterCount).toBe(1)
    expect(r.warnings![0]).toContain('2-空章.md')
    expect(r.warnings![0]).toContain('正文为空')
    const merged = readFileSync(join(root, '工作区', '导出', '全本-空章降级.md'), 'utf-8')
    expect(merged).toContain('有正文的章。')
    expect(merged).not.toContain('空章')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('X-P2-4: 全部章解析失败 → 整体失败并列出问题文件', () => {
  const root = makeLongBook('全坏')
  writeFileSync(join(root, '写作', '正文', '0001-坏.md'), '没有 front matter。', 'utf-8')
  try {
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('章解析失败')
    expect(r.error).toContain('0001-坏.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 第五轮：导出目录清旧（防作者从旧导出残稿上错版本）──────

test('第五轮: 书改名后 merged 导出 → 旧「全本-旧书名.md」被清掉不残留', () => {
  const root = makeLongBook('旧书名')
  writeLongChapter(root, 1, '第一章', '内容一。')
  try {
    const first = exportBook({ bookRoot: root, format: 'merged' })
    expect(first.ok).toBe(true)
    expect(existsSync(join(root, '工作区', '导出', '全本-旧书名.md'))).toBe(true)
    // 改书名再导出：同前缀旧文件视为过期产物
    writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'book:', '  title: 新书名', '  genre: 玄幻'].join('\n'), 'utf-8')
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    const entries = readdirSync(join(root, '工作区', '导出'))
    expect(entries).toContain('全本-新书名.md')
    expect(entries).not.toContain('全本-旧书名.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('第五轮: 分章目录整目录重建——改章标题/删章后旧文件不残留', () => {
  const root = makeLongBook('分章清旧')
  writeLongChapter(root, 1, '旧标题', '内容一。')
  writeLongChapter(root, 2, '第二章', '内容二。')
  try {
    const first = exportBook({ bookRoot: root, format: 'split' })
    expect(first.ok).toBe(true)
    const dir = join(root, '工作区', '导出', '分章')
    expect(readdirSync(dir).sort()).toEqual(['001-旧标题.md', '002-第二章.md'])
    // 第一章改标题（新文件名）+ 删第二章 → 旧导出必须整体重建不残留
    rmSync(join(root, '写作', '正文', '1-旧标题.md'))
    writeLongChapter(root, 1, '新标题', '内容一改。')
    rmSync(join(root, '写作', '正文', '2-第二章.md'))
    const r = exportBook({ bookRoot: root, format: 'split' })
    expect(r.ok).toBe(true)
    expect(readdirSync(dir).sort()).toEqual(['001-新标题.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── E-9f（第五十三轮）：#% 截断收紧——正文合法字面 #% 不再误删 ──────

test('exportBook: 行中带空白的字面 #% 保留；行首/紧贴正文的批注仍滤净', () => {
  const root = makeLongBook('字面保留')
  writeLongChapter(root, 1, '字面测试', '达标线 #%=95% 才放行\n正文甲#%贴附批注\n#% 整行批注\n正常正文')
  try {
    exportBook({ bookRoot: root, format: 'merged' })
    const merged = readFileSync(join(root, '工作区', '导出', '全本-字面保留.md'), 'utf-8')
    // 反例：# 前是空白的行中字面序列保留（非批注形态）
    expect(merged).toContain('#%=95%')
    expect(merged).toContain('达标线')
    // 正例：贴附批注尾巴截掉、整行批注剔除
    expect(merged).toContain('正文甲')
    expect(merged).not.toContain('贴附批注')
    expect(merged).not.toContain('整行批注')
    expect(merged).toContain('正常正文')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── N-6（第五十四轮）：fenced 代码块内 #% 不剥 ─────────────────

test('exportBook: fenced 代码块（``` 围栏）内的 #% 原样保留；块外批注仍滤净', () => {
  const root = makeLongBook('围栏保留')
  const body = [
    '正文开头',
    '```python',
    '#% 代码内标记不剥',
    'x = "达标 #%=95%"',
    '```',
    '#% 整行批注',
    '正文乙#%贴附批注',
    '收尾正文',
  ].join('\n')
  writeLongChapter(root, 1, '围栏测试', body)
  try {
    exportBook({ bookRoot: root, format: 'merged' })
    const merged = readFileSync(join(root, '工作区', '导出', '全本-围栏保留.md'), 'utf-8')
    // 围栏内 #% 是代码字面量：原样保留
    expect(merged).toContain('代码内标记不剥')
    expect(merged).toContain('#%=95%')
    // 围栏外批注形态仍剥
    expect(merged).not.toContain('整行批注')
    expect(merged).not.toContain('贴附批注')
    expect(merged).toContain('正文开头')
    expect(merged).toContain('收尾正文')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R65-27（第六十五轮）：旧产物归档不删（导出/.旧版/）──────────

test('R65-27: 改书名再导出 → 旧「全本-」产物归档进 导出/.旧版/ 且内容不变（不再 rmSync 销毁）', () => {
  const root = makeLongBook('旧书名')
  writeLongChapter(root, 1, '北境的雪', '雪落在了城墙上。')
  try {
    expect(exportBook({ bookRoot: root, format: 'merged' }).ok).toBe(true)
    // 作者手改导出稿（改书名后再导出的典型形态——此前被 rmSync 静默销毁）
    const oldPath = join(root, '工作区', '导出', '全本-旧书名.md')
    writeFileSync(oldPath, '作者手改过的导出稿内容', 'utf-8')
    writeFileSync(
      join(root, 'book.yaml'),
      ['spec_version: 1', 'book:', '  title: 新书名', '  genre: 玄幻'].join('\n'),
      'utf-8',
    )
    const r = exportBook({ bookRoot: root, format: 'merged' })
    expect(r.ok).toBe(true)
    // 旧产物归档进 .旧版/ 且内容原样（未被销毁）
    expect(existsSync(oldPath)).toBe(false)
    expect(readFileSync(join(root, '工作区', '导出', '.旧版', '全本-旧书名.md'), 'utf-8')).toBe('作者手改过的导出稿内容')
    // 新产物在位
    expect(existsSync(join(root, '工作区', '导出', '全本-新书名.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R65-27: 归档同名冲突 → 追加序号后缀保双份', () => {
  const root = makeLongBook('书名A')
  writeLongChapter(root, 1, '第一章', '正文一。')
  const writeCfg = (title: string): void => {
    writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'book:', `  title: ${title}`, '  genre: 玄幻'].join('\n'), 'utf-8')
  }
  try {
    writeCfg('书名A')
    exportBook({ bookRoot: root, format: 'merged' })
    writeFileSync(join(root, '工作区', '导出', '全本-书名A.md'), '第一版手改', 'utf-8')
    writeCfg('书名B')
    exportBook({ bookRoot: root, format: 'merged' }) // 全本-书名A.md → .旧版/
    // 再造同名旧产物后再次换名导出 → 归档目录撞名
    writeFileSync(join(root, '工作区', '导出', '全本-书名A.md'), '第二版手改', 'utf-8')
    writeCfg('书名C')
    exportBook({ bookRoot: root, format: 'merged' })
    const archiveDir = join(root, '工作区', '导出', '.旧版')
    expect(readFileSync(join(archiveDir, '全本-书名A.md'), 'utf-8')).toBe('第一版手改')
    expect(readFileSync(join(archiveDir, '全本-书名A-2.md'), 'utf-8')).toBe('第二版手改') // 序号后缀保双份
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R65-27: 短篇投稿视图旧产物同口径归档（改书名后旧「投稿视图-」进 .旧版/ 不销毁）', () => {
  const root = mkdtempSync(join(tmpdir(), 'export-subm-archive-'))
  const writeCfg = (title: string): void => {
    writeFileSync(join(root, 'book.yaml'), ['spec_version: 1', 'kind: short', '', 'book:', `  title: ${title}`, '  genre: 悬疑'].join('\n'), 'utf-8')
  }
  writeCfg('旧名短篇')
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '1-雪夜.md'), '---\n章号: 1\n标题: 雪夜\n---\n雪夜的正文。', 'utf-8')
  try {
    exportBook({ bookRoot: root, format: 'merged' }) // 产出 投稿视图-旧名短篇.md
    writeFileSync(join(root, '工作区', '导出', '投稿视图-旧名短篇.md'), '作者改过的投稿稿', 'utf-8')
    writeCfg('新名短篇')
    exportBook({ bookRoot: root, format: 'merged' })
    expect(existsSync(join(root, '工作区', '导出', '投稿视图-旧名短篇.md'))).toBe(false)
    expect(readFileSync(join(root, '工作区', '导出', '.旧版', '投稿视图-旧名短篇.md'), 'utf-8')).toBe('作者改过的投稿稿')
    expect(existsSync(join(root, '工作区', '导出', '投稿视图-新名短篇.md'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
