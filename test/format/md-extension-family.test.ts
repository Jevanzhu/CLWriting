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
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempTracked } from '../helpers/temp-dir.js'

/**
 * 粗粒度卷替身：本机卷（NTFS/APFS/ext4）mtime 为 ns 级，真粗粒度卷（FAT 2s /
 * exFAT 10ms / SMB 1s）物理上复现不了，故对 statSync 的 bigint 面打桩——登记过的
 * 路径按帧返回（mtimeNs 整毫秒对齐 = 低精度卷形态），其余路径透传真实 stat。
 * 帧值单位是 ns：整毫秒对齐形如 `1_700_000_002_000_000_000n`，精修卷形加亚毫秒余数。
 */
const { coarseStatFrames } = vi.hoisted(() => ({
  coarseStatFrames: new Map<string, { size: bigint; mtimeNs: bigint }>(),
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: (p: string, opts?: { bigint?: boolean }) => {
      if (opts?.bigint && typeof p === 'string') {
        const frame = coarseStatFrames.get(p)
        if (frame) return frame as never
      }
      return actual.statSync(p, opts as never)
    },
  }
})

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
    const root = mkdtempTracked(join(tmpdir(), 'r38-mdfp-'))
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

  // ── 低精度 mtime 卷（FAT/exFAT/SMB）：铁律词表指纹降级 ──────────────
  // 粗粒度卷的 mtime 粒度粗于毫秒 → 同尺寸改写可落在同一刻度内，ironRulesFp 的
  // (mtimeNs,size) 分量全同。降级判据 = isCoarseMtimeNs（整毫秒对齐），该卷不命中
  // 也不落缓存（见 ironRulesFp 注）。本机卷为 ns 级精度，粗粒度形态由 stat 打桩构造。
  describe('低精度 mtime 卷：铁律/禁词词表缓存降级', () => {
    it('同尺寸改写落在同一粗粒度刻度 → 铁律词表重读生效（不返回陈旧禁词）', () => {
      const root = mkdtempTracked(join(tmpdir(), 'iron-coarse-'))
      try {
        const rulesPath = join(root, '文风', '文风铁律.md')
        mkdirSync(join(root, '文风'), { recursive: true })
        writeFileSync(rulesPath, '# 文风铁律\n## 硬禁词\n- 词甲\n', 'utf-8')
        const size = statSync(rulesPath, { bigint: true }).size
        // 整毫秒对齐 = 低精度卷形态；两次读喂同一帧（粗粒度窗口内 stat 逐位相同）
        coarseStatFrames.set(rulesPath, { size, mtimeNs: 1_700_000_002_000_000_000n })

        expect(readIronRules(root).bannedWords).toContain('词甲')

        // 等长改写（词甲 → 词乙）：粗粒度卷上 size 与 mtimeNs 都不变
        writeFileSync(rulesPath, '# 文风铁律\n## 硬禁词\n- 词乙\n', 'utf-8')
        // 修复前：指纹全同 → 命中旧缓存，词乙永不生效（禁词红闸静默失明）；修复后重读
        const after = readIronRules(root).bannedWords
        expect(after).toContain('词乙')
        expect(after).not.toContain('词甲')
      } finally {
        coarseStatFrames.clear()
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('精修卷（非整毫秒对齐）不降级：同指纹二次读走缓存（拷贝出仓语义不变）', () => {
      const root = mkdtempTracked(join(tmpdir(), 'iron-fine-'))
      try {
        const rulesPath = join(root, '文风', '文风铁律.md')
        mkdirSync(join(root, '文风'), { recursive: true })
        writeFileSync(rulesPath, '# 文风铁律\n## 硬禁词\n- 词甲\n', 'utf-8')
        const size = statSync(rulesPath, { bigint: true }).size
        // 亚毫秒余数 = ns 级精度卷形态；帧不变即判「盘上未变」
        coarseStatFrames.set(rulesPath, { size, mtimeNs: 1_700_000_002_000_000_123n })
        const first = readIronRules(root)
        expect(first.bannedWords).toContain('词甲')
        // 缓存命中（帧不变）→ 返回值仍是拷贝体：mutate 不污染二次读取
        first.bannedWords!.push('污染值')
        const second = readIronRules(root)
        expect(second.bannedWords).toContain('词甲')
        expect(second.bannedWords).not.toContain('污染值')
      } finally {
        coarseStatFrames.clear()
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  it('format/ 与 check/ 目录级机制扫描：无大小写敏感 .md 过滤残留（新增文件自动在射程内）', () => {
    const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
    const dirs = [join(srcRoot, 'format'), join(srcRoot, 'check')]
    /** 逐行剥注释后的代码文本（注释里的提法不算过滤点）。 */
    const strip = (src: string): string =>
      src
        .split(String.fromCharCode(10))
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
        .join(String.fromCharCode(10))
    const sensitive: string[] = []
    let scanned = 0
    for (const dir of dirs) {
      const files = (readdirSync(dir, { recursive: true, encoding: 'utf-8' }) as string[]).filter((f) =>
        f.endsWith('.ts'),
      )
      scanned += files.length
      for (const f of files) {
        const code = strip(readFileSync(join(dir, f), 'utf-8'))
        for (const m of code.matchAll(/\.endsWith\('\.md'\)/g)) {
          // 允许的唯一形态：先 toLowerCase() 再 endsWith（大小写不敏感判定的就地写法）；
          // 其余（裸 endsWith('.md') / 未折叠变量）即大小写敏感残留
          const before = code.slice(Math.max(0, m.index - 20), m.index)
          if (!before.includes('toLowerCase()'))
            sensitive.push(`${f}:${code.slice(0, m.index).split(String.fromCharCode(10)).length}`)
        }
      }
    }
    expect(scanned).toBeGreaterThan(10) // 扫描面非空（防目录改名后断言空转）
    expect(
      sensitive,
      `.md 过滤应走 filename.isMdFileName 单源或 toLowerCase 就地折叠；残留：${sensitive.join(', ')}`,
    ).toEqual([])
  })

  it('条目库探针与实读过滤同源 isMdFileName（探针侧回退手写扩展名判定即红）', () => {
    // 上面那条目录扫描只认裸 endsWith('.md') 形态；`f.slice(-3).toLowerCase() === '.md'`
    // 这类就地手写判定不在其射程内——探针侧一旦回退手写，探针与实读的分叉（漏看的文件
    // 改写不失效缓存）就无人拦。本条按代码形态钉本档三处过滤点（探针 / 实读 / 序号扫描）同源。
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'format', 'style-entry.ts')
    const code = readFileSync(p, 'utf-8')
    expect(code.match(/isMdFileName\(f\)/g) ?? []).toHaveLength(3)
    expect(code).not.toContain('f.slice(-3)')
  })
})

// ── R38-10：空字符串证据 fail-noisy ───────────────

function makeEmptyStringEvidenceBook(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r38-empty-ev-'))
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
        'sha256:' +
        createHash('sha256')
          .update(readFileSync(join(root, rel)))
          .digest('hex')
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
    const dir = mkdtempTracked(join(tmpdir(), 'r38-lf-lead-'))
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
