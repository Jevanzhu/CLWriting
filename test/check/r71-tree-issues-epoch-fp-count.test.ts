/**
 * R71-20 回归：collectTreeIssues 写前纪元复核（R70-14）的 computeTreeIssuesGlobalFp 调用次数。
 *
 * 修复前：章循环体内每 miss 章重算一次全局指纹（递归 readdir+stat 全输入树）——任一
 * 全局输入变动清表后全书 miss，数百章书一次聚合数百次全树遍历（同步路径性能回退）。
 * 修复后：基线 1 次（epochFp0）+ 轮内缓存 1 次（epochFpNow）= 全书固定 2 次，与章数
 * 解耦；另以「二次聚合零正文整读」断言 epochStable 口径未破（缓存仍正确写入）。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/check/tree-issues-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/check/tree-issues-cache.js')>()
  return { ...actual, computeTreeIssuesGlobalFp: vi.fn(actual.computeTreeIssuesGlobalFp) }
})

vi.mock('../../src/format/draft.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/format/draft.js')>()
  return { ...actual, readDraft: vi.fn(actual.readDraft) }
})

import { computeTreeIssuesGlobalFp } from '../../src/check/tree-issues-cache.js'
import { readDraft } from '../../src/format/draft.js'
import { collectTreeIssues } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const fpMock = vi.mocked(computeTreeIssuesGlobalFp)
const readDraftMock = vi.mocked(readDraft)

/** 与 tree-issues-scan-count 测试同款造书（含布线 + 每章禁词「玉佩」制造确定红源） */
function makeBook(chapterCount: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'epoch-fp-count-'))
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
      `---\n章号: ${no}\n标题: 第${no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的玉佩在雨夜里连响了三下。\n`,
      'utf-8',
    )
    upsertEntry(m, { id: generateDocId(), nodeType: 'document', path: `写作/正文/${pad}-第${no}章.md`, parentId: null })
  }
  writeManifest(manifestPath, m)
  return root
}

describe('R71-20：写前纪元复核轮内缓存（调用次数与章数解耦）', () => {
  it('全书 miss 的一次聚合 → computeTreeIssuesGlobalFp 全书固定 2 次（修复前 1+N=6）', () => {
    const root = makeBook(5)
    try {
      fpMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      // 5 章全部未定稿且缓存全 miss → 逐章走到写前复核点（红源命中证明机检真跑了）
      expect(Object.keys(issues)).toHaveLength(5)
      // 基线（epochFp0）×1 + 轮内缓存（epochFpNow）×1；修复前每 miss 章各 1 次全树遍历
      expect(fpMock.mock.calls.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('章数翻倍 → 调用次数不变（O(N) 次全树遍历 → O(1)）', () => {
    const root = makeBook(10)
    try {
      fpMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      expect(Object.keys(issues)).toHaveLength(10)
      expect(fpMock.mock.calls.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('轮内缓存口径下首轮仍落缓存：二次聚合全部命中（零正文整读、issues 同构）', () => {
    const root = makeBook(4)
    try {
      const first = collectTreeIssues(root, () => undefined)
      expect(Object.keys(first.issues)).toHaveLength(4)
      readDraftMock.mockClear()
      fpMock.mockClear()
      const second = collectTreeIssues(root, () => undefined)
      // 章级缓存命中 = 首轮 epochStable 为真、行已写入（复核口径未误伤缓存写入）
      expect(readDraftMock.mock.calls.length).toBe(0)
      expect(second.issues).toEqual(first.issues)
      expect(fpMock.mock.calls.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
