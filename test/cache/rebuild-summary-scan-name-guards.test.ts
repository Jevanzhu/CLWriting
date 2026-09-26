/**
 * rebuild 摘要扫描（scanSummaries）的文件分类与留痕守卫族：哪些文件算摘要、
 * 哪些命名入表、被跳过的条目如何留痕。四个同域守卫并一案（按被测行为合并，
 * 断言逐条保留、去重 0 条——四源各守一个独立分类/留痕分支，夹具口径不同各自保留）：
 * - r42-rebuild-md-uppercase.test.ts（R42-38：.md 判定大小写不敏感——win 资源管理器
 *   改出的 .MD/.Md 不再被 endsWith('.md') 静默丢弃；章号剥尾同步 \.[mM][dD]$）
 * - r71-rebuild-filename-whitelist.test.ts（R71-37：章号 Number() 过宽收严 /^\d+$/
 *   ——hex/科学计数/负数/空名此前都错入表；R51-E-N1 起白名单外走 warnings 报告级桶）
 * - r73-rebuild-summary-warn.test.ts（R73-47：白名单外命名 log.warn 即时留痕——增量
 *   跳过重建时健康报告不可见，「摘要不生效」难定位；命名契约不动）
 * - backlog-summary-nonmd-warn.test.ts（R55-B-3：目录内非 .md 普通文件同款 warn 留痕，
 *   `._` 前缀资源分叉保持豁免——原静默跳过与同函数两处留痕口径不一）
 */
import { describe, it, expect, beforeEach, afterEach, vi, test } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuild } from '../../src/cache/rebuild.js'
import { log } from '../../src/log/index.js'
import { writeBookConfig, DEFAULT_CONFIG } from '../../src/format/yaml.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function makeBareRoot(prefix: string): string {
  const root = mkdtempTracked(join(tmpdir(), prefix))
  writeBookConfig(join(root, 'book.yaml'), { ...DEFAULT_CONFIG, book: { title: '书', genre: '玄幻' } })
  return root
}

describe('R42-38：.MD 大写扩展名摘要文件不再被静默过滤', () => {
  it('章摘要 <数字>.MD 入库；白名单外 .MD 进健康报告而非过滤丢弃', () => {
    const root = makeBareRoot('r42-rebuild-')
    try {
      const chapterDir = join(root, '定稿', '摘要', '章摘要')
      mkdirSync(chapterDir, { recursive: true })
      writeFileSync(join(chapterDir, '5.MD'), '---\nchapter: 5\n---\n\n大写扩展名摘要\n', 'utf-8')
      writeFileSync(join(chapterDir, '9.md'), '合法小写摘要', 'utf-8')
      writeFileSync(join(chapterDir, '手写草稿.MD'), '白名单外的大写扩展名文件\n', 'utf-8')
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      // 5.MD 与 9.md 均入库（修复前 5.MD 被过滤，summaryCount=1）
      expect(r.summaryCount).toBe(2)
      // 手写草稿.MD 进入命名白名单判定 → 健康报告留痕（修复前被过滤吞掉）
      // R51-E-N1：报告级分流——留痕面改 warnings（原 errors 触发硬闸消费面）
      const badErrors = r.warnings.filter((e) => e.message.includes('手写草稿.MD'))
      expect(badErrors).toHaveLength(1)
      expect(badErrors[0]!.message).toContain('未入库')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('卷摘要 .Md/.mD 混合大小写同样入库且章号剥离正确', () => {
    const root = makeBareRoot('r42-rebuild-')
    try {
      const volumeDir = join(root, '定稿', '摘要', '卷摘要')
      mkdirSync(volumeDir, { recursive: true })
      writeFileSync(join(volumeDir, '2.Md'), '第二卷摘要', 'utf-8')
      writeFileSync(join(volumeDir, '3.mD'), '第三卷摘要', 'utf-8')
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      expect(r.summaryCount).toBe(2)
      // 章号提取不残留尾巴：'.Md' 剥尾后 '2' 为纯数字才入库——若剥尾仍大小写敏感，
      // '2.Md' 会进白名单外 errors 而非 summaryCount
      expect(r.errors.filter((e) => e.message.includes('摘要文件名'))).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test('R71-37: 十六进制/科学计数/负数/空名摘要文件 → 拒入表并计入 errors', () => {
  const root = makeBareRoot('r71-rebuild-')
  try {
    const dir = join(root, '定稿', '摘要', '章摘要')
    mkdirSync(dir, { recursive: true })
    // 修复前：0x10→16、1e2→100、-3→-3 都 Number.isFinite 错误入表；`.md`→0 照样入
    for (const bad of ['0x10.md', '1e2.md', '-3.md', '.md']) {
      writeFileSync(join(dir, bad), '内容', 'utf-8')
    }
    writeFileSync(join(dir, '7.md'), '合法摘要', 'utf-8')
    const r = rebuild(root, join(root, '.cache', 'index.db'))
    expect(r.summaryCount).toBe(1) // 只有 7.md 入表
    // R51-E-N1：报告级分流——白名单外命名改入 warnings（可见性保持，不进硬闸 errors）
    const badErrors = r.warnings.filter((e) => e.message.includes('摘要文件名'))
    expect(badErrors.length).toBe(4)
    for (const bad of ['0x10', '1e2', '-3', '.md']) {
      expect(badErrors.some((e) => e.message.includes(bad === '.md' ? '「.md」' : bad))).toBe(true)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('R73-47 / 白名单外摘要命名 warn 留痕', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempTracked(join(tmpdir(), 'r73-rebuild-'))
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 摘要书\n', 'utf-8')
    const dir = join(root, '定稿', '摘要', '章摘要')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '12.md'), '---\nchapter: 12\n---\n\n正常摘要\n', 'utf-8')
    writeFileSync(join(dir, '手写草稿.md'), '不是摘要命名约定的文件\n', 'utf-8')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('白名单外命名：warn 留痕 + 计入健康报告 + 不入库（白名单内照常入库）', () => {
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      expect(r.summaryCount).toBe(1) // 12.md 入库
      // R51-E-N1：报告级分流——健康报告在册面改 warnings（原 errors 触发硬闸消费面）
      expect(r.warnings.some((e) => e.message.includes('手写草稿.md'))).toBe(true)
      expect(warnSpy).toHaveBeenCalled()
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('手写草稿.md')
      expect(warned).toContain('未入库')
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('R55-B-3 / 摘要目录非 .md 普通文件 warn 留痕', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempTracked(join(tmpdir(), 'r59-rebuild-nonmd-'))
    writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nbook:\n  title: 摘要书\n', 'utf-8')
    const dir = join(root, '定稿', '摘要', '章摘要')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '7.md'), '---\nchapter: 7\n---\n\n正常摘要\n', 'utf-8')
    writeFileSync(join(dir, 'notes.txt'), '散落的普通文件\n', 'utf-8')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('非 .md 普通文件：warn 留痕 + 不入库（.md 照常入库）', () => {
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      const r = rebuild(root, join(root, '.cache', 'index.db'))
      expect(r.summaryCount).toBe(1) // 7.md 照常入库
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).toContain('notes.txt')
      expect(warned).toContain('非 .md 文件')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('`._` 前缀文件（macOS 资源分叉）保持豁免不告警', () => {
    writeFileSync(join(root, '定稿', '摘要', '章摘要', '._7.md'), '资源分叉\n', 'utf-8')
    const warnSpy = vi.spyOn(log, 'warn')
    try {
      rebuild(root, join(root, '.cache', 'index.db'))
      const warned = warnSpy.mock.calls.map((c) => String(c[1] ?? c[0])).join('\n')
      expect(warned).not.toContain('._7.md')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
