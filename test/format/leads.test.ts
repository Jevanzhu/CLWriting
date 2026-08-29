import { test, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readLead,
  writeLead,
  parseHistory,
  stringifyHistory,
  readLeadDir,
  parseLeadFileName,
} from '../../src/format/leads.js'
import type { Lead } from '../../src/format/types.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

// ── 履历解析（#3 第 4 节）────────────────────────

test('parseHistory: 解析履历列表', () => {
  const body = `
## 履历

- 第012章 埋下：林家祠堂暗格被一笔带过，"那道焦痕在烛火下泛着暗红"。
- 第047章 推进：管家提到"老爷出事那夜，后门的狗没叫"。
- 第152章 回收：揭穿真凶是二叔。
`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(3)
  expect(entries[0]!.章号).toBe(12)
  expect(entries[0]!.动词).toBe('埋下')
  expect(entries[0]!.证据).toContain('焦痕')
  expect(entries[2]!.动词).toBe('回收')
})

test('parseHistory: 回填标记（#3 第 4 节）', () => {
  const body = `## 履历

- 第050章 埋下：早期线索（回填·卷摘要级）`
  const entries = parseHistory(body)
  expect(entries[0]!.回填).toBe(true)
  expect(entries[0]!.证据).toBe('早期线索')
})

test('stringifyHistory + parseHistory 往返', () => {
  const entries = [
    { 章号: 12, 动词: '埋下', 证据: '焦痕' },
    { 章号: 88, 动词: '跃迁', 证据: '渡过心魔劫', 回填: true },
  ]
  const text = stringifyHistory(entries)
  const reparsed = parseHistory(text)
  expect(reparsed).toHaveLength(2)
  expect(reparsed[0]!.章号).toBe(12)
  expect(reparsed[1]!.回填).toBe(true)
})

// ── 完整账本读写往返（容错核心）──────────────────

function makeTmpBook(): string {
  return mkdtempTracked(join(tmpdir(), '北境往事-'))
}

test('readLead + writeLead: 悬念往返不丢字段', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-031-灭门真凶.md')
  const lead: Lead = {
    编号: '悬念-031',
    标题: '灭门真凶',
    类型: '悬念',
    状态: '已收尾',
    开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '焦痕在烛火下泛着暗红' },
      { 章号: 152, 动词: '回收', 证据: '真凶是二叔' },
    ],
  }
  writeLead(fp, lead)
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.lead.编号).toBe('悬念-031')
    expect(r.lead.状态).toBe('已收尾')
    expect(r.lead.开启章).toBe(12)
    expect(r.lead.履历).toHaveLength(2)
    expect(r.lead.履历[1]!.动词).toBe('回收')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 未知字段容错保留', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-031.md')
  // 手工写一个含未知字段的文件
  writeFileSync(fp, [
    '---',
    '编号: 悬念-031',
    '标题: 灭门真凶',
    '类型: 悬念',
    '状态: 进行中',
    '开启章: 12',
    '自定义备注: 作者手写的备注',
    '---',
    '',
    '## 履历',
    '',
    '- 第012章 埋下：焦痕',
  ].join('\n'), 'utf-8')

  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.lead._raw?.['自定义备注']).toBe('作者手写的备注')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('writeLead: 保留履历前的人工说明正文', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '设定线-001-噬灵玉.md')
  writeFileSync(fp, [
    '---',
    '编号: 设定线-001',
    '标题: 噬灵玉',
    '类型: 设定线',
    '状态: 进行中',
    '开启章: 1',
    '---',
    '',
    '噬灵玉是母亲遗物，可以吞噬炼化外物灵气。',
    '',
    '## 履历',
    '',
    '- 第001章 树立：玉佩初醒',
  ].join('\n'), 'utf-8')

  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    r.lead.履历.push({ 章号: 2, 动词: '深化', 证据: '吞掉妖丹残灵' })
    writeLead(fp, r.lead)
  }
  const content = readFileSync(fp, 'utf-8')
  expect(content).toContain('噬灵玉是母亲遗物')
  expect(content).toContain('吞掉妖丹残灵')
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 成长线特化字段（#6 境界体系）', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '成长线-003-林晚修为.md')
  const lead: Lead = {
    编号: '成长线-003',
    标题: '林晚修为',
    类型: '成长线',
    状态: '进行中',
    开启章: 3,
    境界体系: '修真境界',
    当前境界: '筑基',
    履历: [
      { 章号: 3, 动词: '起步', 证据: '开脉踏入炼气一层' },
      { 章号: 88, 动词: '跃迁', 证据: '突破至筑基' },
    ],
  }
  writeLead(fp, lead)
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.lead.境界体系).toBe('修真境界')
    expect(r.lead.当前境界).toBe('筑基')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 坏文件返回错误不崩', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '坏文件.md')
  writeFileSync(fp, '没有 front matter 的裸文件', 'utf-8')
  const r = readLead(fp)
  expect(r.ok).toBe(false)
  rmSync(dir, { recursive: true, force: true })
})

// ── 目录扫描（重建器用）────────────────────────

test('readLeadDir: 扫描目录、容错跳过坏文件', () => {
  const dir = makeTmpBook()
  const 悬念dir = join(dir, '悬念')
  mkdirSync(悬念dir)

  // 写两个好的、一个坏的
  writeLead(join(悬念dir, '悬念-001-a.md'), {
    编号: '悬念-001', 标题: 'a', 类型: '悬念', 状态: '进行中', 开启章: 1, 履历: [],
  })
  writeLead(join(悬念dir, '悬念-002-b.md'), {
    编号: '悬念-002', 标题: 'b', 类型: '悬念', 状态: '进行中', 开启章: 5, 履历: [],
  })
  writeFileSync(join(悬念dir, '悬念-099-坏.md'), '坏的', 'utf-8')

  const { leads, errors } = readLeadDir(悬念dir)
  expect(leads).toHaveLength(2)
  expect(errors).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
})

test('readLeadDir: 文件名缺标题后缀时报错，避免履历落盘静默失配', () => {
  const dir = makeTmpBook()
  const 设定dir = join(dir, '设定线')
  mkdirSync(设定dir)
  writeFileSync(join(设定dir, '设定线-001.md'), [
    '---',
    '编号: 设定线-001',
    '标题: 噬灵玉',
    '类型: 设定线',
    '状态: 进行中',
    '开启章: 1',
    '---',
    '',
    '## 履历',
  ].join('\n'), 'utf-8')

  const { leads, errors } = readLeadDir(设定dir)
  expect(leads).toHaveLength(0)
  expect(errors[0]?.message).toContain('<编号>-<标题>.md')
  rmSync(dir, { recursive: true, force: true })
})

test('readLeadDir: 目录不存在返回空（未启用类）', () => {
  const { leads, errors } = readLeadDir(join(tmpdir(), '不存在的目录-' + Date.now()))
  expect(leads).toHaveLength(0)
  expect(errors).toHaveLength(0)
})

// ── 文件名解析 ─────────────────────────────────

test('parseLeadFileName', () => {
  expect(parseLeadFileName('悬念-031-灭门真凶.md')).toEqual({ 编号: '悬念-031', 标题: '灭门真凶' })
  expect(parseLeadFileName('成长线-003-林晚修为.md')).toEqual({ 编号: '成长线-003', 标题: '林晚修为' })
  expect(parseLeadFileName('乱七八糟.md')).toBeNull()
})

// ── dd-P2：履历段后的人工正文（备注/关联线索）回写保留 ──

test('writeLead: 履历段后的 ## 尾段在回写后原样保留', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-001-暗格.md')
  const original = [
    '---',
    '编号: 悬念-001',
    '标题: 暗格',
    '类型: 悬念',
    '状态: 进行中',
    '开启章: 12',
    '---',
    '',
    '祠堂暗格的来历说明（履历段前人工正文）。',
    '',
    '## 履历',
    '',
    '- 第012章 埋下：林家祠堂暗格被一笔带过。',
    '',
    '## 关联线索',
    '',
    '- 与 悬念-002 灭门夜共享时间线（作者手写备注）。',
    '',
  ].join('\n')
  writeFileSync(fp, original)

  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 追加一条履历再回写——尾段必须还在
  r.lead.履历.push({ 章号: 47, 动词: '推进', 证据: '管家提到那夜后门的狗没叫' })
  writeLead(fp, r.lead)

  const after = readFileSync(fp, 'utf8')
  expect(after).toContain('## 关联线索')
  expect(after).toContain('与 悬念-002 灭门夜共享时间线')
  expect(after).toContain('祠堂暗格的来历说明')
  expect(after).toContain('第047章 推进')
  // 再读一轮：履历两条、编号不变（可继续往返）
  const r2 = readLead(fp)
  expect(r2.ok).toBe(true)
  if (r2.ok) expect(r2.lead.履历).toHaveLength(2)
  rmSync(dir, { recursive: true, force: true })
})

test('writeLead: 无尾段时回写不引入空段（与旧格式字节等价语义）', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-002-狗.md')
  writeFileSync(
    fp,
    ['---', '编号: 悬念-002', '标题: 狗', '类型: 悬念', '状态: 进行中', '开启章: 47', '---', '', '## 履历', '', '- 第047章 埋下：狗没叫。', ''].join('\n'),
  )
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  writeLead(fp, r.lead)
  const after = readFileSync(fp, 'utf8')
  expect(after).not.toContain('\n\n\n') // 无连续空行残留
  expect(after.trimEnd().endsWith('- 第047章 埋下：狗没叫。')).toBe(true)
  rmSync(dir, { recursive: true, force: true })
})

// ── R73-22（二十一轮）：类型/状态非法值 fail-loud + legacy 迁移旁路 ──

test('readLead: 类型写非法值 → 结构化错误（不再静默落「悬念」）', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-003-错字.md')
  writeFileSync(
    fp,
    ['---', '编号: 悬念-003', '标题: 错字', '类型: 选念', '状态: 进行中', '---', '', '## 履历', ''].join('\n'),
  )
  const r = readLead(fp)
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error.message).toContain('「类型」非法')
  expect(r.error.message).toContain('选念')
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 状态写非法值 → 结构化错误（不再静默落「进行中」）', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-004-错状态.md')
  writeFileSync(
    fp,
    ['---', '编号: 悬念-004', '标题: 错状态', '类型: 悬念', '状态: 已完结', '---', '', '## 履历', ''].join('\n'),
  )
  const r = readLead(fp)
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error.message).toContain('「状态」非法')
  expect(r.error.message).toContain('已完结')
  rmSync(dir, { recursive: true, force: true })
})

test('readLead: 缺字段维持默认回落（存量手写账本兼容）；legacy 旁路容忍旧档非法类型', () => {
  const dir = makeTmpBook()
  // 缺类型/状态 → 默认回落（R73-22 不改缺字段语义）
  const fpMissing = join(dir, '悬念-005-缺字段.md')
  writeFileSync(
    fpMissing,
    ['---', '编号: 悬念-005', '标题: 缺字段', '---', '', '## 履历', ''].join('\n'),
  )
  const rMissing = readLead(fpMissing)
  expect(rMissing.ok).toBe(true)
  if (rMissing.ok) {
    expect(rMissing.lead.类型).toBe('悬念')
    expect(rMissing.lead.状态).toBe('进行中')
  }
  // 旧 scheme（大纲/伏笔 迁移源）：类型「伏笔」非法于六类，legacy 旁路放行
  const fpLegacy = join(dir, '伏笔-031-灭门真凶.md')
  writeFileSync(
    fpLegacy,
    ['---', '编号: 伏笔-031', '标题: 灭门真凶', '类型: 伏笔', '状态: 进行中', '开启章: 1', '---', '', '## 履历', '', '- 第001章 埋下：焦痕', ''].join('\n'),
  )
  expect(readLead(fpLegacy).ok).toBe(false) // 现行口径仍 fail-loud
  const rLegacy = readLead(fpLegacy, { legacy: true })
  expect(rLegacy.ok).toBe(true)
  if (rLegacy.ok) expect(rLegacy.lead.履历).toHaveLength(1)
  rmSync(dir, { recursive: true, force: true })
})

// ── R75-2（二十三轮）：条目段 ATX 标题不折入证据 + 节终保真 + 分组跳过 ──

test('R75-2: 条目后的 ### 手记 标题行不折入上一条证据（定稿假红防线）', () => {
  const body = `## 履历

- 第012章 埋下：林家祠堂暗格被一笔带过。
- 第047章 推进：管家提到那夜后门的狗没叫。

### 手记

作者备注：这条线要在第三卷收掉。`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(2)
  // 标题与其后备注零折入——此前会被 R64-17 续行折拼成「…狗没叫。 ### 手记 作者备注：…」
  expect(entries[1]!.证据).toBe('管家提到那夜后门的狗没叫。')
})

test('R75-2: # 一级 / ### 三级标题同样终断（此前仅 ## 二级终断，其余级别折入证据）', () => {
  const body = `## 履历

- 第012章 埋下：焦痕

# 章外笔记

随便写`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(1)
  expect(entries[0]!.证据).toBe('焦痕')
})

test('R75-2: 分组标题跳过、其后条目照常解析（不丢条目）', () => {
  const body = `## 履历

- 第001章 埋下：焦痕

### 第二阶段

- 第047章 推进：狗没叫`
  const entries = parseHistory(body)
  expect(entries).toHaveLength(2)
  expect(entries[0]!.证据).toBe('焦痕')
  expect(entries[1]!.章号).toBe(47)
  expect(entries[1]!.证据).toBe('狗没叫')
})

test('R75-2: 节终标题后的人工内容回写保真（readLead→writeLead 往返）', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-006-手记.md')
  const original = [
    '---',
    '编号: 悬念-006',
    '标题: 手记',
    '类型: 悬念',
    '状态: 进行中',
    '开启章: 12',
    '---',
    '',
    '## 履历',
    '',
    '- 第012章 埋下：焦痕泛着暗红。',
    '',
    '### 手记',
    '',
    '作者手写备注，不能被回写吞掉。',
    '',
  ].join('\n')
  writeFileSync(fp, original)
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.lead.履历[0]!.证据).toBe('焦痕泛着暗红。') // 证据干净（标题未折入）
  r.lead.履历.push({ 章号: 47, 动词: '推进', 证据: '狗没叫' })
  writeLead(fp, r.lead)
  const after = readFileSync(fp, 'utf8')
  expect(after).toContain('### 手记')
  expect(after).toContain('作者手写备注，不能被回写吞掉。')
  expect(after).toContain('第047章 推进')
  // 再读一轮：履历两条、证据仍干净（可继续往返）
  const r2 = readLead(fp)
  expect(r2.ok).toBe(true)
  if (r2.ok) {
    expect(r2.lead.履历).toHaveLength(2)
    expect(r2.lead.履历[0]!.证据).toBe('焦痕泛着暗红。')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('R75-2: 空履历 + 尾段（`## 履历` 后直接 `## 备注`）after 段维持保真', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-007-空履历.md')
  writeFileSync(fp, [
    '---', '编号: 悬念-007', '标题: 空履历', '类型: 悬念', '状态: 进行中', '---', '',
    '## 履历', '',
    '## 备注', '',
    '只有备注没有条目。',
  ].join('\n'))
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.lead.履历).toHaveLength(0)
  writeLead(fp, r.lead)
  const after = readFileSync(fp, 'utf8')
  expect(after).toContain('## 备注')
  expect(after).toContain('只有备注没有条目。')
  rmSync(dir, { recursive: true, force: true })
})

test('R75-2: 开启章 非数值回落 0（NaN 防线，对齐 chapters.ts R64-19 口径）', () => {
  const dir = makeTmpBook()
  const fp = join(dir, '悬念-008-乱数.md')
  writeFileSync(fp, [
    '---', '编号: 悬念-008', '标题: 乱数', '类型: 悬念', '状态: 进行中', '开启章: 十二', '---', '', '## 履历', '',
  ].join('\n'))
  const r = readLead(fp)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.lead.开启章).toBe(0)
  rmSync(dir, { recursive: true, force: true })
})
