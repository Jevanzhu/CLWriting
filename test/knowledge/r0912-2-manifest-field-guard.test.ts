/**
 * 重评-0912-2（2026-09-12 全量重评修复批）P2-5 / P3 回归。
 *
 * - P2-5（manifest.ts validateEntry）：R40-16 只拦 null/非对象行，非字符串 target
 *   （如 {"target":123}）在 isSafeKnowledgeTarget 的 isAbsolute 处、非字符串 sha256
 *   （数字形态）在 `sha256?.startsWith` 处仍裸 TypeError 崩——check:knowledge 门由
 *   列 issue 变裸栈崩；commitKnowledgeFile 尾部对账在 manifest 登记已落盘后崩。
 *   修后：报 issue 不抛（对齐同族「坏形状报 issue 不崩」降级口径），条目原样保留。
 * - P3（update.ts summarizeFalsePositives）：corpus JSON 数组含 null/非对象项 →
 *   e.expect TypeError 崩整轮汇总（R71-35 只修了非数组形态）。修后：坏项跳过 +
 *   warn 留痕，不崩整轮。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateKnowledgeManifest, KNOWLEDGE_MANIFEST } from '../../src/knowledge/manifest.js'
import { commitKnowledgeFile, summarizeFalsePositives } from '../../src/knowledge/update.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function tempProject(): string {
  const root = mkdtempTracked(join(tmpdir(), 'r0912-2-knowledge-'))
  mkdirSync(join(root, '知识层'), { recursive: true })
  return root
}

function writeManifest(root: string, entries: unknown[]): void {
  writeFileSync(
    join(root, KNOWLEDGE_MANIFEST),
    JSON.stringify({ version: 1, generated_at: '2026-09-12T00:00:00+08:00', entries }),
    'utf-8',
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('r0912-2 P2-5: manifest 条目字段类型守卫', () => {
  it('r0912-2: target:number（{"target":123}）→ validateKnowledgeManifest 报 issue 不抛', () => {
    const root = tempProject()
    writeManifest(root, [{ target: 123, source: 's', license: 'l', sha256: 'sha256:' + 'a'.repeat(64) }])
    // 修复前：isSafeKnowledgeTarget → isAbsolute(123) TypeError 裸崩
    const report = validateKnowledgeManifest(root)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('必须为字符串'))).toBe(true)
  })

  it('r0912-2: sha256:number → 报 issue 不抛（修复前 sha256?.startsWith TypeError）', () => {
    const root = tempProject()
    writeManifest(root, [{ target: '知识层/a.md', source: 's', license: 'l', sha256: 456 }])
    const report = validateKnowledgeManifest(root)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('必须为字符串'))).toBe(true)
  })

  it('r0912-2: commit 链含坏字段行 → 不抛、manifest 照常落盘（新条目+坏行保留）、报告 ok:false', () => {
    const root = tempProject()
    writeManifest(root, [{ target: 123, sha256: 456 }])
    const finalRel = '知识层/定稿.md'
    writeFileSync(join(root, finalRel), '# 定稿正文。\n', 'utf-8')
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})

    // 修复前：登记已落盘，尾部 validateKnowledgeManifest 在坏字段上 TypeError——CLI 报栈但 manifest 实已写入
    const report = commitKnowledgeFile(root, { target: finalRel, source: 's', license: 'l' })
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('必须为字符串'))).toBe(true)

    // manifest 照常落盘：坏行原样保留（写入侧不静默增删改）、新条目登记在位
    const after = JSON.parse(readFileSync(join(root, KNOWLEDGE_MANIFEST), 'utf-8')) as {
      entries: Array<{ target?: unknown; sha256?: unknown }>
    }
    expect(after.entries[0]).toEqual({ target: 123, sha256: 456 })
    expect(after.entries[1]?.target).toBe(finalRel)
    expect(typeof after.entries[1]?.sha256).toBe('string')
    // 判重侧坏行跳过的 R40-16 warn 留痕在位
    expect(warnSpy.mock.calls.some((c) => String(c[1]).includes('坏形状'))).toBe(true)
  })
})

describe('r0912-2 P3: corpus 数组坏项不崩汇总', () => {
  it('r0912-2: corpus JSON 数组含 null/非对象项 → 跳过 + warn，其余条目正常汇总', () => {
    const root = mkdtempTracked(join(tmpdir(), 'r0912-2-corpus-'))
    const corpusDir = join(root, 'corpus')
    mkdirSync(corpusDir, { recursive: true })
    // 修复前：e.expect 在 null 项上 TypeError 崩整轮汇总
    writeFileSync(
      join(corpusDir, 'bad-items.json'),
      JSON.stringify([null, { excerpt: '山门外落了整夜的风雪。', expect: 'silent' }, 42, { excerpt: '排比。', expect: 'fire' }]),
      'utf8',
    )
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const s = summarizeFalsePositives(corpusDir)
    expect(s).toHaveLength(1)
    expect(s[0]!.checkId).toBe('bad-items')
    expect(s[0]!.silent).toBe(1)
    expect(s[0]!.fire).toBe(1) // 坏项不计入 fire
    expect(s[0]!.excerpts).toEqual(['山门外落了整夜的风雪。'])
    expect(warnSpy.mock.calls.some((c) => String(c[1]).includes('坏形状'))).toBe(true)
  })
})
