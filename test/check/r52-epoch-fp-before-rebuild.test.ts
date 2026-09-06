/**
 * R52-E-1（五十二轮）回归：纪元指纹基线必须先于 rebuild 计算。
 *
 * 修复前：epochFp0 在 rebuild 之后（sync 前）才算——rebuild 内部扫源 stat 与 fp0
 * 计算之间存在头窗：窗口内纪元输入（布线/大纲/文风/清单等）被改写时，rebuild 读到
 * 旧数据，其后计算的 fp0 已是新纪元 → 陈旧红值以新纪元落缓存（指纹自洽，终核
 * epochFpEnd 不再失效它，红点口径被固化到下纪元）。
 * 修复后：fp0 在 rebuild **之前**算得并传入 syncTreeIssuesEpoch 复用——终核窗口
 * 覆盖「fp0 → 聚合全程」，头窗内任何变更使 fpEnd≠fp0，整批写入按既有失效路径丢弃。
 *
 * 锚定方式：fp 与 rebuild 的调用顺序（行为面与 R47-30 既有语义测试重合——遍数 ≤2、
 * 终核闸、precomputedFp 复用均由 r47-tree-issues-epoch.test.ts 继续锚定，此处不重复）。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/check/tree-issues-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/check/tree-issues-cache.js')>()
  return { ...actual, computeTreeIssuesGlobalFp: vi.fn(actual.computeTreeIssuesGlobalFp) }
})
vi.mock('../../src/cache/rebuild.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cache/rebuild.js')>()
  return { ...actual, rebuild: vi.fn(actual.rebuild) }
})

import { computeTreeIssuesGlobalFp } from '../../src/check/tree-issues-cache.js'
import { rebuild } from '../../src/cache/rebuild.js'
import { collectTreeIssues } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const fpMock = vi.mocked(computeTreeIssuesGlobalFp)
const rebuildMock = vi.mocked(rebuild)

/** 与 r47 计数测试同款造书（含布线 + 每章禁词「玉佩」制造确定红源） */
function makeBook(chapterCount: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'r52-epoch-order-'))
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(join(root, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n', 'utf-8')
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
    '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的雨夜里，玉佩，连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
  }
  writeManifest(manifestPath, m)
  return root
}

describe('R52-E-1：纪元指纹基线先于 rebuild', () => {
  it('一次聚合内 computeTreeIssuesGlobalFp 首遍调用先于 rebuild（修复后在 sync 之前、rebuild 之前）', () => {
    const root = makeBook(2)
    try {
      const order: string[] = []
      const fpOrig = fpMock.getMockImplementation()!
      const rebuildOrig = rebuildMock.getMockImplementation()!
      fpMock.mockImplementation((...args) => {
        order.push('fp')
        return fpOrig(...args)
      })
      rebuildMock.mockImplementation((...args) => {
        order.push('rebuild')
        return rebuildOrig(...args)
      })
      try {
        const { issues } = collectTreeIssues(root, () => undefined)
        // 红源命中证明机检真跑了（缓存链路真实启用，非降级路径）
        expect(Object.keys(issues)).toHaveLength(2)
        expect(order.indexOf('fp')).toBeGreaterThanOrEqual(0)
        expect(order.indexOf('rebuild')).toBeGreaterThanOrEqual(0)
        // 核心断言：fp 基线（首遍）先于 rebuild——头窗收编进终核防护的前提
        expect(order.indexOf('fp')).toBeLessThan(order.indexOf('rebuild'))
        // 遍数不变式维持（R47-30 口径）：首 + 终核 = 2（sync 复用预计算 fp 不自算）
        expect(order.filter((s) => s === 'fp')).toHaveLength(2)
      } finally {
        fpMock.mockImplementation(fpOrig)
        rebuildMock.mockImplementation(rebuildOrig)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fp0 与 rebuild 之间触碰纪元源 → 本轮零落缓存（下轮与删库全量逐字节一致）', () => {
    const root = makeBook(3)
    try {
      collectTreeIssues(root, () => undefined) // 建缓存（epoch A）
      // 第二轮：在 fp0（先于 rebuild）之后触碰纪元源（文风铁律 mtime 变化 → 纪元 A→B）
      // ——头窗场景本体：修复后 sync 记基线 A、终核见 B → 整批不落盘
      const fpOrig = fpMock.getMockImplementation()!
      let n = 0
      fpMock.mockImplementation((...args) => {
        const r = fpOrig(...args)
        if (++n === 1) {
          const st = JSON.stringify({ t: Date.now() })
          writeFileSync(join(root, '文风', '文风铁律.md'), `# 文风铁律\n## 硬禁词\n- 玉佩\n<!-- ${st} -->\n`, 'utf-8')
        }
        return r
      })
      try {
        collectTreeIssues(root, () => undefined)
      } finally {
        fpMock.mockImplementation(fpOrig)
      }
      // 第三轮结果与「删 .cache 全量」一致（无陈旧行）——与 r47 漂移测试同口径的语义面
      const third = collectTreeIssues(root, () => undefined)
      rmSync(join(root, '.cache'), { recursive: true, force: true })
      const fresh = collectTreeIssues(root, () => undefined)
      expect(third.issues).toEqual(fresh.issues)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
