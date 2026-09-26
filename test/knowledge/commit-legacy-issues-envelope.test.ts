/**
 * 0918二轮修复批（G105）：commitKnowledgeFile 写入后对账的两栏信封回归。
 *
 * 修前：新 entry append + manifest 全量重写**之后**才 return validateKnowledgeManifest
 * ——存量 manifest 有坏行时写入成功却 ok:false（issue 指向旧坏行），重试又报
 * 「不得重复登记」，两报错互相矛盾（重试永死）。修后：
 * - 新 entry 自身先验（写入前）：source/license 空 → ok:false、盘面零变化；
 * - 写入后对账：issue 只指向存量坏行（与新 entry 无关）→ ok:true + issues 附带；
 *   issue 波及新 entry → ok:false 如实报失败。
 */
import { describe, expect, it, afterEach, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { KNOWLEDGE_MANIFEST } from '../../src/knowledge/manifest.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function tempProject(): string {
  const root = mkdtempTracked(join(tmpdir(), 'clw-commit-envelope-'))
  mkdirSync(join(root, '知识层'), { recursive: true })
  return root
}

/** 存量坏行形态的 manifest（坏字段行 + 正常行各一） */
function manifestWithLegacyBadRows(root: string): void {
  writeFileSync(
    join(root, KNOWLEDGE_MANIFEST),
    JSON.stringify({
      version: 1,
      generated_at: '2026-09-18T00:00:00+08:00',
      entries: [
        { target: 123, sha256: 456 }, // 坏字段行：validate 报「必须为字符串」
        { target: '知识层/旧伤.md', source: 's', license: 'l', sha256: 'sha256:' + 'b'.repeat(64) }, // 文件不在盘：报「对应文件不存在」
      ],
    }),
    'utf-8',
  )
}

describe('commit 两栏信封：存量坏行不阻断新登记', () => {
  it('存量坏行 + 新条目合法 → ok:true 且 issues 非空（指向存量）、manifest 落盘含新条目、warn 留痕', () => {
    const root = tempProject()
    manifestWithLegacyBadRows(root)
    const finalRel = '知识层/新定稿.md'
    writeFileSync(join(root, finalRel), '# 新定稿正文。\n', 'utf-8')
    const before = readFileSync(join(root, KNOWLEDGE_MANIFEST), 'utf-8')
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})

    const report = commitKnowledgeFile(root, { target: finalRel, source: 's', license: 'l' })

    // 核心翻转：登记实已成功 → ok:true（修前 ok:false 与盘面矛盾）
    expect(report.ok).toBe(true)
    // issues 附带：全部指向存量（与新 target 无关）
    expect(report.issues.length).toBeGreaterThan(0)
    expect(report.issues.some((i) => i.message.includes('必须为字符串'))).toBe(true)
    expect(report.issues.some((i) => i.message.includes('对应文件不存在'))).toBe(true)
    expect(report.issues.some((i) => i.path === finalRel)).toBe(false)
    // warn 留痕（成功面不静默吞坏行）
    expect(warn.mock.calls.some((c) => String(c[1]).includes('存量坏行'))).toBe(true)
    // 盘面实态：新条目在 manifest、存量坏行原样保留（写入侧不静默增删改）
    const after = JSON.parse(readFileSync(join(root, KNOWLEDGE_MANIFEST), 'utf-8')) as {
      entries: Array<{ target?: unknown }>
    }
    expect(after.entries).toHaveLength(3)
    expect(after.entries[0]).toEqual({ target: 123, sha256: 456 })
    expect(after.entries.some((e) => e?.target === finalRel)).toBe(true)
    expect(before).not.toBe(readFileSync(join(root, KNOWLEDGE_MANIFEST), 'utf-8')) // 确实写过（防 ok:true 系零写入假象）
  })

  it('重试同一 target → 不再矛盾：按判重拒绝（ok:false +「不得重复登记」）', () => {
    const root = tempProject()
    manifestWithLegacyBadRows(root)
    const finalRel = '知识层/新定稿.md'
    writeFileSync(join(root, finalRel), '# 新定稿正文。\n', 'utf-8')
    vi.spyOn(log, 'warn').mockImplementation(() => {})

    const first = commitKnowledgeFile(root, { target: finalRel, source: 's', license: 'l' })
    expect(first.ok).toBe(true) // 前置：首次登记成功

    const retry = commitKnowledgeFile(root, { target: finalRel, source: 's', license: 'l' })
    expect(retry.ok).toBe(false)
    expect(retry.issues.some((i) => i.message.includes('不得重复登记'))).toBe(true)
  })

  it('新条目自身坏（source 空串）→ ok:false 且盘面未写（manifest 零变化、定稿未注入 fm）', () => {
    const root = tempProject()
    writeFileSync(
      join(root, KNOWLEDGE_MANIFEST),
      JSON.stringify({ version: 1, generated_at: '2026-09-18T00:00:00+08:00', entries: [] }),
      'utf-8',
    )
    const finalRel = '知识层/坏参定稿.md'
    const original = '# 坏参定稿正文。\n'
    writeFileSync(join(root, finalRel), original, 'utf-8')
    const before = readFileSync(join(root, KNOWLEDGE_MANIFEST), 'utf-8')

    const report = commitKnowledgeFile(root, { target: finalRel, source: '', license: 'l' })

    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('source 与 license 必填'))).toBe(true)
    // 盘面零变化：manifest 未重写、定稿文件未被注入 front matter
    expect(readFileSync(join(root, KNOWLEDGE_MANIFEST), 'utf-8')).toBe(before)
    expect(readFileSync(join(root, finalRel), 'utf-8')).toBe(original)
  })
})
