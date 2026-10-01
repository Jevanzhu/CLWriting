/**
 * 章纲定位三口径单源（format/piece-list-locate.ts）回归。
 *
 * 收敛前 check/runner 走三口径（同名 basename → fm 章号 → 文件名数字前缀），
 * metrics/short-index 只走同名 basename——同一书形下机检清单形式检与短篇集指标对同一
 * 章一方命中一方 miss（红点与画像口径分裂）。本测试同时钉死「单源三口径可达」与
 * 「short-index 经单源也吃到口径②③」两面。
 */
import { test, expect, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locateChapterOutline } from '../../src/format/piece-list-locate.js'
import { scanShortCollection } from '../../src/metrics/short-index.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function mkRoot(): string {
  return mkdtempTracked(join(tmpdir(), 'pll-'))
}

test('口径①：与正文同名 basename 命中', () => {
  const root = mkRoot()
  try {
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '章纲', '0005-雪夜.md'), '## 反转线索表\n', 'utf-8')
    const r = locateChapterOutline(root, join(root, '写作', '正文', '0005-雪夜.md'), 5)
    expect(r.kind).toBe('found')
    expect(r.kind === 'found' && r.path.endsWith('0005-雪夜.md')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('口径②：不同名但 fm 章号一致 → 按章号命中（补零重命名书形）', () => {
  const root = mkRoot()
  try {
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '章纲', '第五章-雪夜.md'), '---\n章号: 5\n---\n\n## 反转线索表\n', 'utf-8')
    const r = locateChapterOutline(root, join(root, '写作', '正文', '0005-雪夜.md'), 5)
    expect(r.kind).toBe('found')
    expect(r.kind === 'found' && r.path.endsWith('第五章-雪夜.md')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('口径③：无 fm 章号、3 位补零文件名 → 按数字前缀命中', () => {
  const root = mkRoot()
  try {
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '章纲', '005-雪夜.md'), '## 反转线索表\n', 'utf-8')
    const r = locateChapterOutline(root, join(root, '写作', '正文', '0005-雪夜.md'), 5)
    expect(r.kind).toBe('found')
    expect(r.kind === 'found' && r.path.endsWith('005-雪夜.md')).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('三口径皆空（目录在）→ missing；目录不在 → missing', () => {
  const root = mkRoot()
  try {
    expect(locateChapterOutline(root, join(root, '写作', '正文', '0005-雪夜.md'), 5).kind).toBe('missing')
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '章纲', '006-别章.md'), 'x', 'utf-8')
    expect(locateChapterOutline(root, join(root, '写作', '正文', '0005-雪夜.md'), 5).kind).toBe('missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('short-index 经单源吃到口径②：不同名 fm 章号一致的章纲计入结构物件', () => {
  const root = mkRoot()
  try {
    const bodyDir = join(root, '写作', '正文', '第一卷')
    mkdirSync(bodyDir, { recursive: true })
    writeFileSync(
      join(bodyDir, '0005-雪夜.md'),
      '---\n章号: 5\n标题: 雪夜\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 压抑\n---\n\n正文。\n',
      'utf-8',
    )
    mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
    // 与正文 basename 完全不同名，仅 fm 章号可配对（收敛前 short-index 只认同名，此处必 miss）
    writeFileSync(
      join(root, '大纲', '章纲', '第五章-雪夜.md'),
      '---\n章号: 5\n---\n\n## 反转线索表\n- 核心反转：来客即凶手\n- 铺垫点（≥3，反转可回溯）：\n  - [开头] 雪夜敲门\n  - [中段] 焦痕\n  - [结尾] 旧画像\n\n## 伏笔回收\n- 旧画像 → 回收于 结尾认亲\n',
      'utf-8',
    )
    const entries = scanShortCollection(root)
    expect(entries.map((e) => e.num)).toEqual([5])
    // 单源三口径命中后，结构物件不再为空（miss 时会落 collectStructureObjects(null) = []）
    expect(entries[0]!.structureObjects.length).toBeGreaterThan(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('短篇/机检同源：short-index 目录不可读时 warn 留痕（不静默）', () => {
  const warnSpy = vi.spyOn(log, 'warn')
  const root = mkRoot()
  try {
    const bodyDir = join(root, '写作', '正文', '第一卷')
    mkdirSync(bodyDir, { recursive: true })
    writeFileSync(
      join(bodyDir, '0005-雪夜.md'),
      '---\n章号: 5\n标题: 雪夜\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 压抑\n---\n\n正文。\n',
      'utf-8',
    )
    // 章纲目录被文件占位：existsSync 真、readdirSync ENOTDIR → dir-unreadable
    mkdirSync(join(root, '大纲'), { recursive: true })
    writeFileSync(join(root, '大纲', '章纲'), 'not-a-dir', 'utf-8')
    const entries = scanShortCollection(root)
    expect(entries.map((e) => e.num)).toEqual([5]) // 降级不阻断：条目照常产出
    const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
    expect(warned).toContain('短篇章纲目录读取失败')
  } finally {
    warnSpy.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
