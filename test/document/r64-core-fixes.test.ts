/**
 * 十二轮批 B 核心服务边界用例（R64-12～R64-24 摘选可单测面）。
 *
 * 覆盖：version reason 消毒往返 / purge 连删版本目录 / addEntry O_EXCL 序号重试 /
 * confirmCandidate 内容去重幂等 / rename basename 守卫 / leads 多行证据与数组 _raw /
 * unquote '' 还原 / 字数目标 NaN 守卫 / 章号 isSafeInteger / restoreTrash link 探测 /
 * atomicWriteStream mode / yaml 残行 warn / bookSearch 码位安全切片。
 * R64-25（global-defaults 缓存）在同目录 r64-defaults-cache.test.ts 单独成文（需 mock node:fs）。
 */
import { test, describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeVersion, readVersionMeta, VERSIONS_DIR_NAME } from '../../src/document/version.js'
import { purgeTrash, restoreTrash } from '../../src/document/trash.js'
import { addEntry, readEntries, ENTRIES_DIR } from '../../src/format/style-entry.js'
import { addCandidate, confirmCandidate, type StyleCandidate } from '../../src/format/style-candidate.js'
import { DocumentService } from '../../src/document/service.js'
import { parseHistory, readLead, writeLead } from '../../src/format/leads.js'
import { parseFlat } from '../../src/format/frontmatter.js'
import { readChapter } from '../../src/format/chapters.js'
import { parseChapterFileName } from '../../src/format/words.js'
import { atomicWriteStream } from '../../src/fs/atomic.js'
import { parseBookConfig } from '../../src/format/yaml.js'
import { searchBook } from '../../src/process/book-search.js'
import { log } from '../../src/log/index.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-r64-core-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

// ── R64-12：writeVersion reason 消毒 ─────────────

test('R64-12：reason 含换行/` # ` → 落盘单行且 readVersionMeta 往返不丢', () => {
  // 仿 finalize.ts:97 的真实形态：reason 嵌章节标题（标题可含换行/# /引号——AI 产出面）
  const dirty = '定稿 ch:0001 标题带换行\n伪装行: 假字段 # 尾注释'
  const id = writeVersion(join(root, '工作区', VERSIONS_DIR_NAME), 'doc_a', '内容', {
    origin: 'finalize',
    reason: dirty,
    pinned: true,
  })
  expect(id).not.toBeNull()
  const r = readVersionMeta(join(root, '工作区', VERSIONS_DIR_NAME), 'doc_a', id!)
  expect(r).not.toBeNull()
  const reason = r!.meta.reason ?? '' // readVersionMeta 返回 { meta } 包装
  expect(reason).not.toMatch(/[\r\n]/) // 单行化
  expect(reason).toContain('伪装行: 假字段') // ` # ` 不截断（引号化承载）
})

// ── R64-13：purge 连删版本目录 ───────────────────

test('R64-13：purgeTrash 连删 工作区/.版本/<docId>/（pinned 快照不留残）', () => {
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
  writeFileSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'), '旧内容', 'utf-8')
  writeFileSync(
    join(root, '工作区', '.trash', '.trash-manifest.jsonl'),
    JSON.stringify({ id: 'doc_a', originalPath: '写作/正文/0001-旧稿.md', trashedPath: '工作区/.trash/doc_a-旧稿.md', trashedAt: '', role: 'chapter' }) + '\n',
    'utf-8',
  )
  const verDir = join(root, '工作区', VERSIONS_DIR_NAME, 'doc_a')
  mkdirSync(verDir, { recursive: true })
  writeFileSync(join(verDir, 'pin.md'), '---\n版本ID: pin\n---\n定稿底稿', 'utf-8')

  const r = purgeTrash(root, 'doc_a')
  expect(r.ok).toBe(true)
  expect(existsSync(join(root, '工作区', '.trash', 'doc_a-旧稿.md'))).toBe(false)
  expect(existsSync(verDir)).toBe(false) // 版本目录连删
})

// ── R64-14：addEntry O_EXCL + 序号重试 ───────────

test('R64-14：目标序号已被并发占位 → O_EXCL 重试落下一序号，不覆盖既有文件', () => {
  const dir = join(root, ENTRIES_DIR, '样章')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '通用-001.md'), '既有条目（模拟并发先落）', 'utf-8')

  const rel = addEntry(root, { 类型: '样章', 场景: '通用', 来源: '改稿行为', 正文: '新条目' })
  expect(rel).toBe(`${ENTRIES_DIR}/样章/通用-002.md`) // 撞 001 → 重试 002
  expect(readFileSync(join(dir, '通用-001.md'), 'utf-8')).toBe('既有条目（模拟并发先落）') // 未被覆盖
  expect(readFileSync(join(dir, '通用-002.md'), 'utf-8')).toContain('新条目')
})

// ── R64-15：confirmCandidate 内容去重 ────────────

test('R64-15：同内容候选重复确认 → 复用既有条目，不产生重复', () => {
  const c: StyleCandidate = {
    类型: '样章', 场景: '通用', 来源: '改稿行为', 正文: '同一段正文。', 状态: '待确认', 创建: '2026-08-26', 章号: 7,
  }
  const first = confirmCandidate(root, addCandidate(root, c))
  expect(first).toBe(`${ENTRIES_DIR}/样章/通用-001.md`)
  // 崩溃重试场景：候选被重建（同内容）再确认
  const second = confirmCandidate(root, addCandidate(root, c))
  expect(second).toBe(first) // 复用既有条目路径
  const { entries } = readEntries(join(root, ENTRIES_DIR), '样章')
  expect(entries.filter((e) => e.正文 === '同一段正文。')).toHaveLength(1)
})

// ── R64-16：rename basename 守卫 ─────────────────

describe('R64-16：rename newName 含路径分隔符 → PATH_ESCAPE', () => {
  let bookRoot: string
  let svc: DocumentService
  beforeEach(() => {
    bookRoot = mkdtempSync(join(tmpdir(), 'clw-r64-svc-'))
    mkdirSync(join(bookRoot, '工作区'), { recursive: true })
    svc = new DocumentService({ bookRoot: bookRoot })
  })
  afterEach(() => rmSync(bookRoot, { recursive: true, force: true }))

  test('子目录形态 / 越层形态均拒绝', async () => {
    const created = await svc.createDocument({ relPath: '写作/正文/0001-开篇.md', content: '初稿' })
    if (!created.ok) throw new Error('prereq create')
    for (const bad of ['卷一/0002-移目录.md', '../0002-越层.md']) {
      const r = await svc.renameDocument({ docId: created.docId, newName: bad })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('PATH_ESCAPE')
    }
    expect(existsSync(join(bookRoot, '写作', '正文', '0001-开篇.md'))).toBe(true)
  })
})

// ── R64-17：leads 多行证据 + 数组 _raw ───────────

test('R64-17：多行证据续行折空格并入上一条（不丢）', () => {
  const body = ['## 履历', '', '- 第1章 埋下：证据第一行', '  证据第二行', '- 第2章 回收：一次性证据'].join('\n')
  const entries = parseHistory(body)
  expect(entries).toHaveLength(2)
  expect(entries[0]!.证据).toBe('证据第一行 证据第二行')
  expect(entries[1]!.证据).toBe('一次性证据')
})

test('R64-17：数组型未知字段 _raw 按 string[] 承载，writeLead 往返不错位', () => {
  const fp = join(root, '布线', '悬念', '悬念-001.md')
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(fp, [
    '---',
    '编号: 悬念-001',
    '标题: 双线钥匙',
    '类型: 悬念',
    '状态: 进行中',
    '开启章: 1',
    '友人: ["甲,乙", 丙]',
    '---',
    '',
    '## 履历',
    '',
    '- 第1章 埋下：抽屉里有把旧钥匙',
  ].join('\n'), 'utf-8')
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const raw = r.lead._raw?.['友人']
  expect(Array.isArray(raw)).toBe(true)
  if (Array.isArray(raw)) expect(raw[0]).toBe('甲,乙') // 修复前 String(v) → '甲,乙,丙'
  writeLead(fp, r.lead)
  const again = readLead(fp)
  expect(again.ok).toBe(true)
  if (!again.ok) return
  const raw2 = again.lead._raw?.['友人']
  expect(Array.isArray(raw2) && raw2.length === 2 && raw2[0] === '甲,乙').toBe(true)
})

// ── R64-18：unquote '' 还原 ──────────────────────

test('R64-18：单引号值 `\'it\'\'s\'` → it\'s（往返不再漂移）', () => {
  const map = parseFlat("标题: 'it''s'")
  expect(map.get('标题')).toBe("it's")
})

// ── R64-19：字数目标 NaN 守卫 ────────────────────

test('R64-19：`字数目标: 三千` → 字段按未写处理（不落 NaN）', () => {
  const fp = join(root, '0001-章.md')
  writeFileSync(fp, ['---', '章号: 1', '标题: 试章', '钩子类型: 悬念钩', '字数目标: 三千', '---', '', '正文'].join('\n'), 'utf-8')
  const r = readChapter(fp)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.chapter.字数目标).toBeUndefined()
})

// ── R64-20：章号 isSafeInteger ───────────────────

test('R64-20：超精度数字章号（17 位）→ null（不产生错位章号）', () => {
  expect(parseChapterFileName('99999999999999999-标题.md')).toBeNull()
  expect(parseChapterFileName('152-北境的雪.md')).toEqual({ 章号: 152, 标题: '北境的雪' })
})

// ── R64-21：restoreTrash link 探测 ───────────────

test('R64-21：文件恢复走 linkSync 探测——原位占用 → OCCUPIED；空闲 → 内容原样回位', () => {
  mkdirSync(join(root, '工作区', '.trash'), { recursive: true })
  writeFileSync(join(root, '工作区', '.trash', 'doc_b-手记.md'), '回收内容', 'utf-8')
  const manifestLine = (orig: string) =>
    JSON.stringify({ id: 'doc_b', originalPath: orig, trashedPath: '工作区/.trash/doc_b-手记.md', trashedAt: '', role: 'chapter' }) + '\n'
  const writeManifestLine = (orig: string) =>
    writeFileSync(join(root, '工作区', '.trash', '.trash-manifest.jsonl'), manifestLine(orig), 'utf-8')

  // 占用：原位已有文件 → OCCUPIED（linkSync EEXIST，无覆盖窗口）
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  writeFileSync(join(root, '写作', '正文', '0002-手记.md'), '占位内容', 'utf-8')
  writeManifestLine('写作/正文/0002-手记.md')
  const occ = restoreTrash(root, 'doc_b')
  expect(occ.ok).toBe(false)
  if (!occ.ok) expect(occ.code).toBe('OCCUPIED')
  expect(readFileSync(join(root, '写作', '正文', '0002-手记.md'), 'utf-8')).toBe('占位内容') // 占位文件未被覆盖
  expect(existsSync(join(root, '工作区', '.trash', 'doc_b-手记.md'))).toBe(true) // .trash 侧未动

  // 空闲：清掉占位 → 恢复成功，内容一致，.trash 侧清除
  rmSync(join(root, '写作', '正文', '0002-手记.md'))
  const ok = restoreTrash(root, 'doc_b')
  expect(ok.ok).toBe(true)
  expect(readFileSync(join(root, '写作', '正文', '0002-手记.md'), 'utf-8')).toBe('回收内容')
  expect(existsSync(join(root, '工作区', '.trash', 'doc_b-手记.md'))).toBe(false)
})

// ── R64-22：atomicWriteStream mode 透传 ──────────

test('R64-22：opts.mode 落到产物（0o600）', () => {
  const fp = join(root, 'out', 'merged.md')
  atomicWriteStream(fp, (append) => { append('第一段\n'); append('第二段\n') }, { mode: 0o600 })
  expect(readFileSync(fp, 'utf-8')).toBe('第一段\n第二段\n')
  expect(statSync(fp).mode & 0o777).toBe(0o600)
  // 不传 mode：默认不受影响（umask 口径，仅断言可写可读）
  const fp2 = join(root, 'out', 'plain.md')
  atomicWriteStream(fp2, (append) => append('x'))
  expect(readFileSync(fp2, 'utf-8')).toBe('x')
})

// ── R64-24：yaml 残行 warn + bookSearch 码位切片 ──

test('R64-24：book.yaml 无冒号残行 → warn 留痕（不中断解析）', () => {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
  const text = ['book:', '  title: 试书', '  手写残句没有冒号', 'growth:', '  realm_span_max: 3'].join('\n')
  const r = parseBookConfig(text)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.book.title).toBe('试书')
  expect(warn).toHaveBeenCalledWith('yaml', expect.stringContaining('无冒号行'))
})

test('R64-24：bookSearch 命中行截断不劈代理对（200 码位含完整 emoji）', () => {
  const dir = join(root, '写作', '正文')
  mkdirSync(dir, { recursive: true })
  const line = 'x'.repeat(199) + '𝄞' + '目标词尾部'
  writeFileSync(join(dir, '0001-章.md'), line, 'utf-8')
  const out = searchBook(root, '目标词')
  expect(out.results).toHaveLength(1)
  const text = out.results[0]!.matches[0]!.text
  expect([...text]).toHaveLength(200) // 199 x + 完整 𝄞（修复前 slice(0,200) 劈出落单高代理）
  expect(text.endsWith('𝄞')).toBe(true)
})
