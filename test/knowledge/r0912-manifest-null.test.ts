/**
 * R0912-G1-P2-1（2026-09-12 独立重评修复批）回归：知识层 manifest 写成字面 null
 * （手编/半写形态）时不再以 ok:true 放行——此前 JSON.parse(null) 成功直通 ok，
 * validateKnowledgeManifest 的 manifest.version 与 update.ts 登记链的
 * manifest.entries 在 null 上裸 TypeError 崩。修后：读/校验/登记链全部返回
 * ok:false 报告，不抛。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readKnowledgeManifest, validateKnowledgeManifest, KNOWLEDGE_MANIFEST } from '../../src/knowledge/manifest.js'
import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

function nullManifestProject(manifestText: string): string {
  const root = mkdtempTracked(join(tmpdir(), 'r0912-knowledge-null-'))
  mkdirSync(join(root, '知识层'), { recursive: true })
  writeFileSync(join(root, KNOWLEDGE_MANIFEST), manifestText, 'utf-8')
  return root
}

describe('R0912-G1-P2-1: manifest 字面 null / 非对象形状守卫', () => {
  it('manifest 写 literal null → readKnowledgeManifest/validateKnowledgeManifest 返 ok:false 不抛', () => {
    const root = nullManifestProject('null')
    const read = readKnowledgeManifest(root)
    expect(read.ok).toBe(false)
    expect(read.issues.some((i) => i.message.includes('不是 JSON 对象'))).toBe(true)
    // 修复前：read.ok=true 放行 null → validate 在 manifest.version 处 TypeError
    const validated = validateKnowledgeManifest(root)
    expect(validated.ok).toBe(false)
    expect(validated.issues.some((i) => i.message.includes('不是 JSON 对象'))).toBe(true)
  })

  it('manifest 写标量（123）同守卫 → ok:false 不抛', () => {
    const root = nullManifestProject('123')
    expect(readKnowledgeManifest(root).ok).toBe(false)
    expect(validateKnowledgeManifest(root).ok).toBe(false)
  })

  it('update.ts 登记链（commitKnowledgeFile）对 null manifest 返报告不抛', () => {
    const root = nullManifestProject('null')
    // 修复前：登记链 read.ok=true 直通 → Array.isArray(null.entries) TypeError 崩
    const report = commitKnowledgeFile(root, { target: '知识层/任一.md' })
    expect(report.ok).toBe(false)
    expect(report.issues.some((i) => i.message.includes('不是 JSON 对象'))).toBe(true)
  })
})
