/**
 * 伏笔足迹扫描单元测试（伏笔系统整合 T10）。
 *
 * 验证：readForeshadows fm 解析、scanForeshadowTrails 足迹命中/风险计算/边界。
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readForeshadows, scanForeshadowTrails, migrateLegacyForeshadows } from '../../src/document/foreshadow.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clw-fs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一章正文（定稿/正文/第一卷/0001-标题.md） */
function writeChapter(章号: number, title: string, body: string): void {
  const dir = join(root, '定稿', '正文', '第一卷')
  mkdirSync(dir, { recursive: true })
  const name = `${String(章号).padStart(4, '0')}-${title}.md`
  writeFileSync(join(dir, name), `---\n章号: ${章号}\n标题: ${title}\n---\n${body}\n`, 'utf-8')
}

/** 造一个设定伏笔（定稿/设定/伏笔/标题.md） */
function writeForeshadow(title: string, fm: Record<string, string> = {}, body = ''): void {
  const dir = join(root, '定稿', '设定', '伏笔')
  mkdirSync(dir, { recursive: true })
  const fmLines = Object.entries({ 标题: title, ...fm }).map(([k, v]) => `${k}: ${v}`).join('\n')
  writeFileSync(join(dir, `${title}.md`), `---\n${fmLines}\n---\n${body}\n`, 'utf-8')
}

describe('readForeshadows', () => {
  test('目录不存在 → 空列表', () => {
    expect(readForeshadows(root)).toEqual([])
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
    expect(list[0]!.file).toBe('定稿/设定/伏笔/神秘玉佩.md')
  })

  test('缺字段 → 默认值', () => {
    writeForeshadow('裸伏笔')
    const list = readForeshadows(root)
    expect(list[0]!.状态).toBe('未回收')
    expect(list[0]!.重要性).toBe('中')
    expect(list[0]!.关联词).toEqual([])
    expect(list[0]!.埋设章号).toBeNull()
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
    const dir = join(root, '定稿', '正文', '第一卷')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1-埋.md'), '---\n章号: 1\n标题: 埋\n---\n线索词出现。\n', 'utf-8')

    const trails = scanForeshadowTrails(root, readForeshadows(root))
    const t = trails.get('短名线索')!
    expect(t.hits).toHaveLength(1)
    expect(t.firstHit).toBe(1)
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
})
