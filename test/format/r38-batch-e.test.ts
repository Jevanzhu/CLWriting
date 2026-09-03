/**
 * R38-9/R38-10/R38-11（三十八轮批 E）回归。
 *
 * R38-9：`.MD` 大写扩展名家族修复收口——R34D-11/R2W-8 只修了 readEntries 一处，
 * 本轮把 style/style-entry/iron-rules/style-migrate/leak-derive/check-run/check-runner
 * 共 7 处扫描点统一到 filename.isMdFileName 单源，并修 parseSampleFileName 的扩展名
 * 剥离大小写。行为面锁定「指纹侧缓存陈旧」这一最重形态（禁词条目变更不失效缓存）；
 * 其余扫描点以静态站点扫描兜底防回退。
 * R38-10：空字符串证据（「- 第2章 埋下：」）落 unverifiable 黄项（fail-noisy）。
 * R38-11：writeLead 主导行尾保真——LF 账本字节不变的回归锚（CRLF 保持见
 * r36-leads-crlf 契约演进断言）。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readIronRules } from '../../src/format/iron-rules.js'
import { parseSampleFileName } from '../../src/format/style.js'
import { readLead, writeLead } from '../../src/format/leads.js'
import { checkLeadsBookItems } from '../../src/check/leads.js'
import { collectTreeIssues } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry, type ManifestEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

// ── R38-9：.MD 家族 ──────────────────────────────

describe('R38-9: .MD 扩展名家族（指纹侧缓存陈旧闭合）', () => {
  it('禁词条目 .MD 变更内容 → readIronRules 缓存失效重读（修复前指纹漏认 .MD 恒命中旧值）', () => {
    const root = mkdtempSync(join(tmpdir(), 'r38-mdfp-'))
    try {
      const dir = join(root, '文风', '条目', '禁词')
      mkdirSync(dir, { recursive: true })
      const fp = join(dir, '战斗-001.MD') // 资源管理器改名形态（readEntries R2W-8 已认）
      writeFileSync(fp, '---\n类型: 禁词\n场景: 战斗\n---\n\n词甲、词乙\n', 'utf-8')

      const r1 = readIronRules(root)
      expect(r1.bannedWords).toContain('词甲')

      // 改内容 + 显式推进 mtime（指纹 = 文件名哈希 + mtimeMs/size 分量，必须真变）
      writeFileSync(fp, '---\n类型: 禁词\n场景: 战斗\n---\n\n词甲、词丙\n', 'utf-8')
      utimesSync(fp, new Date(Date.now() + 5000), new Date(Date.now() + 5000))

      const r2 = readIronRules(root)
      // 修复前：ironRulesFp 大小写敏感过滤看不到 .MD → 指纹不变 → 命中旧缓存，词丙永不生效
      expect(r2.bannedWords).toContain('词丙')
      expect(r2.bannedWords).not.toContain('词乙')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('parseSampleFileName 大写扩展名剥离（<场景>-NNN.MD 序号可解析）', () => {
    expect(parseSampleFileName('战斗-001.MD')).toEqual({ 场景: '战斗', 序号: 1 })
    expect(parseSampleFileName('战斗-001.md')).toEqual({ 场景: '战斗', 序号: 1 })
  })

  it('静态站点扫描：7 处 .md 扫描点无大小写敏感 endsWith 残留', () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
    const sites = [
      'format/style.ts',
      'format/style-entry.ts',
      'format/iron-rules.ts',
      'format/style-migrate.ts',
      'check/leak-derive.ts',
      'check/run.ts',
      'check/runner.ts',
    ]
    for (const s of sites) {
      const src = readFileSync(join(srcRoot, s), 'utf-8')
      // endsWith('.md')（大小写敏感形态）不得回归；注释中的提法不限
      const code = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join('\n')
      expect(code.includes("endsWith('.md')"), `${s} 存在大小写敏感 .md 过滤`).toBe(false)
    }
  })
})

// ── R38-10：空字符串证据 fail-noisy ───────────────

function makeEmptyStringEvidenceBook(): string {
  const root = mkdtempSync(join(tmpdir(), 'r38-empty-ev-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  // 空字符串证据形态：冒号后无内容（R34D-2 宽松正则产出 证据:''，此前被 truthy 门径整条跳过）
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-空串证据.md'),
    '---\n编号: 悬念-001\n标题: 空串证据\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第2章 埋下：\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (const no of [1, 2, 3]) {
    const pad = String(no).padStart(3, '0')
    const rel = `写作/正文/${pad}-第${no}章.md`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${no}章的叙述文本，山门外落了整夜的雨。\n`,
      'utf-8',
    )
    const entry: ManifestEntry = { id: generateDocId(), nodeType: 'document', path: rel, parentId: null }
    if (no === 3) {
      entry.finalizedRevision =
        'sha256:' + createHash('sha256').update(readFileSync(join(root, rel))).digest('hex')
    }
    upsertEntry(m, entry)
  }
  writeManifest(manifestPath, m)
  return root
}

describe('R38-10: 空字符串证据 → unverifiable 黄项（不再整条跳过）', () => {
  it('「- 第2章 埋下：」（证据空串）产 lead-evidence-unverifiable 黄项', () => {
    const root = makeEmptyStringEvidenceBook()
    try {
      collectTreeIssues(root, () => undefined)
      const db = new DatabaseSync(join(root, '.cache', 'index.db'), { readOnly: true })
      try {
        const items = checkLeadsBookItems(db, root, 3, ['悬念'])
        const unverifiable = items.filter((i) => i.checkId === 'lead-evidence-unverifiable')
        expect(unverifiable).toHaveLength(1)
        expect(unverifiable[0]!.level).toBe('yellow')
        expect(unverifiable[0]!.message).toContain('剥引号后为空')
        expect(items.some((i) => i.checkId === 'lead-evidence-miss')).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── R38-11：LF 账本字节不变锚 ────────────────────

describe('R38-11: writeLead 主导行尾（LF 锚）', () => {
  it('LF 账本读改写回：无 \r 引入（存量 LF 文件字节口径不变）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r38-lf-lead-'))
    try {
      const fp = join(dir, '大纲', '悬念.md')
      mkdirSync(dirname(fp), { recursive: true })
      const original = [
        '---',
        '编号: 悬念-001',
        '标题: 祠堂焦痕',
        '类型: 悬念',
        '状态: 进行中',
        '开启章: 1',
        '---',
        '',
        '## 履历',
        '',
        '- 第012章 埋下：林家祠堂的焦痕。',
        '',
      ].join('\n')
      writeFileSync(fp, original, 'utf-8')
      const r = readLead(fp)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      r.lead.履历.push({ 章号: 20, 动词: '递进', 证据: '狗没有叫。' })
      writeLead(fp, r.lead)
      const out = readFileSync(fp, 'utf-8')
      expect(out.includes('\r')).toBe(false)
      expect(out).toContain('- 第012章 埋下：林家祠堂的焦痕。')
      expect(out).toContain('- 第020章 递进：狗没有叫。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
