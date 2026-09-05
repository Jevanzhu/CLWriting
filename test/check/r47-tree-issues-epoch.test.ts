/**
 * R47-30（四十七轮）回归：collectTreeIssues 纪元指纹遍数消重（首尾各一遍）。
 *
 * 修复前：一次聚合最多 4 遍全树纪元指纹（syncTreeIssuesEpoch 内部自算 + epochFp0
 * 基线 + epochFpNow 轮前复核 + epochFpEnd 循环后终核），每遍对 布线/大纲·关系线/
 * 章纲/文风/暂存 等目录递归 readdir+stat——大书/SMB 卷上秒级。
 * 修复后：首（epochFp0 前移传入 sync 复用）+ 尾（epochFpEnd 终核）各一遍；
 * 轮前复核遍删除（职责由终核统一承担）。另锚定：syncTreeIssuesEpoch 的
 * precomputedFp 复用语义（传入即落表，不传自算零感知）+ 红点结果与
 * 「删 .cache 全量重算」逐字节一致（语义零回归，golden 口径同 tree-issues-cache 测试）。
 */
import { describe, it, expect, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../src/check/tree-issues-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/check/tree-issues-cache.js')>()
  return { ...actual, computeTreeIssuesGlobalFp: vi.fn(actual.computeTreeIssuesGlobalFp) }
})

import { computeTreeIssuesGlobalFp, syncTreeIssuesEpoch } from '../../src/check/tree-issues-cache.js'
import { collectTreeIssues } from '../../src/check/run.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const fpMock = vi.mocked(computeTreeIssuesGlobalFp)

/** 与 r71 计数测试同款造书（含布线 + 每章禁词「玉佩」制造确定红源） */
function makeBook(chapterCount: number): string {
  const root = mkdtempTracked(join(tmpdir(), 'r47-epoch-'))
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

describe('R47-30：聚合的纪元指纹遍数收敛为首尾各一遍', () => {
  it('全书 miss 的一次聚合 → 全树纪元指纹 ≤2 遍（首 + 终核；修复前 4 遍）', () => {
    const root = makeBook(4)
    try {
      fpMock.mockClear()
      const { issues } = collectTreeIssues(root, () => undefined)
      expect(Object.keys(issues)).toHaveLength(4) // 禁词红源命中证明机检真跑了
      // mock 只计 run.ts 侧调用（sync 内部遍已由 precomputedFp 消除）：首（epochFp0）
      // + 尾（epochFpEnd）= 2；R47-30 前为 3（+sync 内部未计入的第 4 遍）
      expect(fpMock.mock.calls.length).toBeLessThanOrEqual(2)
      expect(fpMock.mock.calls.length).toBe(2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('全缓存命中的二次聚合 → 仅首遍 1 次（无待落盘章，终核不触发）', () => {
    const root = makeBook(3)
    try {
      collectTreeIssues(root, () => undefined) // 建缓存
      fpMock.mockClear()
      const second = collectTreeIssues(root, () => undefined)
      expect(Object.keys(second.issues)).toHaveLength(3)
      expect(fpMock.mock.calls.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R47-30：语义零回归（终核口径保留）', () => {
  it('红点结果与「删 .cache 全量重算」逐字节一致（含变更后重聚合）', () => {
    const root = makeBook(4)
    try {
      collectTreeIssues(root, () => undefined) // 预热缓存
      // 变更混合面：触碰全局输入（book.yaml 纪元源）+ 改 1 章正文
      utimesSync(join(root, 'book.yaml'), new Date(), new Date())
      writeFileSync(
        join(root, '写作', '正文', '002-第2章.md'),
        '---\n章号: 2\n标题: 第2章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n山门外的旧玉在雨夜里安安静静。\n',
        'utf-8',
      )
      const cached = collectTreeIssues(root, () => undefined)
      rmSync(join(root, '.cache'), { recursive: true, force: true })
      const fresh = collectTreeIssues(root, () => undefined)
      expect(cached.issues).toEqual(fresh.issues)
      // 抽查：第 2 章红源消除（其余章禁词红照旧）
      const m = readManifest(join(root, '项目', '文档清单.jsonl'))
      const docOf = (p: string) => [...m.entries.entries()].find(([, e]) => e.path === p)![0]
      expect(cached.issues[docOf('写作/正文/002-第2章.md')]).toBeUndefined()
      expect(Object.keys(cached.issues)).toHaveLength(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('聚合窗口内纪元漂移 → 整批不落缓存（R32-14 终核闸在 R47-30 后仍生效）', () => {
    const root = makeBook(3)
    try {
      collectTreeIssues(root, () => undefined) // 建缓存（首轮全 miss + 落盘）
      // 第二轮：章循环中途触碰纪元源——通过 fp 包装在每次调用后触碰一次全局输入，
      // 使终核遍（epochFpEnd）必见漂移 → 本轮零落缓存
      const orig = fpMock.getMockImplementation()!
      let n = 0
      fpMock.mockImplementation((...args) => {
        const r = orig(...args)
        if (++n === 1) utimesSync(join(root, 'book.yaml'), new Date(), new Date())
        return r
      })
      try {
        collectTreeIssues(root, () => undefined)
      } finally {
        fpMock.mockImplementation(orig)
      }
      // 漂移被 syncTreeIssuesEpoch 的首遍之前记录的基线 vs 终核检出（表在下一轮
      // 聚合开头会因纪元变化被清）——此处验证第三轮结果仍与全量一致（无陈旧行）
      const third = collectTreeIssues(root, () => undefined)
      rmSync(join(root, '.cache'), { recursive: true, force: true })
      const fresh = collectTreeIssues(root, () => undefined)
      expect(third.issues).toEqual(fresh.issues)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('R47-30：syncTreeIssuesEpoch precomputedFp 复用', () => {
  it('传入即复用（不再自算）：forced fp 落表、二次同值 no-op、不传则自算与真值一致', () => {
    const root = makeBook(1)
    try {
      mkdirSync(join(root, '.cache'), { recursive: true })
      const db = new DatabaseSync(join(root, '.cache', 'index.db'))
      try {
        // 传入 forced fp：首次清+记（true），同值再调 no-op（false）
        expect(syncTreeIssuesEpoch(db, root, null, 'r47-forced-fp')).toBe(true)
        expect(syncTreeIssuesEpoch(db, root, null, 'r47-forced-fp')).toBe(false)
        const row = db.prepare("SELECT value FROM tree_issues_meta WHERE key = 'global_fp'").get() as { value: string }
        expect(row.value).toBe('r47-forced-fp')
        // 不传（既有调用方口径）：自算真值——与 forced 不同 → 清+记（true），随后 no-op
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(true)
        expect(syncTreeIssuesEpoch(db, root, null)).toBe(false)
      } finally {
        db.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
