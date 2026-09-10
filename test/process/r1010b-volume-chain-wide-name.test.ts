/**
 * R1010b-CORE-P2-1（2026-09-10 内存专项重审修复批）回归：
 * volumeChainState 定稿章识别升格 chapterNoFromName 单源（与 selfHealRecentChapterSummaries
 * 的 R1010-P3 修复同款宽容集）。修复前窄正则 `/^(\d+)-/` 只认连字符——`1—开局.md`、
 * `1 开局.md`、`1.md` 等宽容命名的定稿章既不进 chain 也不进 missing（卷链完整性判定
 * 静默漏章：卷摘要以残链报缺甚至空链无告警）。装置仿 test/process/summary-volume.test.ts
 *（manifest 手工构造 finalizedRevision；volumeChainState 只读 manifest + 章摘要，
 * 正文文件为装置真实性照常落盘）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { volumeChainState } from '../../src/process/summary.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'

const dirs: string[] = []

beforeEach(() => {
  process.env['CLWRITING_DRIVER'] = 'mock'
})

afterEach(() => {
  delete process.env['CLWRITING_DRIVER']
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 造书（volumeSize=3）：specs 逐章给宽容命名 + 是否放章摘要；定稿基线走 manifest */
function makeBookWideNamed(specs: Array<{ no: number; name: string; withSummary: boolean }>): string {
  const root = mkdtempSync(join(tmpdir(), 'clw-r1010b-volchain-'))
  dirs.push(root)
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeFileSync(
    join(root, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 卷链宽容命名测试书\n  volume_size: 3\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  mkdirSync(join(root, '定稿', '摘要', '章摘要'), { recursive: true })
  for (const s of specs) {
    const p = join(root, '写作', '正文', s.name)
    writeFileSync(
      p,
      `---\n章号: ${s.no}\n标题: 宽容命名第${s.no}章\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n第${s.no}章正文。\n`,
      'utf-8',
    )
    const id = generateDocId()
    upsertEntry(m, { id, nodeType: 'document', path: `写作/正文/${s.name}`, parentId: null })
    const e = m.entries.get(id)!
    e.finalizedRevision = computeRevision(p)
    e.finalizedAt = new Date().toISOString()
    if (s.withSummary) {
      writeFileSync(join(root, '定稿', '摘要', '章摘要', `${s.no}.md`), `第${s.no}章摘要正文。`, 'utf-8')
    }
  }
  writeManifest(manifestPath, m)
  return root
}

describe('R1010b-CORE-P2-1：volumeChainState 定稿章识别升格 chapterNoFromName 单源', () => {
  it('宽容命名定稿章（破折号/空格）+ 摘要齐全 → 全进 chain（修复前：静默漏章空链）', () => {
    // 注：`1.md`（裸数字 + .md 扩展名）在 chapterNoFromName 宽容集外（分隔符集
    // [-—\s$] 不含 `.`，`$` 仅匹配名字末尾）——与 selfHeal 侧 R1010-P3 修复后行为
    // 一致，属单源既定边界（扩集牵动 tree/leads/foreshadow 全部消费点，非本批接线面）
    const root = makeBookWideNamed([
      { no: 1, name: '1—开局.md', withSummary: true }, // 破折号命名（窄正则漏）
      { no: 2, name: '2 中局.md', withSummary: true }, // 空格命名（窄正则漏）
      { no: 3, name: '3-终局.md', withSummary: true }, // 连字符命名（既有宽容集）
    ])
    const st = volumeChainState(root, 1, 3)
    expect(st.missing).toEqual([])
    expect(st.chain).not.toBeNull()
    expect([...st.chain!.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('宽容命名定稿章缺摘要 → missing 留痕（修复前：该章不进 finalizedChapters，静默漏）', () => {
    const root = makeBookWideNamed([
      { no: 1, name: '1—开局.md', withSummary: true },
      { no: 2, name: '2 中局.md', withSummary: false }, // 定稿在、摘要缺 → 必须进 missing
    ])
    const st = volumeChainState(root, 1, 3)
    expect(st.chain).toBeNull() // 链不全 fail-closed（二阶误差红线）
    expect(st.missing).toEqual([2])
  })

  it('对照臂：连字符窄命名定稿章行为不变（单源升格不误伤既有命名）', () => {
    const root = makeBookWideNamed([
      { no: 1, name: '1-开局.md', withSummary: true },
      { no: 2, name: '2-中局.md', withSummary: false },
    ])
    const st = volumeChainState(root, 1, 3)
    expect(st.chain).toBeNull()
    expect(st.missing).toEqual([2])
  })
})
