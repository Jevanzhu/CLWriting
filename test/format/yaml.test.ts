import { test, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readBookConfig,
  writeBookConfig,
  stringifyBookConfig,
  patchTopSection,
  parseBookConfig,
  DEFAULT_CONFIG,
} from '../../src/format/yaml.js'

test('readBookConfig: 完整解析（#9 第 2 节）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, [
    'spec_version: 1',
    '',
    'book:',
    '  title: 北境往事',
    '  genre: 玄幻',
    '  volume_size: 40',
    '',
    'leads:',
    '  enabled: [布局线, 设定线, 成长线]',
    '  thresholds:',
    '    成长线: 50',
    '',
    'budget:',
    '  calls_per_chapter: 8',
    '  input_per_chapter: 80000',
    '  summary_chapter_max: 200',
    '  summary_volume_max: 500',
    '',
    'style:',
    '  injection: light',
    '',
    'auto:',
    '  confirm_outline: false',
    '  batch_size: 8',
    '',
    'growth:',
    '  realm_span_max: 2',
  ].join('\n'), 'utf-8')

  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.book.title).toBe('北境往事')
    expect(r.config.book.genre).toBe('玄幻')
    expect(r.config.book.volume_size).toBe(40)
    expect(r.config.leads.enabled).toEqual(['布局线', '设定线', '成长线'])
    expect(r.config.leads.thresholds?.['成长线']).toBe(50)
    expect(r.config.budget.calls_per_chapter).toBe(8)
    expect(r.config.auto?.confirm_outline).toBe(false)
    expect(r.config.growth.realm_span_max).toBe(2)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('writeBookConfig + readBookConfig: 可选 volume_size 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeBookConfig(fp, {
    ...DEFAULT_CONFIG,
    book: { title: '雪落长安', genre: '历史', volume_size: 30 },
  })
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.book.volume_size).toBe(30)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('rag 段：provider 引用往返；设 provider 时不再写旧内联 endpoint/model', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')

  // 服务商引用形态：只写 enabled + provider
  writeBookConfig(fp, {
    ...DEFAULT_CONFIG,
    rag: { enabled: true, provider: 'rag-abc123' },
  })
  let raw = readFileSync(fp, 'utf8')
  expect(raw).toContain('provider: rag-abc123')
  expect(raw).not.toContain('endpoint:')
  let r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.rag).toMatchObject({ enabled: true, provider: 'rag-abc123' })

  // 旧版内联形态仍可解析（存量书兼容）
  writeFileSync(fp, raw.replace('  provider: rag-abc123', '  endpoint: https://x/v1/embeddings\n  model: embed-m'), 'utf8')
  r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.rag).toMatchObject({ enabled: true, endpoint: 'https://x/v1/embeddings', model: 'embed-m' })
  rmSync(dir, { recursive: true, force: true })
})

test('readBookConfig: 文件不存在返回默认', () => {
  const r = readBookConfig(join(tmpdir(), '不存在-' + Date.now() + '.yaml'))
  expect(r.ok).toBe(false)
  expect(r.config).toEqual(DEFAULT_CONFIG)
})

test('X-P2-17: 错误分支返回默认配置深拷贝——调用方 mutate 不串污染单例', () => {
  const r1 = readBookConfig(join(tmpdir(), '不存在-' + Date.now() + '.yaml'))
  expect(r1.ok).toBe(false)
  if (!r1.ok) {
    r1.config.book.title = '污染'
    r1.config.budget.calls_per_chapter = 999
  }
  // 再读一次：模块级 DEFAULT_CONFIG 未被上一份返回值污染
  const r2 = readBookConfig(join(tmpdir(), '不存在-' + Date.now() + '.yaml'))
  expect(r2.config.book.title).toBe('')
  expect(r2.config.budget.calls_per_chapter).toBe(DEFAULT_CONFIG.budget.calls_per_chapter)
  expect(DEFAULT_CONFIG.book.title).toBe('')
})

test('writeBookConfig + readBookConfig 往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  const cfg = {
    ...DEFAULT_CONFIG,
    book: { title: '雪落长安', genre: '历史' },
    leads: { enabled: ['布局线'], thresholds: { 布局线: 20 } },
  }
  writeBookConfig(fp, cfg)
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.book.title).toBe('雪落长安')
    expect(r.config.leads.enabled).toEqual(['布局线'])
    expect(r.config.leads.thresholds?.['布局线']).toBe(20)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('RB-KN-P2-10: auto.relation_auto_mine / relation_mine_threshold 解析 + 序列化往返', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeBookConfig(fp, {
    ...DEFAULT_CONFIG,
    auto: { ...DEFAULT_CONFIG.auto, relation_auto_mine: false, relation_mine_threshold: 7 },
  })
  // 序列化包含两键（缺省不输出的红线只约束未配置的书）
  const text = readFileSync(fp, 'utf-8')
  expect(text).toContain('relation_auto_mine: false')
  expect(text).toContain('relation_mine_threshold: 7')
  // 读回不丢（修复前：解析不支持 → 永远回落默认）
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.auto?.relation_auto_mine).toBe(false)
    expect(r.config.auto?.relation_mine_threshold).toBe(7)
  }
  // 缺省书不落两键（现有仓库零改动红线）
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('relation_auto_mine')
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('relation_mine_threshold')
  rmSync(dir, { recursive: true, force: true })
})

test('readBookConfig: 数字字段坏值不设键（留给全局托底链回落），不注入 NaN', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, [
    'spec_version: abc',
    'leads:',
    '  thresholds:',
    '    成长线: nope',
    'budget:',
    '  calls_per_chapter: abc',
    '  input_per_chapter: 90000',
    'auto:',
    '  batch_size: nope',
    'growth:',
    '  realm_span_max: nope',
  ].join('\n'), 'utf-8')

  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.spec_version).toBe(1)
    // 全局托底：坏值 = 未设（undefined），运行时合并层回落 global.json → 硬编码
    expect(r.config.budget.calls_per_chapter).toBeUndefined()
    expect(r.config.budget.input_per_chapter).toBe(90000)
    expect(r.config.auto?.batch_size).toBeUndefined()
    expect(r.config.growth.realm_span_max).toBe(2)
    expect(r.config.leads.thresholds?.['成长线']).toBeUndefined()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('stringifyBookConfig: leads.enabled 为空数组时合法', () => {
  const text = stringifyBookConfig(DEFAULT_CONFIG)
  expect(text).toContain('enabled: []')
  expect(text).toContain('spec_version: 1')
})

test('stringifyBookConfig: rag.candidate_depth 随段输出且可回读（PUT /config 回退全量重生成分支不丢键）', () => {
  const cfg = structuredClone(DEFAULT_CONFIG)
  cfg.rag = { enabled: true, endpoint: 'http://e', model: 'm', candidate_depth: 30 }
  const text = stringifyBookConfig(cfg)
  expect(text).toContain('candidate_depth: 30')
  // 回读闭环：解析能收回（修复前 stringify 漏写 → 全量重生成静默抹掉已配深度）
  const r = parseBookConfig(text)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.rag?.candidate_depth).toBe(30)
  // 缺省不落键（现有仓库零改动红线）
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('candidate_depth')
})

// ── workflow 字段已删除（W0 §2 废弃）──
// 存量 book.yaml 里的 workflow 行是未知字段：解析不赋值、输出不写，
// 下次存配置 stringifyBookConfig 重建时自然丢弃（无行为字段，无兼容负担）。

test('workflow: 存量 book.yaml 的 workflow 行不再解析/输出（删除语义）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, ['spec_version: 1', '', 'workflow: 自由', ''].join('\n'), 'utf-8')
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    // 字段类型已删：解析不再产出 workflow
    expect('workflow' in r.config).toBe(false)
    // 重建输出不写 workflow 行
    expect(stringifyBookConfig(r.config)).not.toContain('workflow')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('snapshots 段：缺省不输出（零改动红线）；有值往返一致', () => {
  expect(stringifyBookConfig(DEFAULT_CONFIG)).not.toContain('snapshots')

  const text = stringifyBookConfig({
    ...DEFAULT_CONFIG,
    snapshots: { max_days: 30, max_count: 50 },
  })
  expect(text).toContain('snapshots:')
  expect(text).toContain('  max_days: 30')
  expect(text).toContain('  max_count: 50')

  const dir = mkdtempSync(join(tmpdir(), 'yaml-snap-'))
  writeFileSync(join(dir, 'book.yaml'), text, 'utf-8')
  const r = readBookConfig(join(dir, 'book.yaml'))
  expect(r.ok).toBe(true)
  if (r.ok) {
    expect(r.config.snapshots?.max_days).toBe(30)
    expect(r.config.snapshots?.max_count).toBe(50)
  }
  rmSync(dir, { recursive: true, force: true })
})

test('snapshots 段：非正数值忽略（回落代码默认）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yaml-snap-bad-'))
  writeFileSync(
    join(dir, 'book.yaml'),
    'spec_version: 1\nbook:\n  title: 书\n  genre: 玄幻\nsnapshots:\n  max_days: 0\n  max_count: -5\n',
    'utf-8',
  )
  const r = readBookConfig(join(dir, 'book.yaml'))
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.snapshots).toBeUndefined()
  rmSync(dir, { recursive: true, force: true })
})

// ── V-P2-4：patchTopSection 文本级段补丁（读改写保注释/未知段）────────

test('patchTopSection: 替换中间段，前后原文逐字保留', () => {
    const raw = 'a: 1\n# 注释\nrag:\n  enabled: false\n\nb: 2\n'
    const out = patchTopSection(raw, 'rag', '  enabled: true\n  model: m')
    expect(out).toBe('a: 1\n# 注释\nrag:\n  enabled: true\n  model: m\n\nb: 2\n')
  })

test('patchTopSection: 段不存在 → 追加（空行分隔）', () => {
    const raw = 'a: 1\n'
    const out = patchTopSection(raw, 'rag', '  enabled: true')
    expect(out).toBe('a: 1\n\nrag:\n  enabled: true\n')
  })

test('patchTopSection: 空文件 → 纯新段', () => {
    expect(patchTopSection('', 'rag', '  enabled: true')).toBe('rag:\n  enabled: true\n')
  })

test('patchTopSection: 段内注释被替换（段区间归段所有），段外注释保留', () => {
    const raw = '# 外注释\nrag:\n# 段内注释\n  enabled: false\nhost: cc\n'
    const out = patchTopSection(raw, 'rag', '  enabled: true')
    expect(out).toBe('# 外注释\nrag:\n  enabled: true\nhost: cc\n')
  })

test('patchTopSection: 无尾换行文件 → 补齐结构', () => {
    const out = patchTopSection('a: 1', 'rag', '  enabled: true')
    expect(out).toBe('a: 1\n\nrag:\n  enabled: true\n')
  })

// ── dd-P2：块式列表项（`- xxx` 无冒号行）不再被静默丢弃 ──

test('readBookConfig: 块式列表（- 项）拼成数组，等价内联写法（dd-P2）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-block-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(
    fp,
    [
      'spec_version: 1',
      'kind: long',
      'book:',
      '  title: 北境往事',
      '  genre: 玄幻',
      'host: cc',
      'leads:',
      '  enabled:',
      '    - 布局线',
      '    - 设定线',
      '    - 成长线',
      '  thresholds:',
      '    成长线: 50',
      '',
    ].join('\n'),
  )
  const cfg = readBookConfig(fp).config
  expect(cfg.leads.enabled).toEqual(['布局线', '设定线', '成长线'])
  expect(cfg.leads.thresholds?.['成长线']).toBe(50)
  rmSync(dir, { recursive: true, force: true })
})

test('readBookConfig: 块式列表项含逗号时精确解析（ii 批逐项转义）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-block2-'))
  const fp = join(dir, 'book.yaml')
  // ii 批前裸 join：项含半角逗号 → 拼出的内联数组多切一刀（已知边界只断言不炸）；
  // 现逐项走 stringifyValue 转义，含逗号/括号/引号项往返精确。
  // 用 short.target_emotions 测（任意字符串数组；leads.enabled 有账本类白名单会过滤测试值）
  writeFileSync(fp, 'spec_version: 1\nkind: short\nbook:\n  title: T\nshort:\n  profile: p\n  target_emotions:\n    - 惊悚\n    - 悬疑,推理\n    - [带括号]\n')
  const cfg = readBookConfig(fp).config
  expect(cfg.short?.target_emotions).toEqual(['惊悚', '悬疑,推理', '[带括号]'])
  rmSync(dir, { recursive: true, force: true })
})

test('readBookConfig: 行内注释剥离（ii 批）——空白前置 # 起注释，引号内/紧贴字的 # 保留', () => {
  const out = parseBookConfig([
    'spec_version: 1',
    'kind: long',
    'book:',
    '  title: 北境往事 # 首部',
    '  genre: "玄幻 # 悬" # 注释',
    'rag:',
    '  enabled: false',
    '  endpoint: http://rag.local:8080/x#frag',
    'host: cc',
    '',
  ].join('\n'))
  expect(out.ok).toBe(true)
  expect(out.config.book.title).toBe('北境往事')
  expect(out.config.book.genre).toBe('玄幻 # 悬')
  expect(out.config.rag?.endpoint).toBe('http://rag.local:8080/x#frag')
  // 块列表项同样剥注释
  const out2 = parseBookConfig('kind: long\nleads:\n  enabled:\n    - 布局线 # 高频\n    - 设定线\n')
  expect(out2.ok).toBe(true)
  expect(out2.config.leads.enabled).toEqual(['布局线', '设定线'])
})

test('readBookConfig: 有值键下的缩进子行显式报错，不再静默错挂（ff P2-2 / ii 批）', () => {
  const out = parseBookConfig('host: cc\n  book: 误挂\n')
  expect(out.ok).toBe(false)
  if (!out.ok) {
    expect(out.error.message).toContain('缩进子行')
    expect(out.error.message).toContain('host')
  }
  // 块列表项跟在有值键后同样报错
  const out2 = parseBookConfig('kind: long\nleads:\n  enabled: [布局线]\n    - 设定线\n')
  expect(out2.ok).toBe(false)
  if (!out2.ok) {
    expect(out2.error.message).toContain('缩进子行')
  }
})

// ── 书级设定全局托底：键可选化 + 条件输出（现有仓库零改动红线）────────

test('全局托底: 无键新文件 roundtrip 不新增 13 键（未设语义存活）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-global-'))
  const fp = join(dir, 'book.yaml')
  // 新 scaffold 产物：无 genre 空占位、无 style/auto 段、budget 无 calls_per_chapter
  writeFileSync(fp, [
    'spec_version: 1',
    'host: cc',
    'book:',
    '  title: 新书',
    '',
    'leads:',
    '  enabled: []',
    '',
    'budget:',
    '  input_per_chapter: 80000',
    '  summary_chapter_max: 200',
    '  summary_volume_max: 500',
    '',
    'growth:',
    '  realm_span_max: 2',
    '',
  ].join('\n'), 'utf-8')

  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 解析侧：未设键保持 undefined（喂运行时才由 applyGlobalDefaults 回落）
  expect(r.config.book.genre).toBeUndefined()
  expect(r.config.style).toBeUndefined()
  expect(r.config.auto).toBeUndefined()
  expect(r.config.budget.calls_per_chapter).toBeUndefined()
  // 写侧：undefined 不落行——roundtrip 文本零新增
  const out = stringifyBookConfig(r.config)
  expect(out).not.toContain('genre')
  expect(out).not.toContain('style')
  expect(out).not.toContain('auto')
  expect(out).not.toContain('calls_per_chapter')
  // 再 parse 一遍仍全 undefined（往返不漂移）
  const r2 = parseBookConfig(out)
  expect(r2.ok).toBe(true)
  if (r2.ok) {
    expect(r2.config.book.genre).toBeUndefined()
    expect(r2.config.style).toBeUndefined()
    expect(r2.config.auto).toBeUndefined()
    expect(r2.config.budget.calls_per_chapter).toBeUndefined()
  }
  rmSync(dir, { recursive: true, force: true })
})

test('全局托底: 有键旧文件 roundtrip 零 diff（值不变照写）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-global2-'))
  const fp = join(dir, 'book.yaml')
  // 旧 scaffold 烘焙形态（迁移前的存量书）：13 键齐备
  const oldFile = [
    'spec_version: 1',
    '',
    'host: cc',
    'book:',
    '  title: 旧书',
    '  genre: 玄幻',
    '',
    'leads:',
    '  enabled: [设定线]',
    '',
    'budget:',
    '  calls_per_chapter: 8',
    '  input_per_chapter: 80000',
    '  summary_chapter_max: 200',
    '  summary_volume_max: 500',
    '',
    'style:',
    '  injection: light',
    '',
    'auto:',
    '  confirm_outline: false',
    '  batch_size: 8',
    '',
    'growth:',
    '  realm_span_max: 2',
    '',
  ].join('\n')
  writeFileSync(fp, oldFile, 'utf-8')

  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  // 有键旧文件：解析有值 + 重写零 diff（作者显式设置的值绝不能丢）
  expect(r.config.book.genre).toBe('玄幻')
  expect(r.config.style?.injection).toBe('light')
  expect(r.config.auto?.confirm_outline).toBe(false)
  expect(r.config.auto?.batch_size).toBe(8)
  expect(r.config.budget.calls_per_chapter).toBe(8)
  expect(stringifyBookConfig(r.config)).toBe(oldFile)
  rmSync(dir, { recursive: true, force: true })
})

test('全局托底: genre 空串归一 undefined（`genre: \'\'` 与缺失同义）', () => {
  const dir = mkdtempSync(join(tmpdir(), '北境往事-global3-'))
  const fp = join(dir, 'book.yaml')
  writeFileSync(fp, 'spec_version: 1\nbook:\n  title: 空题材\n  genre: \'\'\n', 'utf-8')
  const r = readBookConfig(fp)
  expect(r.ok).toBe(true)
  if (r.ok) {
    // 空串 = 旧默认占位 → 视为未设（否则永远盖住 global.json defaultGenre）
    expect(r.config.book.genre).toBeUndefined()
    // 写侧也不落行
    expect(stringifyBookConfig(r.config)).not.toContain('genre')
  }
  rmSync(dir, { recursive: true, force: true })
})

test('全局托底: DEFAULT_CONFIG 不再预填 13 键（未设语义的解析起点）', () => {
  expect(DEFAULT_CONFIG.book.genre).toBeUndefined()
  expect(DEFAULT_CONFIG.style).toBeUndefined()
  expect(DEFAULT_CONFIG.auto).toBeUndefined()
  expect(DEFAULT_CONFIG.budget.calls_per_chapter).toBeUndefined()
  // budget 其余三键照旧预填（不进全局托底）
  expect(DEFAULT_CONFIG.budget.input_per_chapter).toBe(80000)
  expect(DEFAULT_CONFIG.book.title).toBe('')
})

test('parseBookConfig: readBookConfig 的字符串版（坏文本返默认 + 错误）', () => {
  const r = parseBookConfig('spec_version: 1\nbook:\n  title: T\n')
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.book.title).toBe('T')
})

// ── kk-P1-5：PUT /config 文本级补丁 ──────────────

import { patchBookConfigText, setSectionKeyBlock } from '../../src/format/yaml.js'

/** 手写风格基线：注释、行尾注释、块列表、嵌套映射、未知子键、未知段俱全 */
const PATCH_BASE = [
  'spec_version: 1',
  'host: cc',
  '',
  '# 作者注释：本书定位',
  'book:',
  '  title: 旧书名',
  '  genre: 玄幻',
  '  volume_size: 40   # 行尾注释',
  '  unknown_sub: 保留我',
  '',
  'leads:',
  '  enabled:',
  '    - 悬念',
  '    - 感情线',
  '  thresholds:',
  '    悬念: 40',
  '',
  '# 未知段整段保留',
  'my_custom:',
  '  foo: bar',
  '',
  'rag:',
  '  enabled: true',
  '  endpoint: https://old.example.com',
  '  model: old-model',
  '',
  'budget:',
  '  calls_per_chapter: 8',
].join('\n') + '\n'

function parseBase(): { raw: string; cfg: ReturnType<typeof parseBookConfig>['config'] } {
  const parsed = parseBookConfig(PATCH_BASE)
  if (!parsed.ok) throw new Error('基线解析失败')
  return { raw: PATCH_BASE, cfg: parsed.config }
}

test('kk-P1-5: 改 title 只动该行——注释/未知段/未知子键/块列表逐字保留', () => {
  const { raw, cfg } = parseBase()
  const next = structuredClone(cfg)
  next.book.title = '新书名'
  const out = patchBookConfigText(raw, cfg, next)
  expect(out).toContain('  title: 新书名')
  expect(out).not.toContain('旧书名')
  // 区间外内容逐字保留
  expect(out).toContain('# 作者注释：本书定位')
  expect(out).toContain('  volume_size: 40   # 行尾注释')
  expect(out).toContain('  unknown_sub: 保留我')
  expect(out).toContain('# 未知段整段保留')
  expect(out).toContain('my_custom:')
  expect(out).toContain('  foo: bar')
  // 块列表 + 嵌套映射原排版不动
  expect(out).toContain('  enabled:')
  expect(out).toContain('    - 悬念')
  expect(out).toContain('    - 感情线')
  expect(out).toContain('    悬念: 40')
})

test('kk-P1-5: 无变化 → 原文逐字节不动（默认烘焙值不产生新行）', () => {
  const { raw, cfg } = parseBase()
  expect(patchBookConfigText(raw, cfg, structuredClone(cfg))).toBe(raw)
})

test('kk-P1-5: 改块列表值——旧 `- ` 块行整块换，无孤儿残留', () => {
  const { raw, cfg } = parseBase()
  const next = structuredClone(cfg)
  next.leads.enabled = ['布局线', '设定线']
  const out = patchBookConfigText(raw, cfg, next)
  expect(out).toContain('  enabled: [布局线, 设定线]')
  expect(out).not.toContain('- 悬念')
  expect(out).not.toContain('- 感情线')
  // thresholds 嵌套块不受连带吞并
  expect(out).toContain('  thresholds:')
  expect(out).toContain('    悬念: 40')
})

test('kk-P1-5: thresholds 嵌套映射整块换/可删', () => {
  const { raw, cfg } = parseBase()
  const next = structuredClone(cfg)
  next.leads.thresholds = { 悬念: 60, 感情线: 30 }
  const out = patchBookConfigText(raw, cfg, next)
  expect(out).toContain('  thresholds:')
  expect(out).toContain('    悬念: 60')
  expect(out).toContain('    感情线: 30')
  expect(out).not.toContain('悬念: 40')

  const next2 = structuredClone(cfg)
  next2.leads.thresholds = undefined
  const out2 = patchBookConfigText(raw, cfg, next2)
  expect(out2).not.toContain('thresholds')
  expect(out2).toContain('enabled:') // 段内其余子键不受影响
})

test('kk-P1-5: rag 切 provider → 旧内联 endpoint/model 行删除（与 stringify 同规）', () => {
  const { raw, cfg } = parseBase()
  const next = structuredClone(cfg)
  next.rag!.provider = 'mySvc'
  const out = patchBookConfigText(raw, cfg, next)
  expect(out).toContain('  provider: mySvc')
  expect(out).not.toContain('old.example.com')
  expect(out).not.toContain('old-model')
  expect(out).toContain('  enabled: true')
})

test('白名单补全: D3 双口径预算键 / summary.auto / rag.candidate_depth 落行且可回读（此前静默丢失）', () => {
  const { raw, cfg } = parseBase()
  const next = structuredClone(cfg)
  next.budget.tokens_per_chapter = 50_000
  next.budget.cost_per_chapter = 0.5
  next.summary = { auto: false }
  next.rag = { ...next.rag!, candidate_depth: 30 }
  const out = patchBookConfigText(raw, cfg, next)
  expect(out).toContain('  tokens_per_chapter: 50000')
  expect(out).toContain('  cost_per_chapter: 0.5')
  expect(out).toContain('  auto: false')
  expect(out).toContain('  candidate_depth: 30')
  // 区间外内容仍逐字保留
  expect(out).toContain('# 作者注释：本书定位')
  expect(out).toContain('my_custom:')
  // 回读：改动能被 parse 收回（配置真的生效，而非只改了文本）
  const reparsed = parseBookConfig(out)
  expect(reparsed.ok).toBe(true)
  if (reparsed.ok) {
    expect(reparsed.config.budget.tokens_per_chapter).toBe(50_000)
    expect(reparsed.config.budget.cost_per_chapter).toBe(0.5)
    expect(reparsed.config.summary?.auto).toBe(false)
    expect(reparsed.config.rag?.candidate_depth).toBe(30)
  }
  // 删键方向：candidate_depth 设回 undefined → 行被移除
  const back = structuredClone(next)
  delete back.rag!.candidate_depth
  const out2 = patchBookConfigText(out, next, back)
  expect(out2).not.toContain('candidate_depth')
})

test('kk-P1-5: 删键（genre → 空串/undefined 同效）落行为删除', () => {
  const { raw, cfg } = parseBase()
  const next = structuredClone(cfg)
  next.book.genre = '' // UI 清空题材的常见形态
  const out = patchBookConfigText(raw, cfg, next)
  expect(out).not.toContain('genre')
})

test('kk-P1-5: 缺段文件改值 → 追加只含该键的段，默认烘焙不落行', () => {
  // budget 段缺失：解析烘焙 input=80000/summary=200/500，用户只改 calls → 只补一行
  const raw = 'spec_version: 1\nbook:\n  title: 缺段书\n'
  const parsed = parseBookConfig(raw)
  if (!parsed.ok) throw new Error('解析失败')
  const next = structuredClone(parsed.config)
  next.budget.calls_per_chapter = 5
  const out = patchBookConfigText(raw, parsed.config, next)
  expect(out).toContain('budget:')
  expect(out).toContain('  calls_per_chapter: 5')
  // 烘焙默认值未变 → 不得落行（否则污染「未设=回落全局」语义）
  expect(out).not.toContain('input_per_chapter')
  expect(out).not.toContain('summary_chapter_max')
})

test('kk-P1-5: 顶层标量替换与锚定插入（host 缺失时插 spec_version 后）', () => {
  const raw = 'spec_version: 1\nbook:\n  title: 无宿主\n'
  const parsed = parseBookConfig(raw)
  if (!parsed.ok) throw new Error('解析失败')
  const next = structuredClone(parsed.config)
  next.host = 'codex'
  const out = patchBookConfigText(raw, parsed.config, next)
  expect(out.split('\n')[1]).toBe('host: codex')
})

test('kk-P1-5: 补丁后语义保全——重解析等于新配置关键值', () => {
  const { raw, cfg } = parseBase()
  const next = structuredClone(cfg)
  next.book.title = '语义书'
  next.book.volume_size = 60
  next.leads.enabled = ['成长线']
  next.rag!.provider = 'mySvc'
  next.rag!.endpoint = undefined
  next.budget.calls_per_chapter = 6
  const out = patchBookConfigText(raw, cfg, next)
  const reparsed = parseBookConfig(out)
  expect(reparsed.ok).toBe(true)
  if (reparsed.ok) {
    expect(reparsed.config.book.title).toBe('语义书')
    expect(reparsed.config.book.volume_size).toBe(60)
    expect(reparsed.config.leads.enabled).toEqual(['成长线'])
    expect(reparsed.config.rag?.provider).toBe('mySvc')
    expect(reparsed.config.rag?.endpoint).toBeUndefined()
    expect(reparsed.config.budget.calls_per_chapter).toBe(6)
    // 未知段在文本层保留（_raw 装载未实现——kk 报告勘误 6 已记录）
    expect(out).toContain('my_custom:')
  }
})

test('setSectionKeyBlock: 删除模式键不存在 → 原样返回；空段插入用 2 空格惯例', () => {
  expect(setSectionKeyBlock('book:\n  title: T\n', 'book', 'genre', null)).toBe('book:\n  title: T\n')
  expect(setSectionKeyBlock('book:\n  title: T\n', 'checks', 'imagery_words', 'imagery_words: [月]'))
    .toBe('book:\n  title: T\n\nchecks:\n  imagery_words: [月]\n')
})
