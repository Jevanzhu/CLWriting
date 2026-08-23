import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { loadLeadFromCache } from '../../src/cache/sync.js'
import { writeLead } from '../../src/format/leads.js'
import { writeBookConfig } from '../../src/format/yaml.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { BookConfig } from '../../src/format/types.js'

/** 造一个完整的书仓库 fixture（含 book.yaml + 账本 + 章节 + 摘要） */
function makeBookFixture(): string {
  // 用中文目录名（验证中文路径全链路）
  const root = mkdtempSync(join(tmpdir(), '北境往事-'))

  // book.yaml：启用 布局线 + 成长线（扩展类）
  const cfg: BookConfig = {
    ...DEFAULT_CONFIG,
    book: { title: '北境往事', genre: '玄幻' },
    leads: { enabled: ['成长线'], thresholds: { 成长线: 50 } },
  }
  writeBookConfig(join(root, 'book.yaml'), cfg)

  // 布线/悬念/（基础类）— 2 个条目
  const 悬念dir = join(root, '布线', '悬念')
  mkdirSync(悬念dir, { recursive: true })
  writeLead(join(悬念dir, '悬念-031-灭门真凶.md'), {
    编号: '悬念-031', 标题: '灭门真凶', 类型: '悬念', 状态: '已收尾', 开启章: 12,
    履历: [
      { 章号: 12, 动词: '埋下', 证据: '焦痕在烛火下泛着暗红' },
      { 章号: 152, 动词: '回收', 证据: '真凶是二叔' },
    ],
  })
  writeLead(join(悬念dir, '悬念-008-神秘令牌.md'), {
    编号: '悬念-008', 标题: '神秘令牌', 类型: '悬念', 状态: '进行中', 开启章: 5,
    履历: [{ 章号: 5, 动词: '埋下', 证据: '玄阶令牌' }],
  })

  // 布线/成长线/（book.yaml 启用的扩展类）— 1 个条目
  const 成长dir = join(root, '布线', '成长线')
  mkdirSync(成长dir, { recursive: true })
  writeLead(join(成长dir, '成长线-003-林晚修为.md'), {
    编号: '成长线-003', 标题: '林晚修为', 类型: '成长线', 状态: '进行中', 开启章: 3,
    当前境界: '筑基', 境界体系: '修真境界',
    履历: [
      { 章号: 3, 动词: '起步', 证据: '开脉炼气一层' },
      { 章号: 88, 动词: '跃迁', 证据: '突破至筑基' },
    ],
  })

  // 布线/布局线/（未启用 → 目录不存在，重建跳过）

  // 写作/正文/— 1 章
  const 正文dir = join(root, '写作', '正文')
  mkdirSync(正文dir, { recursive: true })
  writeFileSync(
    join(正文dir, '152-北境的雪.md'),
    '---\n章号: 152\n标题: 北境的雪\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 转折\n---\n\n北境下雪了，林晚踏雪而行。\n',
    'utf-8',
  )

  // 定稿/摘要/章摘要/— 1 条
  const 章摘要dir = join(root, '定稿', '摘要', '章摘要')
  mkdirSync(章摘要dir, { recursive: true })
  writeFileSync(join(章摘要dir, '152.md'), '林晚抵达北境，揭开灭门线索。', 'utf-8')

  return root
}

test('rebuild: 全量重建 + 数据一致（中文路径全链路）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 第一次重建
  const result = rebuild(root, cachePath)
  expect(existsSync(cachePath)).toBe(true)
  expect(result.leadCount).toBe(3) // 悬念×2 + 成长线×1
  expect(result.chapterCount).toBe(1)
  expect(result.summaryCount).toBe(1)
  expect(result.errors).toHaveLength(0)

  // 验证账本数据逐字段一致
  const db = new DatabaseSync(cachePath)
  const lead031 = loadLeadFromCache(db, '悬念-031')
  expect(lead031).not.toBeNull()
  expect(lead031!.状态).toBe('已收尾')
  expect(lead031!.履历).toHaveLength(2)
  expect(lead031!.履历[1]!.动词).toBe('回收')

  const growth = loadLeadFromCache(db, '成长线-003')
  expect(growth).not.toBeNull()
  expect(growth!.当前境界).toBe('筑基')

  // 验证章节
  const ch = db.prepare('SELECT * FROM chapters WHERE number=152').get() as Record<string, unknown>
  expect(ch['title']).toBe('北境的雪')
  expect(ch['hook_type']).toBe('悬念钩')
  expect(ch['word_count']).toBeGreaterThan(0)

  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('rebuild: 幂等（删 .cache 重建得同一结果）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 第一次重建
  const r1 = rebuild(root, cachePath)

  // 读第一次的账本数
  const db1 = new DatabaseSync(cachePath)
  const c1 = db1.prepare('SELECT count(*) AS c FROM leads').get() as { c: number }
  db1.close()

  // 删 .cache 重建
  rmSync(join(root, '.cache'), { recursive: true, force: true })
  expect(existsSync(cachePath)).toBe(false)

  const r2 = rebuild(root, cachePath)
  const db2 = new DatabaseSync(cachePath)
  const c2 = db2.prepare('SELECT count(*) AS c FROM leads').get() as { c: number }
  db2.close()

  expect(r2.leadCount).toBe(r1.leadCount)
  expect(c2.c).toBe(c1.c) // 逐字段等价

  rmSync(root, { recursive: true, force: true })
})

test('rebuild: 按 book.yaml 启用类扫描（未启用类不扫）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 在未启用的 布局线 目录放一个条目（book.yaml 只启用了 成长线）
  const 布局线dir = join(root, '布线', '布局线')
  mkdirSync(布局线dir, { recursive: true })
  writeLead(join(布局线dir, '布局线-001-暗流.md'), {
    编号: '布局线-001', 标题: '暗流', 类型: '布局线', 状态: '进行中', 开启章: 10,
    履历: [{ 章号: 10, 动词: '布局', 证据: '暗流涌动' }],
  })

  const result = rebuild(root, cachePath)
  // 布局线未启用 → 不应入库
  expect(result.leadCount).toBe(3)

  const db = new DatabaseSync(cachePath)
  const has = db.prepare('SELECT count(*) AS c FROM leads WHERE id=?').get('布局线-001') as { c: number }
  expect(has.c).toBe(0)
  db.close()

  rmSync(root, { recursive: true, force: true })
})

test('rebuild: 容错（坏文件跳过、计入 errors、不中断）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')

  // 在悬念目录加一个坏文件
  writeFileSync(join(root, '布线', '悬念', '悬念-099-坏.md'), '坏的裸文件', 'utf-8')

  const result = rebuild(root, cachePath)
  expect(result.errors.length).toBeGreaterThanOrEqual(1)
  expect(result.leadCount).toBe(3) // 坏文件跳过，其余正常

  rmSync(root, { recursive: true, force: true })
})

// ── X-P2-1：增量基准补全（mtime+count+size 三元组 / book.yaml / 大纲·关系线） ──

test('X-P2-1 增量：源未变跳过全量（行篡改留痕证明）；源变全量修复', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')
  expect(rebuild(root, cachePath).chapterCount).toBe(1)

  // 篡改一行数据（增量路径信任 meta 不动数据行——篡改留痕即证明没跑全量）
  const db = new DatabaseSync(cachePath)
  db.exec("UPDATE chapters SET title='TAMPERED'")
  db.close()
  expect(rebuild(root, cachePath).chapterCount).toBe(1)
  const db2 = new DatabaseSync(cachePath)
  const t = db2.prepare('SELECT title FROM chapters WHERE number=152').get() as { title: string }
  db2.close()
  expect(t.title).toBe('TAMPERED')

  // 源变化（章节内容改动，mtime 抬升）→ 全量重建 → 篡改被修复
  writeFileSync(
    join(root, '写作', '正文', '152-北境的雪.md'),
    '---\n章号: 152\n标题: 北境的雪改\n钩子类型: 悬念钩\n钩子强弱: 强\n情绪定位: 转折\n---\n\n北境下雪了，改动。\n',
    'utf-8',
  )
  rebuild(root, cachePath)
  const db3 = new DatabaseSync(cachePath)
  const t3 = db3.prepare('SELECT title FROM chapters WHERE number=152').get() as { title: string }
  db3.close()
  expect(t3.title).toBe('北境的雪改')

  rmSync(root, { recursive: true, force: true })
})

test('X-P2-1 删除检测：删源文件 → 基准文件数变化 → 全量（不再吃旧账）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')
  rebuild(root, cachePath)
  // 纯删除不抬 max mtime——修复前只比 mtime 会误判「源未变」→ 恒返回旧 chapterCount
  rmSync(join(root, '写作', '正文', '152-北境的雪.md'))
  const r = rebuild(root, cachePath)
  expect(r.chapterCount).toBe(0)
  rmSync(root, { recursive: true, force: true })
})

test('X-P2-1 book.yaml 入基准：启用类变更 → 全量（新启用类入库）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')
  // 预置未启用类的目录 + 条目（首次重建不入库）
  const 布局线dir = join(root, '布线', '布局线')
  mkdirSync(布局线dir, { recursive: true })
  writeLead(join(布局线dir, '布局线-001-暗流.md'), {
    编号: '布局线-001', 标题: '暗流', 类型: '布局线', 状态: '进行中', 开启章: 10,
    履历: [{ 章号: 10, 动词: '布局', 证据: '暗流涌动' }],
  })
  expect(rebuild(root, cachePath).leadCount).toBe(3)

  // 只改 book.yaml（启用 布局线）——md 源树一动不动；修复前 book.yaml 不在基准 → 增量跳过
  writeBookConfig(join(root, 'book.yaml'), {
    ...DEFAULT_CONFIG,
    book: { title: '北境往事', genre: '玄幻' },
    leads: { enabled: ['成长线', '布局线'], thresholds: { 成长线: 50 } },
  })
  expect(rebuild(root, cachePath).leadCount).toBe(4)

  rmSync(root, { recursive: true, force: true })
})

test('X-P2-1 关系线入基准：大纲/关系线 变更 → 全量（缓存状态更新）', () => {
  const root = makeBookFixture()
  // 启用 关系线（物理目录在 大纲/关系线——入库但不在旧 SOURCE_DIRS）
  writeBookConfig(join(root, 'book.yaml'), {
    ...DEFAULT_CONFIG,
    book: { title: '北境往事', genre: '玄幻' },
    leads: { enabled: ['成长线', '关系线'], thresholds: { 成长线: 50 } },
  })
  const 关系dir = join(root, '大纲', '关系线')
  mkdirSync(关系dir, { recursive: true })
  writeLead(join(关系dir, '关系线-001-师徒债.md'), {
    编号: '关系线-001', 标题: '师徒债', 类型: '关系线', 状态: '进行中', 开启章: 1,
    欠方: '林晚', 债主: '师尊',
    履历: [{ 章号: 1, 动词: '结下', 证据: '一碗罚酒' }],
  })
  const cachePath = join(root, '.cache', 'index.db')
  expect(rebuild(root, cachePath).leadCount).toBe(4)

  // 改关系线条目状态（只有 大纲/ 下的文件变了）→ 修复前增量跳过 → 缓存旧状态
  writeLead(join(关系dir, '关系线-001-师徒债.md'), {
    编号: '关系线-001', 标题: '师徒债', 类型: '关系线', 状态: '已收尾', 开启章: 1,
    欠方: '林晚', 债主: '师尊',
    履历: [
      { 章号: 1, 动词: '结下', 证据: '一碗罚酒' },
      { 章号: 90, 动词: '清算', 证据: '雪夜对账' },
    ],
  })
  rebuild(root, cachePath)
  const db = new DatabaseSync(cachePath)
  const lead = loadLeadFromCache(db, '关系线-001')
  db.close()
  expect(lead).not.toBeNull()
  expect(lead!.状态).toBe('已收尾')
  expect(lead!.履历).toHaveLength(2)

  rmSync(root, { recursive: true, force: true })
})

// ── Q-18（第十五轮）：增量基准存精确 maxMtime（非 ceil+1）──────────

test('Q-18: source_max_mtime 与源树真实最大 mtime 精确相等（接受窗不再被 ceil+1 扩大）', () => {
  const root = makeBookFixture()
  const cachePath = join(root, '.cache', 'index.db')
  rebuild(root, cachePath)
  const db = new DatabaseSync(cachePath)
  const row = db.prepare("SELECT value FROM meta WHERE key='source_max_mtime'").get() as { value: string }
  db.close()
  // 复刻 walkSourceStats 的源集（book.yaml + 布线/写作/定稿/大纲·关系线 下的 .md）
  let maxMtime = 0
  const bump = (fp: string): void => {
    try {
      const st = statSync(fp)
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs
    } catch { /* 同 walkSourceStats 容错 */ }
  }
  bump(join(root, 'book.yaml'))
  const stack = ['布线', '写作', '定稿', join('大纲', '关系线')].map((d) => join(root, d)).filter((d) => existsSync(d))
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('._')) continue
      if (e.isDirectory()) stack.push(join(dir, e.name))
      else if (e.isFile() && e.name.endsWith('.md')) bump(join(dir, e.name))
    }
  }
  // 修复前 Math.ceil(maxMtime)+1：亚毫秒 mtime 被抬到下一整秒 +1ms（最长近 2ms 假接受窗）
  expect(Number(row.value)).toBe(maxMtime)
  rmSync(root, { recursive: true, force: true })
})
