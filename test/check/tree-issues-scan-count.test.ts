/**
 * CC-P1-3 回归：collectTreeIssues 预扫提升——readChapterDir 调用次数与章数解耦。
 *
 * 修复前：每章 checkWithDb 内重扫 大纲/章纲 全量（readChapterDir），大书数百章
 * O(N²) 文件读单请求阻塞事件循环秒级；修复后全书固定三次
 * （正文×2：聚合循环 + maxWritten 基准；章纲×1：循环外预扫）。
 * 另验证 batch 上下文传参后 targetWords（章纲 字数目标）接线不回归（W-P2-11 口径）。
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/format/chapters.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/chapters.js')>()
  return { ...actual, readChapterDir: vi.fn(actual.readChapterDir) }
})

import { readChapterDir } from '../../src/format/chapters.js'
import { collectTreeIssues, checkWithDb, type BatchCheckContext } from '../../src/check/run.js'
import { readBookConfig } from '../../src/format/yaml.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

/** 造一本 N 章正文书；wiring=true 加布线（测 maxWritten/账本路径），每章带禁词「玉佩」制造确定红源 */
function makeBook(chapterCount: number, wiring = true): string {
  const root = mkdtempSync(join(tmpdir(), 'scan-count-'))
  if (wiring) mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '大纲', '章纲'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  // 禁词红源：每章正文命中「玉佩」→ issues 必非空（证明逐章 checkWithDb 真的跑了）
  mkdirSync(join(root, '文风'), { recursive: true })
  writeFileSync(join(root, '文风', '文风铁律.md'), '# 文风铁律\n## 硬禁词\n- 玉佩\n', 'utf-8')
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 测试书\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  if (wiring) {
    writeFileSync(
      join(root, '布线', '悬念', '悬念-001-灭门真凶.md'),
      '---\n编号: 悬念-001\n标题: 灭门真凶\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
      'utf-8',
    )
  }
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  for (let no = 1; no <= chapterCount; no++) {
    const pad = String(no).padStart(3, '0')
    writeFileSync(
      join(root, '写作', '正文', `${pad}-第${no}章.md`),
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的玉佩在雨夜里连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, {
      id: generateDocId(),
      nodeType: 'document',
      path: `写作/正文/${pad}-第${no}章.md`,
      parentId: null,
    })
  }
  // 章纲（带 字数目标，供 targetWords 接线断言）
  writeFileSync(
    join(root, '大纲', '章纲', '001-第1章.md'),
    '---\n章号: 1\n标题: 第1章\n字数目标: 50000\n---\n\n## 反转线索表\n- 核心反转：x\n',
    'utf-8',
  )
  writeManifest(manifestPath, m)
  return root
}

const readChapterDirMock = vi.mocked(readChapterDir)

function callCount(): number {
  return readChapterDirMock.mock.calls.length
}

describe('collectTreeIssues 预扫提升（CC-P1-3）', () => {
  it('readChapterDir 调用次数与章数解耦：3 章 → 全书固定 3 次（修复前 2+N 次）', () => {
    const root = makeBook(3)
    try {
      readChapterDirMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      expect(Object.keys(issues)).toHaveLength(3) // 全部未定稿 → 逐章受检
      // 正文×2（聚合循环 + maxWritten 基准）+ 章纲×1（循环外预扫）
      expect(callCount()).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('章数翻倍 → 调用次数不变（O(N²) → O(N)）', () => {
    const root = makeBook(6)
    try {
      readChapterDirMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      expect(Object.keys(issues)).toHaveLength(6)
      expect(callCount()).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('batch 传参后 targetWords 接线不回归：章纲 字数目标 经预扫列表进入 word-count 检查', () => {
    const root = makeBook(1, false) // 无布线 → db 传 null 合法（对齐 v 轮回归测口径）
    try {
      const { config } = readBookConfig(join(root, 'book.yaml'))
      // 与 collectTreeIssues 同口径构造 batch 上下文
      const batch: BatchCheckContext = {
        outlineChapters: readChapterDir(join(root, '大纲', '章纲')).chapters,
        leadUpdates: [],
      }
      const outcome = checkWithDb(root, join(root, '写作', '正文', '001-第1章.md'), null, config, batch)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      const items = outcome.report.sections.flatMap((s) => s.items)
      // 正文 ~15 字 vs 目标 50000 → 大幅偏离，word-count 黄项应出现（targetWords 已接线）
      expect(items.some((i) => i.checkId === 'word-count')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
