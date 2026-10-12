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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { assembleKnowledge, titleOf } from '../../src/knowledge/inject.js'

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
