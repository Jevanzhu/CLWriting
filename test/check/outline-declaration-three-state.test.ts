/**
 * R69-2（十七轮）：细纲声明侧三态 + 批量连写定稿闸回归。
 *
 * 修复背景：readOutlineLeads 在细纲章号 ≠ 被检章时返回 []（声明未知），与「明确未
 * 声明」不可区分——批量连写（batchSize≥2）时细纲恒@首章、其余章推进落归档，每章
 * 实际推进全部误报 lead-done-not-declared 并经 LEAD_GATE 硬阻断批量定稿。既有测试
 * 全部以「细纲@被检章」建模，与真实管线时序不符（本文件补齐该时序）。
 * 同时锁单章行为不回退：细纲@被检章的 declared-not-done 仍拦。
 *
 * 并入档：原 r33d-batch-b.test.ts 的 R33D-14 组（声明侧读失败标记
 * reason:'read-failed'——机检产黄项的判定源；chapter-mismatch 维持静默）与
 * outlineDeclarationForChapter 的 reason 三态互为补充，去重 0 条。
 */
import { describe, test, it, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outlineDeclarationForChapter } from '../../src/check/outline-leads.js'
import { finalizeRevision } from '../../src/document/finalize.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

const BODY_SENTENCE = '雪落在宗门的山门上，玉佩在袖中发烫。'

// ── 纯函数三态 ───────────────────────────────────

test('outlineDeclarationForChapter 三态：命中/未知/宽容沿用', () => {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r69-outline-'))
  try {
    mkdirSync(join(root, '工作区'), { recursive: true })
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 2\n推进: 悬念-001\n---\n\n细纲。', 'utf-8')
    expect(outlineDeclarationForChapter(root, 2)).toEqual({ known: true, leads: ['悬念-001'] })
    // R33D-14：chapter-mismatch 形态带 reason 标记（机检侧凭 reason 区分故障与常态）
    expect(outlineDeclarationForChapter(root, 3)).toEqual({ known: false, leads: [], reason: 'chapter-mismatch' })
    // 无章号 → 宽容沿用（视为属于被检章）
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n推进: 悬念-002\n---\n\n细纲。', 'utf-8')
    expect(outlineDeclarationForChapter(root, 9)).toEqual({ known: true, leads: ['悬念-002'] })
    // 无细纲 → 已知空声明
    rmSync(join(root, '工作区', '细纲.md'))
    expect(outlineDeclarationForChapter(root, 1)).toEqual({ known: true, leads: [] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 定稿闸集成（真实管线时序：细纲@首章 + 归档章推进）──────────

function makeBatchBook(): { root: string; ch2DocId: string } {
  const root = mkdtempTracked(join(tmpdir(), 'clw-r69-batch-'))
  mkdirSync(join(root, '写作', '正文'), { recursive: true })
  // 两章正文，都含证据句
  for (const [num, title] of [
    [1, '开篇'],
    [2, '夜行'],
  ] as const) {
    writeFileSync(
      join(root, '写作', '正文', `000${num}-${title}.md`),
      `---\n章号: ${num}\n标题: ${title}\n---\n\n${BODY_SENTENCE}\n`,
      'utf-8',
    )
  }
  mkdirSync(join(root, '布线', '悬念'), { recursive: true })
  writeFileSync(
    join(root, '布线', '悬念', '悬念-001-玉佩.md'),
    '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n\n## 履历\n',
    'utf-8',
  )
  // 批量连写真实时序：细纲@首章（仅 outline 端点覆盖写，批量循环不重生成）
  mkdirSync(join(root, '工作区'), { recursive: true })
  writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: 悬念-001\n---\n\n本章细纲。', 'utf-8')
  // 第 2 章推进落归档 .账本推进暂存/第2章.md（X-P2-6 归档语义）
  mkdirSync(join(root, '工作区', '.账本推进暂存'), { recursive: true })
  writeFileSync(join(root, '工作区', '.账本推进暂存', '第2章.md'), `- 悬念-001 递进：${BODY_SENTENCE}\n`, 'utf-8')
  // 清单登记第 2 章
  mkdirSync(join(root, '项目'), { recursive: true })
  const manifestPath = join(root, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const ch2DocId = generateDocId()
  upsertEntry(m, { id: ch2DocId, nodeType: 'document', path: '写作/正文/0002-夜行.md', parentId: null })
  writeManifest(manifestPath, m)
  return { root, ch2DocId }
}

test('R69-2：细纲@他章 + 归档章推进（批量连写时序）→ 声明未知跳过闭合，定稿放行', () => {
  const { root, ch2DocId } = makeBatchBook()
  try {
    const r = finalizeRevision(root, ch2DocId)
    expect(r.ok).toBe(true) // 修复前：lead-done-not-declared 假红 → LEAD_GATE 硬阻断
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R69-2 守卫不回退：细纲@被检章 + 推进未兑现 → declared-not-done 仍拦', () => {
  const { root, ch2DocId } = makeBatchBook()
  try {
    // 细纲改到第 2 章（单章模式时序）：声明的推进在归档/主文件都兑现不了（归档是第 2 章
    // 的，但证据句不在……此处直接改写归档内容为不含证据句的条目，构造「声明未兑现」）
    writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 2\n推进: 悬念-999\n---\n\n本章细纲。', 'utf-8')
    writeFileSync(join(root, '工作区', '.账本推进暂存', '第2章.md'), `- 悬念-001 递进：${BODY_SENTENCE}\n`, 'utf-8')
    const r = finalizeRevision(root, ch2DocId)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('LEAD_GATE')
    expect(r.error).toContain('声明了没做') // 悬念-999 声明了没做
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── R33D-14（并入档；原 r33d-batch-b.test.ts）：声明侧读失败 reason 标记 ──

describe('R33D-14：声明侧读失败 reason 标记', () => {
  it('细纲在位但不可读（目录占位）→ known:false + reason:read-failed', () => {
    const root = mkdtempTracked(join(tmpdir(), 'outline-read-failed-'))
    try {
      mkdirSync(join(root, '工作区', '细纲.md'), { recursive: true })
      const d = outlineDeclarationForChapter(root, 1)
      expect(d.known).toBe(false)
      expect(d.reason).toBe('read-failed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('细纲属他章 → known:false + reason:chapter-mismatch（非故障，不产黄）', () => {
    const root = mkdtempTracked(join(tmpdir(), 'outline-read-failed-'))
    try {
      mkdirSync(join(root, '工作区'), { recursive: true })
      writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 2\n推进: 成长线-001\n---\n\n本章细纲。\n', 'utf-8')
      const d = outlineDeclarationForChapter(root, 1)
      expect(d.known).toBe(false)
      expect(d.reason).toBe('chapter-mismatch')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('正常细纲 → known:true 且无 reason', () => {
    const root = mkdtempTracked(join(tmpdir(), 'outline-read-failed-'))
    try {
      mkdirSync(join(root, '工作区'), { recursive: true })
      writeFileSync(join(root, '工作区', '细纲.md'), '---\n章号: 1\n推进: 成长线-001\n---\n\n本章细纲。\n', 'utf-8')
      const d = outlineDeclarationForChapter(root, 1)
      expect(d.known).toBe(true)
      expect(d.leads).toEqual(['成长线-001'])
      expect(d.reason).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
