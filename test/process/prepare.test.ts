import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncLead, syncChapter, syncSummary } from '../../src/cache/sync.js'
import { prepare, estimateTokens, TOKEN_COEFFICIENTS } from '../../src/process/prepare.js'
import { addEntry } from '../../src/format/style-entry.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

function makeBookWithMaterial(): { root: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))
  // book.yaml
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)

  // 缓存
  const dbPath = join(root, '.cache', 'index.db')
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  createAllTables(db)

  syncChapter(db, {
    章号: 150, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 3000, _path: 'p150',
  })
  syncLead(db, {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '进行中', 开启章: 12,
    履历: [{ 章号: 12, 动词: '埋下', 证据: '焦痕' }], _path: 'p',
  })

  // 文风铁律
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止强行和解\n## 硬约束\n单句≤60字', 'utf-8')

  // 文风样章
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(join(root, '文风', '样章库', '战斗', '战斗-001.md'),
    '---\n场景: 战斗\n来源: 作者原作\n技法指令: 学它的停顿\n---\n刀光没入雪雾。', 'utf-8')
  mkdirSync(join(root, '文风', '样章库', '对话'), { recursive: true })
  writeFileSync(join(root, '文风', '样章库', '对话', '对话-001.md'),
    '---\n场景: 对话\n来源: 作者原作\n技法指令: 学它的留白\n---\n她沉默了一会儿，说：你早就知道。', 'utf-8')

  // 章摘要
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  writeFileSync(join(root, '定稿', '摘要', '章摘要', '150.md'), '前章内容回顾。', 'utf-8')
  syncSummary(db, 'chapter', 150, join(root, '定稿', '摘要', '章摘要', '150.md'))

  return { root, db }
}

test('prepare: 刚需段全在（近况/账本/铁律）', () => {
  const { root, db } = makeBookWithMaterial()
  const r = prepare(db, DEFAULT_CONFIG, root, ['悬念-031'])
  const titles = r.sections.filter((s) => s.essential).map((s) => s.title)
  expect(titles).toContain('近况')
  expect(titles).toContain('本章推进的账本')
  expect(titles).toContain('文风铁律')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 无裁剪时 trimmed=false', () => {
  const { root, db } = makeBookWithMaterial()
  const r = prepare(db, DEFAULT_CONFIG, root, ['悬念-031'])
  expect(r.trimmed).toBe(false)
  expect(r.text).not.toContain('因预算裁剪')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 超预算按优先级裁剪（弹性#4→#3→#2→#1），刚需不丢', () => {
  const { root, db } = makeBookWithMaterial()
  // 设极小预算（100 token），逼裁剪
  const cfg: BookConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, input_per_chapter: 100 } }
  const r = prepare(db, cfg, root, ['悬念-031'])

  expect(r.trimmed).toBe(true)
  expect(r.text).toContain('因预算裁剪')
  // 刚需段必须保留
  const essentialTitles = r.sections.filter((s) => s.essential).map((s) => s.title)
  expect(essentialTitles).toContain('近况')
  expect(essentialTitles).toContain('文风铁律')
  // 弹性段被裁
  const flexTitles = r.sections.filter((s) => !s.essential).map((s) => s.title)
  // 文风样章（弹性#2）应被裁掉
  expect(flexTitles).not.toContain('文风样章')

  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 文风轻注入只取 1 段', () => {
  const { root, db } = makeBookWithMaterial()
  const r = prepare(db, DEFAULT_CONFIG, root, [])
  const styleSection = r.sections.find((s) => s.title === '文风样章')
  if (styleSection) {
    // 轻注入 = 1 段
    expect(styleSection.content.split('\n\n').length).toBeLessThanOrEqual(1)
    expect(styleSection.content).toContain('技法指令：学它的停顿')
  }
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 可按场景注入文风样章，避免固定战斗样章', () => {
  const { root, db } = makeBookWithMaterial()
  const r = prepare(db, DEFAULT_CONFIG, root, [], undefined, '对话')
  const styleSection = r.sections.find((s) => s.title === '文风样章')
  expect(styleSection).toEqual(expect.objectContaining({ title: '文风样章' }))
  expect(styleSection!.content).toContain('学它的留白')
  expect(styleSection!.content).toContain('你早就知道')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('G2: 多场景注入（heavy）→ 主场景优先 + 次场景补', () => {
  const { root, db } = makeBookWithMaterial()
  // makeBookWithMaterial 各场景仅 1 样章，再给主场景「战斗」补 1 段，验证主优先填满
  writeFileSync(
    join(root, '文风', '样章库', '战斗', '战斗-002.md'),
    '---\n场景: 战斗\n来源: 作者原作\n---\n第二段战斗：长枪破阵。', 'utf-8',
  )
  const cfg: BookConfig = { ...DEFAULT_CONFIG, style: { injection: 'heavy' } }
  // 主场景=战斗，次场景=对话
  const r = prepare(db, cfg, root, [], undefined, ['战斗', '对话'])
  const styleSection = r.sections.find((s) => s.title === '文风样章')
  expect(styleSection).toEqual(expect.objectContaining({ title: '文风样章' }))
  // heavy 总量 3：战斗各取 1（主）+ 对话 1（次）+ 战斗补 1 = 战斗×2 + 对话×1
  expect(styleSection!.content).toContain('刀光没入雪雾') // 主场景首段
  expect(styleSection!.content).toContain('长枪破阵') // 主场景补段
  expect(styleSection!.content).toContain('你早就知道') // 次场景代表
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('G2: 轻档多场景 → 只主场景 1 段（保持轻注入）', () => {
  const { root, db } = makeBookWithMaterial()
  // 默认轻注入
  const r = prepare(db, DEFAULT_CONFIG, root, [], undefined, ['对话', '战斗'])
  const styleSection = r.sections.find((s) => s.title === '文风样章')
  expect(styleSection).toEqual(expect.objectContaining({ title: '文风样章' }))
  expect(styleSection!.content).toContain('你早就知道') // 主场景=对话
  expect(styleSection!.content).not.toContain('刀光没入雪雾') // 轻档不带次场景
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare: 近况卷号使用 book.volume_size', () => {
  const root = mkdtempSync(join(tmpdir(), '卷大小-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 31, 标题: '第三十一章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 1000, _path: 'p31',
  })
  const cfg: BookConfig = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book, volume_size: 30 } }
  const r = prepare(db, cfg, root, [])
  expect(r.text).toContain('已写到第 31 章（第 2 卷）')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('estimateTokens: 中文 0.6 token/字', () => {
  expect(estimateTokens('')).toBe(0)
  const t = estimateTokens('一二三四五六七八九十') // 10 字
  expect(t).toBe(6) // 10 * 0.6
})

test('#8: 非默认 token 系数下，降档/移除扣减与累计同 model 口径（estimatedTokens == 剩余段真实和）', () => {
  const root = mkdtempSync(join(tmpdir(), '口径-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 10, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 1000, _path: 'p10',
  })
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  const big = '刀'.repeat(1000)
  for (let i = 1; i <= 3; i++) {
    writeFileSync(
      join(root, '文风', '样章库', '战斗', `战斗-00${i}.md`),
      `---\n场景: 战斗\n来源: 作者原作\n---\n${big}`, 'utf-8',
    )
  }
  // 注入非默认系数（>0.6）：修复前降档/移除两轮漏传 model 按 0.6 扣减，累计虚高
  // → 过度裁剪 + estimatedTokens 与剩余段真实和分裂；填表即爆的潜伏缺陷回归锚
  TOKEN_COEFFICIENTS['cal-test'] = 1.2
  try {
    const cfg: BookConfig = {
      ...DEFAULT_CONFIG,
      style: { injection: 'heavy' },
      budget: { ...DEFAULT_CONFIG.budget, input_per_chapter: 2000 },
    }
    const r = prepare(db, cfg, root, [], undefined, '战斗', 'cal-test')
    expect(r.trimmed).toBe(true)
    expect(r.trimLog.some((l) => l.includes('降档'))).toBe(true)
    // 不变量：预算扣减全程同 model 系数 → 返回的 estimatedTokens 恰等于剩余段之和
    const trueSum = r.sections.reduce((sum, s) => sum + estimateTokens(s.content, 'cal-test'), 0)
    expect(r.estimatedTokens).toBe(trueSum)
  } finally {
    delete TOKEN_COEFFICIENTS['cal-test']
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepare: 超预算优先降档（文风样章降浓度保留）而非整段删', () => {
  const root = mkdtempSync(join(tmpdir(), '降档-'))
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(join(root, '.cache', 'index.db'))
  createAllTables(db)
  syncChapter(db, {
    章号: 10, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 1000, _path: 'p10',
  })
  // 3 个大样章（heavy 注入 3 段，制造超预算）
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  const big = '刀'.repeat(1000)
  for (let i = 1; i <= 3; i++) {
    writeFileSync(
      join(root, '文风', '样章库', '战斗', `战斗-00${i}.md`),
      `---\n场景: 战斗\n来源: 作者原作\n---\n${big}`, 'utf-8',
    )
  }
  // heavy 浓度 + 中等预算（够降档后、不够全量）
  const cfg: BookConfig = {
    ...DEFAULT_CONFIG,
    style: { injection: 'heavy' },
    budget: { ...DEFAULT_CONFIG.budget, input_per_chapter: 800 },
  }
  const r = prepare(db, cfg, root, [])

  expect(r.trimmed).toBe(true)
  expect(r.trimLog.some((l) => l.includes('降档'))).toBe(true)
  const style = r.sections.find((s) => s.title === '文风样章')
  expect(style).toEqual(expect.objectContaining({ title: '文风样章' })) // 降档保留，未整段删
  expect(style!.content.length).toBeLessThan(1500) // 降档后仅 1 段（≈1000 字），非 heavy 全量 3 段
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('prepare S5: 条目库存在 → 文风便宜段必带 + 条目样章弹性段，铁律不注入', () => {
  const { root, db } = makeBookWithMaterial()
  // 建条目库（迁移后形态）：禁词/手法/样章——条目库存在即走新路
  addEntry(root, { 类型: '禁词', 场景: '通用', 来源: '导入', 正文: '强行和解' })
  addEntry(root, { 类型: '手法', 场景: '通用', 来源: '收割', 正文: '对话不用提示语' })
  addEntry(root, { 类型: '样章', 场景: '战斗', 来源: '作者标注', 说明: '学它的停顿', 正文: '刀光没入雪雾。' })
  const r = prepare(db, DEFAULT_CONFIG, root, ['悬念-031'], undefined, '战斗')
  const style = r.sections.find((s) => s.title === '文风')
  expect(style?.essential).toBe(true)
  expect(style?.content).toContain('禁用：强行和解')
  expect(style?.content).toContain('- 对话不用提示语')
  // 铁律全文不再注入（纯配置不给 AI）
  expect(r.sections.find((s) => s.title === '文风铁律')).toBeUndefined()
  // 样章从条目库出，格式与旧样章注入一致（说明=技法指令行）
  const sample = r.sections.find((s) => s.title === '文风样章')
  expect(sample?.flexibleRank).toBe(2)
  expect(sample?.content).toBe('技法指令：学它的停顿\n刀光没入雪雾。')
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// ── C1 前章正文结尾（flexibleRank=1.5）──────────────

/** 建前章（149章）定稿正文，返回正文末尾预期片段 */
function makePrevChapterFinal(root: string, words = 3000): string {
  mkdirSync(join(root, '写作', '正文', '第一卷'), { recursive: true })
  const body = '前章正文段落。'.repeat(Math.ceil(words / 6))
  writeFileSync(
    join(root, '写作', '正文', '第一卷', '149-前章.md'),
    `---\n章号: 149\n标题: 前章\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 铺垫\n---\n${body}`,
    'utf-8',
  )
  return body
}

test('C1: 有前章定稿正文 → 「前章正文结尾」段出现，flexibleRank=1.5', () => {
  const { root, db } = makeBookWithMaterial()
  makePrevChapterFinal(root)
  const r = prepare(db, DEFAULT_CONFIG, root, ['悬念-031'])
  const sec = r.sections.find((s) => s.title === '前章正文结尾')
  expect(sec).toEqual(expect.objectContaining({ title: '前章正文结尾', essential: false, flexibleRank: 1.5 }))
  // 内容以【第149章正文结尾】开头
  expect(sec!.content).toContain('【第149章正文结尾】')
  // 全量版取末尾约 1500 字（段落边界截断后 ≤ 1500 + 前缀）
  const bodyText = sec!.content.split('\n').slice(1).join('\n')
  expect(bodyText.length).toBeLessThanOrEqual(1500)
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('C1: 无前章文件 → 无此段（产物逐字节不变）', () => {
  const { root, db } = makeBookWithMaterial()
  // makeBookWithMaterial 的 currentChapter=150，prev=149；149 正文/草稿皆缺
  const r = prepare(db, DEFAULT_CONFIG, root, ['悬念-031'])
  expect(r.sections.find((s) => s.title === '前章正文结尾')).toBeUndefined()
  // 第 1 章场景：prevChapterNo=0，不进段
  const root2 = mkdtempSync(join(tmpdir(), '第一章-'))
  mkdirSync(join(root2, '.cache'), { recursive: true })
  const db2 = new DatabaseSync(join(root2, '.cache', 'index.db'))
  createAllTables(db2)
  syncChapter(db2, {
    章号: 1, 标题: '第一章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 1000, _path: 'p1',
  })
  const r2 = prepare(db2, DEFAULT_CONFIG, root2, [])
  expect(r2.sections.find((s) => s.title === '前章正文结尾')).toBeUndefined()
  db.close()
  db2.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(root2, { recursive: true, force: true })
})

test('C1: flexibleRank 1.5 排序——裁剪先于 rank1(近章结尾)、后于 rank2(文风样章)', () => {
  const { root, db } = makeBookWithMaterial()
  makePrevChapterFinal(root)
  // 极小预算 → 全弹性段降档 + 移除
  const cfg: BookConfig = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, input_per_chapter: 50 } }
  const r = prepare(db, cfg, root, ['悬念-031'])
  expect(r.trimmed).toBe(true)
  // 移除阶段按 flexibleRank 降序：rank2 → rank1.5 → rank1（只看移除记录，降档记录因各段降档空间不同不可靠）
  const removals = r.trimLog.filter((l) => l.includes('移除'))
  const idx2 = removals.findIndex((l) => l.includes('文风样章'))
  const idx15 = removals.findIndex((l) => l.includes('前章正文结尾'))
  const idx1 = removals.findIndex((l) => l.includes('近章结尾'))
  expect(idx2).toBeGreaterThanOrEqual(0)
  expect(idx15).toBeGreaterThanOrEqual(0)
  expect(idx1).toBeGreaterThanOrEqual(0)
  expect(idx2).toBeLessThan(idx15) // rank2 先砍
  expect(idx15).toBeLessThan(idx1) // rank1.5 先于 rank1 砍
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('C1: 降档版 degradedContent = 末尾 500 字', () => {
  const { root, db } = makeBookWithMaterial()
  makePrevChapterFinal(root, 3000)
  const r = prepare(db, DEFAULT_CONFIG, root, ['悬念-031'])
  const sec = r.sections.find((s) => s.title === '前章正文结尾')
  expect(sec).toEqual(expect.objectContaining({ title: '前章正文结尾' }))
  expect(typeof sec!.degradedContent).toBe('string')
  // 降档版以【第149章正文结尾】开头
  expect(sec!.degradedContent).toContain('【第149章正文结尾】')
  // 降档正文 ≤ 500 字
  const degBody = sec!.degradedContent!.split('\n').slice(1).join('\n')
  expect(degBody.length).toBeLessThanOrEqual(500)
  // 降档版比全量短
  expect(sec!.degradedContent!.length).toBeLessThan(sec!.content.length)
  db.close()
  rmSync(root, { recursive: true, force: true })
})
