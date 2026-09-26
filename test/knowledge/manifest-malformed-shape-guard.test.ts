/**
 * 知识层 manifest 畸形形状守卫：读/校验/登记链对坏形状报 issue 不抛。
 *
 * 档源：原 r0912-manifest-null.test.ts（R0912-G1-P2-1）与
 * （原 r0912-2-manifest-field-guard）的 P2-5 组同属「manifest 坏形状降级」一族，
 * 按被测行为合并；断言逐条保留、去重 0 条（null/标量/字段类型三类形状互不重叠）。
 *
 * - R0912-G1-P2-1（2026-09-12 独立重评修复批）：manifest 写成字面 null（手编/半写
 *   形态）时不再以 ok:true 放行——此前 JSON.parse(null) 成功直通 ok，validate 的
 *   manifest.version 与 update.ts 登记链的 manifest.entries 在 null 上裸 TypeError 崩。
 *   修后：读/校验/登记链全部返回 ok:false 报告，不抛。
 * - 重评-0912-2 P2-5：R40-16 只拦 null/非对象行，非字符串 target（如 {"target":123}）
 *   在 isSafeKnowledgeTarget 的 isAbsolute 处、非字符串 sha256（数字形态）在
 *   `sha256?.startsWith` 处仍裸 TypeError 崩——check:knowledge 门由列 issue 变裸栈崩；
 *   commitKnowledgeFile 尾部对账在 manifest 登记已落盘后崩。修后：报 issue 不抛
 *   （对齐同族「坏形状报 issue 不崩」降级口径），条目原样保留。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readKnowledgeManifest,
  validateKnowledgeManifest,
  KNOWLEDGE_MANIFEST,
} from '../../src/knowledge/manifest.js'
import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function tempProject(): string {
  const root = mkdtempTracked(join(tmpdir(), 'knowledge-manifest-shape-'))
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

describe('manifest 字面 null / 非对象形状守卫', () => {
  it('manifest 写 literal null → readKnowledgeManifest/validateKnowledgeManifest 返 ok:false 不抛', () => {
    const root = tempProject()
    writeFileSync(join(root, KNOWLEDGE_MANIFEST), 'null', 'utf-8')
    const read = readKnowledgeManifest(root)
    expect(read.ok).toBe(false)
    expect(read.issues.some((i) => i.message.includes('不是 JSON 对象'))).toBe(true)
    // 修复前：read.ok=true 放行 null → validate 在 manifest.version 处 TypeError
    const validated = validateKnowledgeManifest(root)
    expect(validated.ok).toBe(false)
    expect(validated.issues.some((i) => i.message.includes('不是 JSON 对象'))).toBe(true)
  })

  it('manifest 写标量（123）同守卫 → ok:false 不抛', () => {
    const root = tempProject()
    writeFileSync(join(root, KNOWLEDGE_MANIFEST), '123', 'utf-8')
    expect(readKnowledgeManifest(root).ok).toBe(false)
    expect(validateKnowledgeManifest(root).ok).toBe(false)
  })

  it('update.ts 登记链（commitKnowledgeFile）对 null manifest 返报告不抛', () => {
    const root = tempProject()
    writeFileSync(join(root, KNOWLEDGE_MANIFEST), 'null', 'utf-8')
    // 修复前：登记链 read.ok=true 直通 → Array.isArray(null.entries) TypeError 崩
    const report = commitKnowledgeFile(root, { target: '知识层/任一.md' })
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('不是 JSON 对象'))).toBe(true)
  })
})

describe('manifest 条目字段类型守卫', () => {
  it('target:number（{"target":123}）→ validateKnowledgeManifest 报 issue 不抛', () => {
    const root = tempProject()
    writeManifest(root, [{ target: 123, source: 's', license: 'l', sha256: 'sha256:' + 'a'.repeat(64) }])
    // 修复前：isSafeKnowledgeTarget → isAbsolute(123) TypeError 裸崩
    const report = validateKnowledgeManifest(root)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('必须为字符串'))).toBe(true)
  })

  it('sha256:number → 报 issue 不抛（修复前 sha256?.startsWith TypeError）', () => {
    const root = tempProject()
    writeManifest(root, [{ target: '知识层/a.md', source: 's', license: 'l', sha256: 456 }])
    const report = validateKnowledgeManifest(root)
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('必须为字符串'))).toBe(true)
  })

  it('commit 链含坏字段行 → 不抛、manifest 照常落盘（新条目+坏行保留）；0918二轮修复批（G105）起存量坏行不再打回 ok:false', () => {
    const root = tempProject()
    writeManifest(root, [{ target: 123, sha256: 456 }])
    const finalRel = '知识层/定稿.md'
    writeFileSync(join(root, finalRel), '# 定稿正文。\n', 'utf-8')
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})

    // 修复前：登记已落盘，尾部 validateKnowledgeManifest 在坏字段上 TypeError——CLI 报栈但 manifest 实已写入
    // 0918二轮修复批（G105）：存量坏行与新 entry 无关 → ok:true + issues 附带（登记实成功，
    // 重试不再撞「不得重复登记」；此前 ok:false 与盘面矛盾）
    const report = commitKnowledgeFile(root, { target: finalRel, source: 's', license: 'l' })
    expect(report.ok).toBe(true)
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
