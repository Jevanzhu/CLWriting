/**
 * 伏笔足迹扫描单元测试（伏笔系统整合 T10）。
 *
 * 验证：readForeshadows fm 解析、scanForeshadowTrails 足迹命中/风险计算/边界。
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readForeshadows, scanForeshadowTrails, migrateLegacyForeshadows, searchForeshadowTrails } from '../../src/document/foreshadow.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-fs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一章正文（写作/正文/第一卷/0001-标题.md） */
function writeChapter(章号: number, title: string, body: string): void {
  const dir = join(root, '写作', '正文', '第一卷')
  mkdirSync(dir, { recursive: true })
  const name = `${String(章号).padStart(4, '0')}-${title}.md`
  writeFileSync(join(dir, name), `---\n章号: ${章号}\n标题: ${title}\n---\n${body}\n`, 'utf-8')
}

/** 造一个设定伏笔（设定/伏笔/标题.md） */
function writeForeshadow(title: string, fm: Record<string, string> = {}, body = ''): void {
  const dir = join(root, '设定', '伏笔')
  mkdirSync(dir, { recursive: true })
  const fmLines = Object.entries({ 标题: title, ...fm }).map(([k, v]) => `${k}: ${v}`).join('\n')
  writeFileSync(join(dir, `${title}.md`), `---\n${fmLines}\n---\n${body}\n`, 'utf-8')
}

describe('readForeshadows', () => {
  test('目录不存在 → 空列表', () => {
    expect(readForeshadows(root)).toEqual([])
  })

  // B-4（第六十轮）：walkChapters 接入 walk-md 共享口径（N2 漏网第四套）——
  // 裸 statSync 跟随 symlink 递归无剪枝：循环 symlink 无限递归 RangeError、
  // 指向书外的 symlink 整树 .md 按章号整读
  test('B-4: 循环 symlink 不崩溃；书外 symlink 目录整树不进章收集', () => {
    writeForeshadow('玉佩', { 重要性: '高', 关联词: '玉佩', 埋设章号: '1' })
    writeChapter(1, '埋', '他摸了摸胸前的玉佩。')
    // 循环 symlink：正文/loop → 正文（修复前 RangeError 崩进门）
    symlinkSync(join(root, '写作', '正文'), join(root, '写作', '正文', 'loop'))
    // 书外 symlink：外部目录带含命中词的章（不应被读——根界 fail-closed）
    const outside = mkdtempSync(join(tmpdir(), 'clw-fs-out-'))
    writeFileSync(join(outside, '0002-外章.md'), '---\n章号: 2\n标题: 外\n---\n书外的玉佩\n', 'utf-8')
    symlinkSync(outside, join(root, '写作', '正文', '外链'))

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('玉佩')!
    expect(t.firstHit).toBe(1)
    expect(t.lastHit).toBe(1) // 书外章（含命中词）不进收集
    rmSync(outside, { recursive: true, force: true })
  })

  test('解析 fm 含关联词（逗号分隔 → 数组）', () => {
    writeForeshadow('神秘玉佩', {
      状态: '未回收',
      重要性: '高',
      关联词: '玉佩,祖父遗物,那块玉',
      埋设章号: '3',
    })
    const list = readForeshadows(root)
    expect(list).toHaveLength(1)
    expect(list[0]!.标题).toBe('神秘玉佩')
    expect(list[0]!.关联词).toEqual(['玉佩', '祖父遗物', '那块玉'])
    expect(list[0]!.状态).toBe('未回收')
    expect(list[0]!.重要性).toBe('高')
    expect(list[0]!.埋设章号).toBe(3)
    expect(list[0]!.file).toBe('设定/伏笔/神秘玉佩.md')
  })

  test('缺字段 → 默认值', () => {
    writeForeshadow('裸伏笔')
    const list = readForeshadows(root)
    expect(list[0]!.状态).toBe('未回收')
    expect(list[0]!.重要性).toBe('中')
    expect(list[0]!.关联词).toEqual([])
    expect(list[0]!.埋设章号).toBeNull()
  })

  test('X-P2-19: 关联词中文逗号也切分（整串不成一个词）', () => {
    writeForeshadow('双逗号伏笔', { 关联词: '佩剑，玉佩, 剑穗，' })
    const list = readForeshadows(root)
    expect(list[0]!.关联词).toEqual(['佩剑', '玉佩', '剑穗'])
  })
})

describe('scanForeshadowTrails', () => {
  test('关联词命中正文 → 足迹正确（firstHit/lastHit/命中词）', () => {
    writeForeshadow('神秘玉佩', { 重要性: '高', 关联词: '玉佩,祖父遗物', 埋设章号: '3' })
    writeChapter(3, '埋设', '他摸了摸胸前的玉佩，那是祖父遗物。')
    writeChapter(10, '推进', '玉佩微微发热。')
    writeChapter(50, '最近', '剧情继续，不提那个物件。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('神秘玉佩')!
    // ch3: 玉佩+祖父遗物(2), ch10: 玉佩(1) = 3 hits
    expect(t.hits).toHaveLength(3)
    expect(t.firstHit).toBe(3)
    expect(t.lastHit).toBe(10)
    expect(t.hits[0]!.命中词).toBe('玉佩')
    expect(t.hits[0]!.命中片段).toContain('玉佩')
  })

  test('P-4（第十四轮）: 同前缀长短词并存 → 长词有独立足迹（交替左优先遮蔽修复）', () => {
    // 插入序让短词先进 Set（「玉佩」在「玉佩锁」前）——修复前联合正则左优先
    // 使「玉佩锁」三字永不独立命中，其足迹/风险评级漏检
    writeForeshadow('玉佩线', { 重要性: '高', 关联词: '玉佩', 埋设章号: '1' })
    writeForeshadow('玉佩锁线', { 重要性: '高', 关联词: '玉佩锁', 埋设章号: '1' })
    writeChapter(1, '埋', '他戴上玉佩，锁好门。又看了一眼那把玉佩锁。')
    writeChapter(40, '远', '岁月流逝。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const long = trails.get('玉佩锁线')!
    const hit = long.hits.find((h) => h.命中词 === '玉佩锁')
    expect(hit, '「玉佩锁」应有独立命中（不被「玉佩」遮蔽）').toBeDefined()
    expect(hit!.命中片段).toContain('玉佩锁')
    // 短词足迹不受影响
    expect(trails.get('玉佩线')!.hits.some((h) => h.命中词 === '玉佩')).toBe(true)
  })

  test('无命中 → firstHit/lastHit 回退 fm 埋设章号', () => {
    writeForeshadow('预言', { 重要性: '中', 埋设章号: '5' })
    writeChapter(5, '测试', '这里完全没有关联词。')
    writeChapter(20, '远', '也没有。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('预言')!
    expect(t.hits).toHaveLength(0)
    expect(t.firstHit).toBe(5)
    expect(t.lastHit).toBe(5)
    expect(t.staleSpan).toBe(15) // 20 - 5
  })

  test('高重要性 + 悬置 >30 章 → 红', () => {
    writeForeshadow('核心谜团', { 重要性: '高', 关联词: '谜团', 埋设章号: '1' })
    writeChapter(1, '埋', '谜团开始了。')
    writeChapter(35, '远', '剧情发展。') // lastHit=1, staleSpan=34 > 30

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    expect(trails.get('核心谜团')!.risk).toBe('红')
  })

  test('中重要性 + 悬置 45 章 → 黄（阈值 60，70%=42）', () => {
    writeForeshadow('中线', { 重要性: '中', 关联词: '中线词', 埋设章号: '1' })
    writeChapter(1, '埋', '中线词出现。')
    writeChapter(46, '远', '剧情。') // staleSpan=45, >42 但 <60 → 黄

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    expect(trails.get('中线')!.risk).toBe('黄')
  })

  test('低悬置 → 绿', () => {
    writeForeshadow('新鲜线', { 重要性: '高', 关联词: '新鲜', 埋设章号: '1' })
    writeChapter(1, '埋', '新鲜的线索。')
    writeChapter(5, '近', '新鲜又被提到。') // staleSpan=0

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    expect(trails.get('新鲜线')!.risk).toBe('绿')
  })

  test('已回收 → 风险恒绿，跳过扫描', () => {
    writeForeshadow('已解之谜', { 状态: '已回收', 重要性: '高', 埋设章号: '1', 回收章号: '10' })
    writeChapter(1, '埋', '已解之谜开始。')
    writeChapter(100, '远', '很久以后。') // 如果扫描了 staleSpan 会很大

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('已解之谜')!
    expect(t.risk).toBe('绿')
    expect(t.hits).toHaveLength(0)
    expect(t.staleSpan).toBe(0)
  })

  test('无关联词 → 用标题搜索', () => {
    writeForeshadow('特殊标记', { 重要性: '低' })
    writeChapter(1, '埋', '他看到一个特殊标记。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('特殊标记')!
    expect(t.hits).toHaveLength(1)
    expect(t.firstHit).toBe(1)
    expect(t.hits[0]!.命中词).toBe('特殊标记')
  })

  test('不补零文件名（1-埋.md）也能扫到足迹（曾因 3-4 位限制漏扫）', () => {
    writeForeshadow('短名线索', { 重要性: '中', 关联词: '线索词', 埋设章号: '1' })
    // 直接写不补零文件名（writeChapter helper 会补 4 位零）
    const dir = join(root, '写作', '正文', '第一卷')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1-埋.md'), '---\n章号: 1\n标题: 埋\n---\n线索词出现。\n', 'utf-8')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('短名线索')!
    expect(t.hits).toHaveLength(1)
    expect(t.firstHit).toBe(1)
  })

  test('关键词含正则元字符（括号/点）也能命中（转义防御）', () => {
    writeForeshadow('带符号', { 重要性: '中', 关联词: '祖父遗物（上）', 埋设章号: '1' })
    writeChapter(1, '埋', '他拿出祖父遗物（上）。')
    writeChapter(2, '续', '继续。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('带符号')!
    expect(t.hits).toHaveLength(1)
    expect(t.firstHit).toBe(1)
    expect(t.hits[0]!.命中片段).toContain('祖父遗物（上）')
  })

  test('同章多次命中同一关键词 → 全部记录（位置索引完整性）', () => {
    writeForeshadow('多次', { 重要性: '中', 关联词: '玉佩', 埋设章号: '1' })
    writeChapter(1, '埋', '玉佩在桌上，玉佩在手上。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('多次')!
    expect(t.hits).toHaveLength(2)
    expect(t.hits.map((h) => h.命中片段)).toEqual([
      expect.stringContaining('玉佩在桌上'),
      expect.stringContaining('玉佩在手上'),
    ])
  })

  test('P2-BE-4 性能：250 章 × 30 伏笔 × 5 关联词 < 500ms（倒排索引）', () => {
    // 造 250 章，每章 ~2KB 正文（含 5 个真实命中词各 1 次）
    const dir = join(root, '写作', '正文', '第一卷')
    mkdirSync(dir, { recursive: true })
    const filler = '普通叙述内容。'.repeat(80) // ~500 字
    for (let ch = 1; ch <= 250; ch++) {
      const hits = Array.from({ length: 30 }, (_, i) => `占位词${i}-${ch % 5}`).join(' ')
      writeChapter(ch, `章${ch}`, `${filler}${hits}${filler}`)
    }
    // 30 个伏笔，每个 5 个关联词（占位词{i}-0..4，每章全命中）
    for (let i = 0; i < 30; i++) {
      writeForeshadow(`伏笔${i}`, {
        重要性: '中',
        关联词: Array.from({ length: 5 }, (_, k) => `占位词${i}-${k}`).join(','),
        埋设章号: '1',
      })
    }
    // 预热 + 首次调用含读文件，不计入性能断言（性能测的是扫描本身）
    scanForeshadowTrails(root, readForeshadows(root))
    const start = performance.now()
    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const dt = performance.now() - start
    // CI 宽松阈值 < 500ms，本地通常 < 100ms
    expect(dt).toBeLessThan(500)
    expect(trails.size).toBe(30)
    // 每伏笔应命中（每章 5 词之一）
    expect(trails.get('伏笔0')!.hits.length).toBeGreaterThan(0)
  })
})

describe('migrateLegacyForeshadows', () => {
  test('无旧目录 → no-op', () => {
    const r = migrateLegacyForeshadows(root)
    expect(r.migrated).toBe(0)
    expect(r.details).toEqual([])
  })

  test('旧伏笔迁移 + 删旧 + 新文件正确', () => {
    const oldDir = join(root, '大纲', '伏笔')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(
      join(oldDir, '伏笔-031-灭门真凶.md'),
      '---\n编号: 伏笔-031\n标题: 灭门真凶\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n',
      'utf-8',
    )

    const r = migrateLegacyForeshadows(root)
    expect(r.migrated).toBe(1)
    expect(r.details[0]).toContain('灭门真凶')
    // 旧文件已删
    expect(existsSync(join(oldDir, '伏笔-031-灭门真凶.md'))).toBe(false)
    // 新文件字段正确
    const list = readForeshadows(root)
    expect(list).toHaveLength(1)
    expect(list[0]!.标题).toBe('灭门真凶')
    expect(list[0]!.状态).toBe('未回收') // 进行中 → 未回收
    expect(list[0]!.埋设章号).toBe(1)
    expect(list[0]!.关联词).toEqual(['灭门真凶'])
  })

  test('幂等：二次调用 no-op（旧文件已删）', () => {
    const oldDir = join(root, '大纲', '伏笔')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(
      join(oldDir, '伏笔-031-灭门真凶.md'),
      '---\n编号: 伏笔-031\n标题: 灭门真凶\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：焦痕\n',
      'utf-8',
    )
    migrateLegacyForeshadows(root)
    const r2 = migrateLegacyForeshadows(root)
    expect(r2.migrated).toBe(0)
  })

  // N3 回归：同名标题伏笔迁移时文件名带编号兜底，防互相覆盖丢数据
  test('同名标题伏笔不覆盖（编号兜底文件名）', () => {
    const oldDir = join(root, '大纲', '伏笔')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(
      join(oldDir, '伏笔-031-密室.md'),
      '---\n编号: 伏笔-031\n标题: 密室\n类型: 伏笔\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n\n- 第001章 埋下：锁\n',
      'utf-8',
    )
    writeFileSync(
      join(oldDir, '伏笔-052-密室.md'),
      '---\n编号: 伏笔-052\n标题: 密室\n类型: 伏笔\n状态: 进行中\n开启章: 5\n---\n\n## 履历\n\n- 第005章 埋下：钥匙\n',
      'utf-8',
    )

    const r = migrateLegacyForeshadows(root)
    expect(r.migrated).toBe(2)
    // 两条都迁出来了，没有互相覆盖
    const list = readForeshadows(root)
    expect(list).toHaveLength(2)
    expect(list.map((e) => e.埋设章号).sort()).toEqual([1, 5])
  })
})

// 低-5（第十轮）：同标题伏笔 trail 以标题为 Map key 互相覆盖——同名两条只留后一条
// 的足迹（文件本身不撞：迁移链 N3 已给文件名带编号兜底，撞的是 fm 标题）。
// 合并语义：命中取并集、首末取极值、风险取最坏（fail-closed）；key 仍用标题，
// 保住存量读方（prepare 伏笔提醒 / studio foreshadows 端点的 get(标题)）不换形状
describe('低-5（第十轮）：同标题伏笔 trail 不互相覆盖', () => {
  /** 直接写指定文件名（fm 标题相同、文件名带编号——迁移链产出的同名形态） */
  function writeNamedForeshadow(file: string, fm: Record<string, string>): void {
    const dir = join(root, '设定', '伏笔')
    mkdirSync(dir, { recursive: true })
    const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')
    writeFileSync(join(dir, file), `---\n${fmLines}\n---\n`, 'utf-8')
  }

  test('同标题两条伏笔足迹都在（合并保留，互不覆盖）', () => {
    writeNamedForeshadow('伏笔-031-密室.md', { 标题: '密室', 重要性: '高', 关联词: '铜锁', 埋设章号: '1' })
    writeNamedForeshadow('伏笔-052-密室.md', { 标题: '密室', 重要性: '中', 关联词: '钥匙', 埋设章号: '5' })
    writeChapter(1, '埋', '门上的铜锁泛着绿光。')
    writeChapter(5, '启', '她摸出了那把钥匙。')
    writeChapter(50, '远', '剧情推进。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('密室')!
    // 两条的命中都在（覆盖形态下只剩后一条的「钥匙」）
    expect(t.hits.map((h) => h.命中词).sort()).toEqual(['钥匙', '铜锁'])
    expect(t.firstHit).toBe(1) // 031 的埋设点
    expect(t.lastHit).toBe(5) // 052 的末次提及
    // 风险取最坏：031（高，悬置 49 章 → 红）不被 052（中，悬置 45 章 → 黄）盖成黄
    expect(t.risk).toBe('红')
  })

  test('存量读侧兼容：单标题 key（get(标题)）照常可读，map 大小 = 唯一标题数', () => {
    writeNamedForeshadow('伏笔-031-密室.md', { 标题: '密室', 重要性: '高', 关联词: '铜锁', 埋设章号: '1' })
    writeNamedForeshadow('伏笔-052-密室.md', { 标题: '密室', 重要性: '中', 关联词: '钥匙', 埋设章号: '5' })
    writeForeshadow('唯一线', { 重要性: '低', 关联词: '唯一词', 埋设章号: '2' })
    writeChapter(1, '一', '铜锁出现。')
    writeChapter(2, '二', '唯一词出现。')
    writeChapter(5, '五', '钥匙出现。')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    // 旧读法（prepare/studio 的 get(标题)）对同标题与唯一标题都能取到
    expect(trails.get('密室')).toBeTruthy()
    expect(trails.get('唯一线')!.firstHit).toBe(2)
    expect(trails.size).toBe(2) // 唯一标题数：不加复合 key、不因合并丢条目
    // 检索路径同读法：同标题两条都带足迹出现在结果里，且各带的是合并足迹（两条都在）
    const hits = searchForeshadowTrails(root, '密室')
    expect(hits).toHaveLength(2)
    expect(hits.every((h) => h.足迹.hits.length === 2)).toBe(true)
  })
})

describe('searchForeshadowTrails（F1-P3 伏笔足迹 FTS 检索）', () => {
  test('按标题 / 关联词 / 命中片段检索，返回足迹（哪章埋了哪章收了）', () => {
    writeForeshadow('古剑', { 重要性: '高', 关联词: '锈剑', 埋设章号: '2' })
    writeForeshadow('玉佩', { 重要性: '中', 关联词: '玉佩', 埋设章号: '1' })
    writeChapter(1, '开', '他拾起玉佩。')
    writeChapter(2, '中', '锈剑出鞘。')
    writeChapter(8, '后', '剧情推进。')

    // 标题检索
    const byTitle = searchForeshadowTrails(root, '古剑')
    expect(byTitle.map((h) => h.标题)).toEqual(['古剑'])
    expect(byTitle[0]!.足迹.firstHit).toBe(2)
    // 关联词检索
    const byKw = searchForeshadowTrails(root, '玉佩')
    expect(byKw.map((h) => h.标题)).toContain('玉佩')
    // 命中片段检索（正文里的词）
    const bySnippet = searchForeshadowTrails(root, '锈剑')
    expect(bySnippet.map((h) => h.标题)).toContain('古剑')
    expect(bySnippet[0]!.足迹.hits[0]!.章号).toBe(2)
    // 空 query → 全量
    expect(searchForeshadowTrails(root)).toHaveLength(2)
    // 无匹配 → 空
    expect(searchForeshadowTrails(root, '不存在词xyz')).toHaveLength(0)
  })

  test('按末次命中降序（最近提及在前）', () => {
    writeForeshadow('早线', { 重要性: '中', 关联词: '早词', 埋设章号: '1' })
    writeForeshadow('晚线', { 重要性: '中', 关联词: '晚词', 埋设章号: '3' })
    writeChapter(1, '一', '早词出现。')
    writeChapter(3, '三', '晚词出现。')
    writeChapter(10, '十', '晚词再提。')

    const all = searchForeshadowTrails(root)
    expect(all.map((h) => h.标题)).toEqual(['晚线', '早线']) // lastHit 10 > 1
  })
})
