/**
 * 低级项（第六轮）管线层回归集合：
 * - 预算裁剪整段移除后 injectedSummaryFiles 同步回收（不虚报注入面）
 * - assembleStatus currentChapter 只数定稿章（缓存 chapters 表含写作中的草稿）
 * - book.yaml rag 段缺 enabled 键不再整段静默丢弃（缺省 true）
 * - YAML 块列表项含冒号不再被误判 key 行静默吞
 * - 样章库 readdir 显式排序（跨平台注入可复现）
 * - book_search 递归不跟随越出 bookRoot 的 symlink
 */
import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAllTables } from '../../src/cache/schema.js'
import { syncChapter, syncSummary } from '../../src/cache/sync.js'
import { prepare } from '../../src/process/prepare.js'
import { assembleStatus } from '../../src/process/assemble.js'
import { readBookConfig, writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { readSamplesByScene } from '../../src/format/style.js'
import { searchBook } from '../../src/process/book-search.js'
import type { BookConfig } from '../../src/format/types.js'

// R70-31（十八轮）：symlink 能力探测——此前两用例 try-catch 早退「跳过」，其后的
// 全部断言静默不执行照绿（非特权 Windows 零验证）；改 skipIf 对齐库内 49 处守卫惯例
const canSymlink = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'clw-symlink-probe-'))
    symlinkSync(join(dir, 'a'), join(dir, 'b'))
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
})()


function makeBookWithMaterial(): { root: string; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), 'pipe-low-'))
  writeBookConfig(join(root, 'book.yaml'), DEFAULT_CONFIG)
  const dbPath = join(root, '.cache', 'index.db')
  mkdirSync(join(root, '.cache'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  createAllTables(db)
  syncChapter(db, {
    章号: 150, 标题: '前章', 钩子类型: '悬念钩', 钩子强弱: '强',
    情绪定位: '铺垫', _wordCount: 3000, _path: 'p150',
  })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '## 反和解\n禁止强行和解', 'utf-8')
  mkdirSync(join(root, '文风', '样章库', '战斗'), { recursive: true })
  writeFileSync(join(root, '文风', '样章库', '战斗', '战斗-001.md'),
    '---\n场景: 战斗\n来源: 作者原作\n---\n刀光没入雪雾。', 'utf-8')
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  writeFileSync(join(root, '定稿', '摘要', '章摘要', '150.md'), '前章内容回顾。', 'utf-8')
  syncSummary(db, 'chapter', 150, join(root, '定稿', '摘要', '章摘要', '150.md'))
  // 卷摘要（volume_size=100 → 第 150 章在第 2 卷，注入第 1 卷摘要）
  mkdirSync(join(root, '定稿', '摘要', '卷摘要'), { recursive: true })
  writeFileSync(join(root, '定稿', '摘要', '卷摘要', '1.md'), '第一卷收束。', 'utf-8')
  return { root, db }
}

test('低级项（第六轮）：预算裁剪整段移除后 injectedSummaryFiles 同步回收', () => {
  // 正常预算：近章结尾 + 卷摘要都在 → visible 清单含两个文件
  const a = makeBookWithMaterial()
  try {
    const cfg: BookConfig = { ...DEFAULT_CONFIG, book: { ...DEFAULT_CONFIG.book, volume_size: 100 } }
    const r1 = prepare(a.db, cfg, a.root, [])
    expect(r1.injectedSummaryFiles).toContain('定稿/摘要/章摘要/150.md')
    expect(r1.injectedSummaryFiles).toContain('定稿/摘要/卷摘要/1.md')

    // 极小预算：弹性段全被整段移除 → 注入面清单同步清空（原先虚报）
    const tiny: BookConfig = {
      ...cfg,
      budget: { ...cfg.budget, input_per_chapter: 1 },
    }
    const r2 = prepare(a.db, tiny, a.root, [])
    expect(r2.trimmed).toBe(true)
    expect(r2.injectedSummaryFiles).toEqual([])
    // 段确实被移除了（不是清单单方面缩水）
    expect(r2.sections.map((s) => s.title)).not.toContain('近章结尾')
    expect(r2.sections.map((s) => s.title)).not.toContain('第1卷摘要')
  } finally {
    a.db.close()
    rmSync(a.root, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：assembleStatus 传入定稿集 → currentChapter 只数定稿章', () => {
  const root = mkdtempSync(join(tmpdir(), 'assemble-fin-'))
  try {
    const dbPath = join(root, '.cache', 'index.db')
    mkdirSync(join(root, '.cache'), { recursive: true })
    const db = new DatabaseSync(dbPath)
    createAllTables(db)
    // 1、2 已定稿；3 是写作中的草稿（写稿即入缓存 chapters 表）
    for (const n of [1, 2, 3]) {
      syncChapter(db, {
        章号: n, 标题: `第${n}章`, 钩子类型: '悬念钩', 钩子强弱: '强',
        情绪定位: '铺垫', _wordCount: 100, _path: `p${n}`,
      })
    }
    expect(assembleStatus(db, DEFAULT_CONFIG, 50, new Set([1, 2])).currentChapter).toBe(2)
    // PL-2（第七轮）：空集 = 清单在册零定稿（新书）→ 0，不再回落含草稿全量；
    // 缺省（undefined，无清单旧书/旧夹具）→ 维持全量口径
    expect(assembleStatus(db, DEFAULT_CONFIG, 50, new Set()).currentChapter).toBe(0)
    expect(assembleStatus(db, DEFAULT_CONFIG, 50).currentChapter).toBe(3)
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：book.yaml rag 段缺 enabled 键 → 不整段丢弃，缺省启用', () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-rag-'))
  try {
    const fp = join(root, 'book.yaml')
    writeFileSync(fp, [
      'spec_version: 1',
      'kind: long',
      'book:',
      '  title: 测试书',
      'rag:',
      '  provider: milvus',
      '  endpoint: http://127.0.0.1:19530',
      '  model: bge-m3',
    ].join('\n'), 'utf-8')
    const r = readBookConfig(fp)
    expect(r.ok).toBe(true)
    expect(r.config.rag).toBeDefined()
    expect(r.config.rag?.enabled).toBe(true)
    expect(r.config.rag?.provider).toBe('milvus')

    // 显式 enabled: false 才关
    writeFileSync(fp, [
      'spec_version: 1',
      'kind: long',
      'book:',
      '  title: 测试书',
      'rag:',
      '  enabled: false',
      '  provider: milvus',
    ].join('\n'), 'utf-8')
    const r2 = readBookConfig(fp)
    expect(r2.ok).toBe(true)
    expect(r2.config.rag?.enabled).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：YAML 块列表项含冒号 → 按列表项文本解析，不再静默吞', () => {
  const root = mkdtempSync(join(tmpdir(), 'yaml-list-'))
  try {
    const fp = join(root, 'book.yaml')
    writeFileSync(fp, [
      'spec_version: 1',
      'kind: short',
      'book:',
      '  title: 短篇集',
      'short:',
      '  target_emotions:',
      '    - 惊悚: 高',
      '    - 悬疑',
    ].join('\n'), 'utf-8')
    const r = readBookConfig(fp)
    expect(r.ok).toBe(true)
    expect(r.config.short?.target_emotions).toContain('惊悚: 高')
    expect(r.config.short?.target_emotions).toContain('悬疑')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：样章库读取按文件名排序（跨平台注入可复现）', () => {
  const root = mkdtempSync(join(tmpdir(), 'sample-sort-'))
  try {
    const sceneDir = join(root, '文风', '样章库', '战斗')
    mkdirSync(sceneDir, { recursive: true })
    // 先写 002 再写 001——断言结果与 readdir 返回顺序无关
    writeFileSync(join(sceneDir, '战斗-002.md'), '---\n场景: 战斗\n来源: 作者原作\n---\n第二章样章。', 'utf-8')
    writeFileSync(join(sceneDir, '战斗-001.md'), '---\n场景: 战斗\n来源: 作者原作\n---\n第一章样章。', 'utf-8')
    const { samples } = readSamplesByScene(join(root, '文风', '样章库'), '战斗')
    expect(samples).toHaveLength(2)
    expect(samples[0]!.正文).toBe('第一章样章。')
    expect(samples[1]!.正文).toBe('第二章样章。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('低级项（第六轮）：book_search 不跟随越出 bookRoot 的 symlink（目录与文件）', () => {
  const root = mkdtempSync(join(tmpdir(), 'search-symlink-'))
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  try {
    const bodyDir = join(root, '写作', '正文')
    mkdirSync(bodyDir, { recursive: true })
    writeFileSync(join(bodyDir, '0001-在内.md'), '内部命中 needle', 'utf-8')

    // 书外目录 + 书外文件（均含同一关键词）
    mkdirSync(join(outside, 'dir'), { recursive: true })
    writeFileSync(join(outside, 'dir', 'secret.md'), '外部机密 needle', 'utf-8')
    writeFileSync(join(outside, 'secret.md'), '外部机密文件 needle', 'utf-8')

    symlinkSync(join(outside, 'dir'), join(bodyDir, '外链目录'))
    symlinkSync(join(outside, 'secret.md'), join(bodyDir, '0002-外链.md'))

    const out = searchBook(root, 'needle', 'all')
    const paths = out.results.map((h) => h.path)
    expect(paths).toEqual(['写作/正文/0001-在内.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test.skipIf(!canSymlink)('P5-管线（第七轮）：书内 symlink 环（a→b→a）不再无限递归（visited 剪枝）', () => {
  const root = mkdtempSync(join(tmpdir(), 'search-cycle-'))
  try {
    const bodyDir = join(root, '写作', '正文')
    mkdirSync(join(bodyDir, 'a'), { recursive: true })
    mkdirSync(join(bodyDir, 'b'), { recursive: true })
    writeFileSync(join(bodyDir, 'a', '0001-环内.md'), '环内命中 needle', 'utf-8')
    // 环完全在书内：isWithinRoot 拦不住，修复前 walkMd 无限递归直至栈溢出（RangeError）
    symlinkSync(join(bodyDir, 'a'), join(bodyDir, 'b', 'back-a'))
    symlinkSync(join(bodyDir, 'b'), join(bodyDir, 'a', 'back-b'))
    const out = searchBook(root, 'needle', 'all')
    expect(out.results.map((h) => h.path)).toContain('写作/正文/a/0001-环内.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
