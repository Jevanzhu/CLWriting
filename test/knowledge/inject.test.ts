/**
 * 知识层装配单点（src/knowledge/inject.ts）面表。
 *
 * 三面注入此前各持一份平行装配（解析→截断→计量→拼段→登记→超帽处置），语义已分叉
 * （写稿 continue / 对话 break / 三审无合计帽）。本件把装配语义收成一表锚定：
 * 单篇截断保头、合计超帽即止、两级皆缺记 missing、开关关停不读盘记 switch-off、
 * 空候选空段、多篇序、标题提取、段头换行形态由调用方给全。
 *
 * 用 CLWRITING_RESOURCES_DIR 注入临时资源根（真实语料体量够不到帽）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { assembleKnowledge, titleOf, knowledgeReportOf, summarizeDropped } from '../../src/knowledge/inject.js'
import {
  bundledCorpusIntegrityReport,
  checkBundledCorpus,
  ensureBundledCorpusChecked,
} from '../../src/knowledge/corpus.js'
import { clipWithNotice } from '../../src/shared/text.js'

/**
 * 资源根故障注入：`bundledResource` 是 corpus 侧取件的唯一入口，`resourcesRoot()` 在
 * resources/ 缺失时按设计抛错。默认透传真实实现，仅置位时抛——不影响本档其余用例。
 */
const FAIL = vi.hoisted(() => ({ resources: false }))
vi.mock('../../src/fs/resources.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/resources.js')>()
  return {
    ...actual,
    bundledResource: (...segments: string[]) => {
      if (FAIL.resources) throw new Error('未找到捆绑资源目录 resources/')
      return actual.bundledResource(...segments)
    },
  }
})

let dir: string
let prevResourcesDir: string | undefined

beforeEach(() => {
  dir = mkdtempTracked(join(tmpdir(), 'clw-know-inject-'))
  prevResourcesDir = process.env['CLWRITING_RESOURCES_DIR']
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (prevResourcesDir === undefined) delete process.env['CLWRITING_RESOURCES_DIR']
  else process.env['CLWRITING_RESOURCES_DIR'] = prevResourcesDir
})

/** 造受限资源根：knowledge/<rel> 写指定正文（无 front matter，bodyOf 原样） */
function stubCorpus(files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, 'knowledge', ...rel.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, body)
  }
  process.env['CLWRITING_RESOURCES_DIR'] = dir
}

const REL_A = '类目/甲篇.md'
const REL_B = '类目/乙篇.md'

/** 装配调用壳：省去每例重复的段头/理由参数 */
function assemble(
  rels: readonly string[],
  opts: { fileCap?: number; totalCap?: number; enabled?: boolean; bookRoot?: string } = {},
) {
  return assembleKnowledge({
    bookRoot: opts.bookRoot,
    rels,
    heading: '## 段头\n',
    fileCap: opts.fileCap ?? 2000,
    totalCap: opts.totalCap ?? 3000,
    enabled: opts.enabled,
    reasonOf: (rel, i) => `理由${i}:${rel}`,
  })
}

describe('随包语料运行期抽查（存在性 + 前缀抽样，不逐字节 sha256）', () => {
  it('缺失 / 空文件逐条报缺口；齐备且前缀非空 → 零 issue', () => {
    const root = join(dir, 'knowledge')
    mkdirSync(join(root, '类目'), { recursive: true })
    writeFileSync(join(root, '类目', '甲篇.md'), '---\ntitle: 甲\n---\n\n甲篇正文\n')
    const rels = ['类目/甲篇.md', '类目/乙篇.md']
    const missing = checkBundledCorpus(rels, { root })
    expect(missing.checked).toBe(2)
    expect(missing.issues.map((i) => i.rel)).toEqual(['类目/乙篇.md'])
    writeFileSync(join(root, '类目', '乙篇.md'), '')
    const empty = checkBundledCorpus(rels, { root })
    expect(empty.issues).toHaveLength(1)
    expect(empty.issues[0]!.rel).toBe('类目/乙篇.md')
    expect(empty.issues[0]!.detail).toContain('空')
    writeFileSync(join(root, '类目', '乙篇.md'), '乙篇正文\n')
    expect(checkBundledCorpus(rels, { root }).issues).toEqual([])
  })

  it('首次注入前自动抽查一次：缺口留痕但注入照常，进程内快照可读；显式入参强制现算', () => {
    stubCorpus({ [REL_A]: '甲正文。' })
    const a = assemble([REL_A])
    expect(a.text).toContain('甲正文。') // 抽查发现缺口也不阻断装配（知识层是增强面）
    const report = bundledCorpusIntegrityReport()
    expect(report).not.toBeNull() // 回退即变红：钩子被摘掉时本进程快照恒为 null
    expect(report!.checked).toBeGreaterThan(0)
    expect(bundledCorpusIntegrityReport()).toBe(report) // 一次性：不再重算
    expect(ensureBundledCorpusChecked({ rels: [REL_A], root: join(dir, 'knowledge') }).issues).toEqual([])
  })

  // 下列四例覆盖「文件在位但内容不可用」的四种现实形态——它们都不是假设性分支：
  // 随包语料在用户机上可被压缩工具清空、被第三方编辑器存成 UTF-16/GBK（解码出 U+FFFD）、
  // 被错误替换成超大文件、或被杀软/网络卷占住读不动。漏一条 = 该形态静默降质不报。
  it('文件在位但前缀只剩空白 → 报「前缀为空」（与 size=0 同因不同形态）', () => {
    const root = join(dir, 'knowledge')
    mkdirSync(join(root, '类目'), { recursive: true })
    writeFileSync(join(root, '类目', '甲篇.md'), '\n\n   \n\t\n')
    const r = checkBundledCorpus(['类目/甲篇.md'], { root })
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.detail).toContain('前缀为空')
  })

  it('文件前缀含 U+FFFD → 报「前缀非合法 UTF-8」（被替换/非 UTF-8 存储）', () => {
    const root = join(dir, 'knowledge')
    mkdirSync(join(root, '类目'), { recursive: true })
    writeFileSync(join(root, '类目', '甲篇.md'), '标题\n正文\n\uFFFD\n')
    const r = checkBundledCorpus(['类目/甲篇.md'], { root })
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.detail).toContain('非合法 UTF-8')
  })

  it('文件超单篇上限 → 报「超过单篇上限」（注入侧会跳过该篇，抽查须先说清）', () => {
    const root = join(dir, 'knowledge')
    mkdirSync(join(root, '类目'), { recursive: true })
    // 上限 256KB（corpus.ts MAX_CORPUS_BYTES）；超 1 字节即命中，不必写巨量正文
    writeFileSync(join(root, '类目', '甲篇.md'), Buffer.alloc(256 * 1024 + 1, 0x41))
    const r = checkBundledCorpus(['类目/甲篇.md'], { root })
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.detail).toContain('超过单篇上限')
  })

  // 位移形态：路径存在但不可读。断言只锚「必报缺口且不抛出」这条不变量——
  // 具体走哪条分支随平台而定（win 上目录 statSync().size 为 0 → 命中「前缀为空」；
  // linux 上目录 size 非 0 → readFileSync 抛 EISDIR → 命中 catch），两路都必须成立。
  it('路径存在但不可读 → 必报缺口且不抛出（抽查不得反噬注入）', () => {
    const root = join(dir, 'knowledge')
    mkdirSync(join(root, '类目', '甲篇.md'), { recursive: true }) // 同名目录冒充文件
    let r!: ReturnType<typeof checkBundledCorpus>
    expect(() => {
      r = checkBundledCorpus(['类目/甲篇.md'], { root })
    }).not.toThrow()
    expect(r.issues).toHaveLength(1)
    expect(r.issues[0]!.rel).toBe('类目/甲篇.md')
    expect(r.issues[0]!.detail).toMatch(/前缀为空|前缀读取失败/)
  })

  it('抽样按固定步长取：篇目多于采样数时只抽查 step 倍数位，缺 1 篇仍先报缺失', () => {
    const root = join(dir, 'knowledge')
    mkdirSync(join(root, '类目'), { recursive: true })
    // 4 篇齐备 + sample=2 → step=2 → 抽查 i=0,2 两篇；sampled 计数即该口径的观察面
    const rels = ['类目/一.md', '类目/二.md', '类目/三.md', '类目/四.md']
    for (const rel of rels) writeFileSync(join(root, ...rel.split('/')), '正文\n')
    const full = checkBundledCorpus(rels, { root, sample: 2 })
    expect(full.checked).toBe(4) // 存在性判据走全量
    expect(full.sampled).toBe(2) // 前缀抽查只走抽样面
    expect(full.issues).toEqual([])
    // 缺失判据不受抽样影响：未抽样位（i=1）的文件被删也要报
    rmSync(join(root, '类目', '二.md'))
    const missing = checkBundledCorpus(rels, { root, sample: 2 })
    expect(missing.issues.map((i) => i.rel)).toEqual(['类目/二.md'])
    expect(missing.checked).toBe(4)
  })
})

describe('assembleKnowledge：单篇与多篇装配', () => {
  it('多篇序：段头 + 逐篇块（### 篇题 + 正文），块间空行，sources/records 按注入序', () => {
    stubCorpus({ [REL_A]: '甲正文。', [REL_B]: '乙正文。' })
    const a = assemble([REL_A, REL_B])
    expect(a.text).toBe('## 段头\n### 甲篇\n甲正文。\n\n### 乙篇\n乙正文。')
    expect(a.sources).toEqual([`知识层(内置)/${REL_A}`, `知识层(内置)/${REL_B}`])
    expect(a.records.map((r) => r.rel)).toEqual([REL_A, REL_B])
    expect(a.dropped).toEqual([])
  })

  it('候选序即优先级序：records.reason 逐篇取 reasonOf 的对应下标', () => {
    stubCorpus({ [REL_A]: '甲。', [REL_B]: '乙。' })
    const a = assemble([REL_A, REL_B])
    expect(a.records.map((r) => r.reason)).toEqual([`理由0:${REL_A}`, `理由1:${REL_B}`])
  })

  it('段头是整块前缀（换行形态由调用方给全，本模块不代统一）', () => {
    stubCorpus({ [REL_A]: '甲。' })
    const withBlank = assembleKnowledge({
      rels: [REL_A],
      heading: '## 段头\n\n',
      fileCap: 2000,
      totalCap: 3000,
      reasonOf: () => 'r',
    })
    expect(withBlank.text).toBe('## 段头\n\n### 甲篇\n甲。')
  })

  it('空候选 → 空段空登记（调用方按「空段不入 prompt 不登记」处置）', () => {
    stubCorpus({ [REL_A]: '甲。' })
    expect(assemble([])).toEqual({ text: '', sources: [], records: [], dropped: [] })
  })

  it('两级皆无候选篇 → 空段（书级/随包都不在位）', () => {
    process.env['CLWRITING_RESOURCES_DIR'] = dir
    const a = assemble([REL_A])
    expect(a.text).toBe('')
    expect(a.sources).toEqual([])
    expect(a.dropped).toEqual([{ rel: REL_A, reason: 'missing' }])
  })

  it('篇文件为空/仅空白 → 同「缺失」处置（空文件不算在位，不静默注入空块）', () => {
    stubCorpus({ [REL_A]: '\n  \n' })
    const a = assemble([REL_A])
    expect(a.text).toBe('')
    expect(a.dropped).toEqual([{ rel: REL_A, reason: 'missing' }])
  })
})

describe('assembleKnowledge：帽与截断', () => {
  it('单篇超帽 → 保头截断 + 标注，仍登记源（注入确有其实，非「截没了却报已注入」）', () => {
    stubCorpus({ [REL_A]: '甲'.repeat(500) })
    const a = assemble([REL_A], { fileCap: 100 })
    expect(a.text).toContain('…（超长截断）')
    expect(a.text).not.toContain('甲'.repeat(101))
    expect(a.sources).toEqual([`知识层(内置)/${REL_A}`])
    expect(a.records[0]).toMatchObject({ rel: REL_A, truncated: true })
    expect(a.records[0]!.codePoints).toBeLessThan(500) // 计量取截断后长度
  })

  it('未超帽 → 无标注、truncated false、codePoints 记全文长度', () => {
    stubCorpus({ [REL_A]: '甲'.repeat(50) })
    const a = assemble([REL_A], { fileCap: 100 })
    expect(a.text).not.toContain('超长截断')
    expect(a.records[0]).toMatchObject({ truncated: false, codePoints: 50 })
  })

  it('合计超帽 → 该篇记 cap-total 即止（低优先级篇不留半段，后续篇不再入选）', () => {
    stubCorpus({ [REL_A]: '甲'.repeat(150), [REL_B]: '乙'.repeat(100) })
    const a = assemble([REL_A, REL_B], { fileCap: 200, totalCap: 200 })
    expect(a.text).toContain('### 甲篇')
    expect(a.text).not.toContain('### 乙篇')
    expect(a.sources).toEqual([`知识层(内置)/${REL_A}`])
    expect(a.dropped).toEqual([{ rel: REL_B, reason: 'cap-total' }])
  })

  it('合计帽即止：超帽篇之后的高优先级缺口不挤掉已入选篇（候选表即优先级序）', () => {
    stubCorpus({ [REL_A]: '甲。', [REL_B]: '乙'.repeat(300), '类目/丙篇.md': '丙。' })
    const a = assemble([REL_A, REL_B, '类目/丙篇.md'], { fileCap: 200, totalCap: 10 })
    // 甲入选、乙超帽即止 → 丙不再尝试（break 语义，非 continue）
    expect(a.records.map((r) => r.rel)).toEqual([REL_A])
    expect(a.dropped).toEqual([{ rel: REL_B, reason: 'cap-total' }])
  })

  it('合计帽 = Infinity（单文件映射面无合计帽）→ 单篇帽即有效总帽', () => {
    stubCorpus({ [REL_A]: '甲'.repeat(300) })
    const a = assemble([REL_A], { fileCap: 100, totalCap: Infinity })
    expect(a.text).toContain('…（超长截断）')
    expect(a.records[0]!.truncated).toBe(true)
  })
})

describe('assembleKnowledge：两级 rank 与登记名', () => {
  it('书级篇优先，登记名走书根相对路径；随包件走内置前缀', () => {
    stubCorpus({ [REL_A]: '随包甲。', [REL_B]: '随包乙。' })
    const bookRoot = join(dir, 'book')
    const abs = join(bookRoot, '知识层', ...REL_A.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '书级甲。')
    const a = assemble([REL_A, REL_B], { bookRoot })
    expect(a.text).toContain('书级甲。')
    expect(a.text).toContain('随包乙。')
    expect(a.records.map((r) => r.layer)).toEqual(['book', 'bundled'])
    expect(a.sources).toEqual(['知识层/' + REL_A, `知识层(内置)/${REL_B}`])
  })

  it('书级篇编码可疑（BOM / 替换符）→ 跳过该篇，不用它顶替随包件', () => {
    stubCorpus({ [REL_A]: '随包甲。' })
    const bookRoot = join(dir, 'book')
    const writeBook = (text: string): void => {
      const abs = join(bookRoot, '知识层', ...REL_A.split('/'))
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, text)
    }
    // BOM：UTF-16/GBK 存盘的典型残留
    writeBook('\uFEFF甲正文。')
    const bom = assemble([REL_A], { bookRoot })
    expect(bom.text).not.toContain('甲正文。')
    expect(bom.text).toContain('随包甲。') // 两级回落照旧：书级不可用即用随包件
    expect(bom.records.map((r) => r.layer)).toEqual(['bundled'])
    // 替换符：真 GBK 字节按 utf-8 解码的结果就是成片 U+FFFD
    writeBook('甲\uFFFD\uFFFD正文。')
    const garbled = assemble([REL_A], { bookRoot })
    expect(garbled.text).not.toContain('正文。')
    expect(garbled.records.map((r) => r.layer)).toEqual(['bundled'])
    expect(garbled.dropped).toEqual([])
  })

  it('书级与随包两级皆编码可疑 → 该篇记 missing（不静默注入乱码）', () => {
    stubCorpus({ [REL_A]: '\uFEFF随包乱码。' })
    const bookRoot = join(dir, 'book')
    const abs = join(bookRoot, '知识层', ...REL_A.split('/'))
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, '甲\uFFFD正文。')
    const r = assemble([REL_A], { bookRoot })
    expect(r.text).toBe('')
    expect(r.dropped).toEqual([{ rel: REL_A, reason: 'missing' }])
  })
})

describe('assembleKnowledge：开关关停', () => {
  it('enabled false → 不读盘、段与登记一并空，逐 rel 记 switch-off（非 missing）', () => {
    stubCorpus({ [REL_A]: '甲。', [REL_B]: '乙。' })
    const a = assemble([REL_A, REL_B], { enabled: false })
    expect(a).toEqual({
      text: '',
      sources: [],
      records: [],
      dropped: [
        { rel: REL_A, reason: 'switch-off' },
        { rel: REL_B, reason: 'switch-off' },
      ],
    })
  })

  it('enabled true / 缺省同效（键未设不降级）', () => {
    stubCorpus({ [REL_A]: '甲。' })
    expect(assemble([REL_A]).text).toContain('甲。')
    expect(assemble([REL_A], { enabled: true }).text).toContain('甲。')
  })

  it('关停优先于候选缺失判定：两级皆无也不影响关停形态（不读盘即不产生 missing）', () => {
    process.env['CLWRITING_RESOURCES_DIR'] = dir
    const a = assemble([REL_A], { enabled: false })
    expect(a.dropped).toEqual([{ rel: REL_A, reason: 'switch-off' }])
  })
})

describe('titleOf：标题提取单点', () => {
  it.each([
    ['长篇/章节钩子速查.md', '章节钩子速查'],
    ['通用/质量清单速查.md', '质量清单速查'],
    ['无目录.md', '无目录'],
    ['多段/深层/篇名.md', '篇名'],
  ])('%s → %s', (rel, expected) => {
    expect(titleOf(rel)).toBe(expected)
  })
})

// ── 报告面：装配结果的逐篇留痕与缺口摘要（接口/log 两出口的共面）──────
describe('知识层报告面：records / dropped / 缺口摘要', () => {
  it('records 逐篇带层、登记名、理由、码点与是否截断；报告面只挑两列', () => {
    stubCorpus({ [REL_A]: '甲', '乙类/乙篇.md': '乙乙乙乙乙' })
    const a = assembleKnowledge({
      rels: [REL_A, '乙类/乙篇.md'],
      heading: '## 头\n',
      fileCap: 3,
      totalCap: 100,
      reasonOf: (_rel, i) => `理由-${i}`,
    })
    expect(a.records).toEqual([
      {
        rel: REL_A,
        layer: 'bundled',
        source: `知识层(内置)/${REL_A}`,
        reason: '理由-0',
        codePoints: 1,
        truncated: false,
      },
      {
        rel: '乙类/乙篇.md',
        layer: 'bundled',
        source: '知识层(内置)/乙类/乙篇.md',
        reason: '理由-1',
        codePoints: Array.from(clipWithNotice('乙乙乙乙乙', 3)).length,
        truncated: true,
      },
    ])
    // 报告面取出来只有两列（接口面不连带段文本与 sources）
    expect(knowledgeReportOf(a)).toEqual({ records: a.records, dropped: a.dropped })
  })

  it('dropped 三类齐全且与段处置同源：missing / cap-total / switch-off', () => {
    stubCorpus({ [REL_A]: '甲。', '丙类/丙篇.md': '丙。' })
    const a = assembleKnowledge({
      rels: [REL_A, '无类/此篇.md', '丙类/丙篇.md'],
      heading: '## 头\n',
      fileCap: 3000,
      totalCap: 2, // 甲。已占满 → 丙。超合计帽即止
      reasonOf: () => 'x',
    })
    expect(a.dropped).toEqual([
      { rel: '无类/此篇.md', reason: 'missing' },
      { rel: '丙类/丙篇.md', reason: 'cap-total' },
    ])
    const off = assemble([REL_A], { enabled: false })
    expect(off.dropped).toEqual([{ rel: REL_A, reason: 'switch-off' }])
  })

  it('缺口摘要：只记原因计数不列篇名（摘要要能直接进诊断包），空缺口为「无」', () => {
    expect(summarizeDropped([])).toBe('无')
    expect(
      summarizeDropped([
        { rel: 'a/1.md', reason: 'missing' },
        { rel: 'a/2.md', reason: 'missing' },
        { rel: 'b/3.md', reason: 'cap-total' },
        { rel: 'c/4.md', reason: 'switch-off' },
      ]),
    ).toBe('missing×2 cap-total×1 switch-off×1')
  })
})

// 知识层是三面（写稿/三审/对话）的叠加段，不是主链。资源根缺失时 resourcesRoot() 按设计
// 抛错（打包 bug 须显式暴露），但该错抛在装配层就是一次 500——暴露面交给 check:packaging，
// 装配层降级为空段 + 逐篇 missing 登记。
describe('资源根故障时装配降级（叠加层不拿走主链）', () => {
  it('首次注入的随包语料抽查抛错 → 空段 + 逐篇 missing，不上抛', async () => {
    stubCorpus({ [REL_A]: '甲正文。' })
    // 抽查结果是进程内一次性快照，本档前面的用例已把它填满——要测「首调抽查失败」
    // 必须拿一份快照未填充的模块实例，否则走的是缓存命中，判据根本不执行。
    vi.resetModules()
    FAIL.resources = true
    try {
      const { assembleKnowledge: fresh } = await import('../../src/knowledge/inject.js')
      const r = fresh({
        rels: [REL_A, REL_B],
        heading: '## 段头\n',
        fileCap: 2000,
        totalCap: 3000,
        reasonOf: () => 'x',
      })
      expect(r.text).toBe('')
      expect(r.sources).toEqual([])
      expect(r.dropped).toEqual([
        { rel: REL_A, reason: 'missing' },
        { rel: REL_B, reason: 'missing' },
      ])
    } finally {
      FAIL.resources = false
    }
  })

  it('逐篇解析抛错（快照已命中，探测不执行）→ 该篇记 missing，其余篇不受连坐', () => {
    stubCorpus({ [REL_A]: '甲正文。', [REL_B]: '乙正文。' })
    // 先正常跑一次让快照填充，再只让取件侧失败：此时外层抽查已命中缓存，
    // 唯一能兜住的是逐篇 try——正是本用例要锚的那一层。
    expect(assemble([REL_A]).text).toContain('甲正文。')
    FAIL.resources = true
    try {
      const r = assemble([REL_A, REL_B])
      expect(r.text).toBe('')
      expect(r.dropped).toEqual([
        { rel: REL_A, reason: 'missing' },
        { rel: REL_B, reason: 'missing' },
      ])
    } finally {
      FAIL.resources = false
    }
  })

  it('对照：资源根正常时同一候选照常入选（降级不是恒空段）', () => {
    stubCorpus({ [REL_A]: '甲正文。' })
    const r = assemble([REL_A])
    expect(r.text).toContain('甲正文。')
    expect(r.dropped).toEqual([])
  })
})
