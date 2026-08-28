/**
 * R73-42 / R73-43（二十一轮）回归。
 *
 * R73-42：book-search scope「定稿」按 manifest.finalizedRevision 过滤正文区——
 * 此前实搜 写作/正文 全部文件（含未定稿草稿），与 assembleStatus 定稿口径不一致。
 * R73-43：spillIfLarge 极小 maxInlineChars 时加最小正文预算——此前 preview 会被砍到
 * 只剩通知行（模型侧失去任何正文线索）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchBook } from '../../src/process/book-search.js'
import { spillIfLarge } from '../../src/process/spill.js'
import { readManifest, writeManifest, upsertEntry, type Manifest } from '../../src/document/manifest.js'

function writeManifestEntry(root: string, id: string, path: string, finalized: boolean): void {
  const fp = join(root, '项目', '文档清单.jsonl')
  let m: Manifest
  try {
    m = readManifest(fp)
  } catch {
    m = { version: 1, entries: new Map() }
  }
  upsertEntry(m, {
    id,
    nodeType: 'document',
    path,
    parentId: null,
    ...(finalized ? { finalizedRevision: 'sha256:aaa', finalizedAt: '2026-08-01T00:00:00Z' } : {}),
  })
  mkdirSync(join(root, '项目'), { recursive: true })
  writeManifest(fp, m)
}

describe('R73-42 / book-search 定稿 scope 按清单过滤', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'r73-search-'))
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    // 第 1 章已定稿、第 2 章是在写草稿，两章都含检索词「烛火」
    writeFileSync(join(root, '写作', '正文', '0001-雨夜.md'), '---\n章号: 1\n标题: 雨夜\n---\n\n烛火摇曳。\n', 'utf-8')
    writeFileSync(join(root, '写作', '正文', '0002-晨光.md'), '---\n章号: 2\n标题: 晨光\n---\n\n烛火熄了。\n', 'utf-8')
    writeManifestEntry(root, 'doc_ch1', '写作/正文/0001-雨夜.md', true)
    writeManifestEntry(root, 'doc_ch2', '写作/正文/0002-晨光.md', false)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('scope=定稿：未定稿草稿不进结果，已定稿章命中', () => {
    const r = searchBook(root, '烛火', '定稿')
    expect(r.results).toHaveLength(1)
    expect(r.results[0]!.path).toBe('写作/正文/0001-雨夜.md')
  })

  it('scope=正文/all：不过滤（草稿仍可搜）', () => {
    expect(searchBook(root, '烛火', '正文').results).toHaveLength(2)
    expect(searchBook(root, '烛火', 'all').results).toHaveLength(2)
  })

  it('清单缺失 → 定稿 scope 保持全量兜底（无法判定不误杀）', () => {
    rmSync(join(root, '项目', '文档清单.jsonl'))
    expect(searchBook(root, '烛火', '定稿').results).toHaveLength(2)
  })
})

describe('R73-43 / spill 最小正文预算', () => {
  const noopWriter = (): string | null => '工作区/spills/0123456789abcdef.md'
  const text = '字'.repeat(3000)

  it('极小 maxInlineChars：回退原文，绝不产出只剩通知行的 preview', () => {
    const r = spillIfLarge(text, { maxInlineChars: 100, headChars: 200, tailChars: 100 }, noopWriter)
    // 修复前：head/tail 被砍到 0 → preview 只剩通知行；修复后按配置错误兜底回退原文
    expect(r.preview).toBe(text)
  })

  it('生产配置（2000/1200/400）不受影响：头尾正文保留、预算不超', () => {
    const r = spillIfLarge(text, { maxInlineChars: 2000, headChars: 1200, tailChars: 400 }, noopWriter)
    expect(r.preview).toContain('已省略')
    expect(r.locator).toBeDefined()
    const cp = [...r.preview].length
    expect(cp).toBeLessThanOrEqual(2000)
    // 正文线索保底（修复语义的正面验证：头尾合计远高于最小预算）
    expect(cp).toBeGreaterThan(1000)
  })
})
