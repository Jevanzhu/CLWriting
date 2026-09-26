/**
 * 知识层登记 fm 注入的行尾/BOM 保真：injectFrontMatterKeys 宿主规范形。
 *
 * 档源：原 r40-knowledge.test.ts 的 R40-17 组（同文件 R40-16 登记判重折叠组
 * 另拆 commit-dedup-casefold.test.ts）。
 *
 * R40-17（四十轮）：CRLF 宿主注入后不再混排、BOM 宿主不再静默丢 BOM
 * （joinFrontMatter R39-10 + BOM 记账补回）——批一翻转后的保真契约。
 */
import { describe, expect, it, afterEach } from 'vitest'
import { rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { commitKnowledgeFile } from '../../src/knowledge/update.js'
import { KNOWLEDGE_MANIFEST } from '../../src/knowledge/manifest.js'

const dirs: string[] = []
function tempProject(): string {
  const d = mkdtempTracked(join(tmpdir(), 'knowledge-fm-fidelity-'))
  dirs.push(d)
  mkdirSync(join(d, '知识层'), { recursive: true })
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function writeManifest(root: string, entries: unknown[]): void {
  writeFileSync(
    join(root, KNOWLEDGE_MANIFEST),
    JSON.stringify({ version: 1, generated_at: '2026-01-01T00:00:00+08:00', entries }),
    'utf-8',
  )
}

describe('fm 注入行尾/BOM 规范形（批一翻转）', () => {
  it('CRLF 无 fm 宿主 → 注入后整文件归一 LF（保真契约翻转）', () => {
    const root = tempProject()
    writeManifest(root, [])
    const fp = join(root, '知识层', 'x.md')
    writeFileSync(fp, '第一段正文。\r\n\r\n第二段正文。\r\n', 'utf-8')
    const r = commitKnowledgeFile(root, { target: '知识层/x.md', source: 's', license: 'l' })
    expect(r.ok).toBe(true)
    const after = readFileSync(fp, 'utf-8')
    expect(after.startsWith('---')).toBe(true) // fm 注入在位
    expect(after.includes('source: s')).toBe(true)
    expect(after.includes('\r')).toBe(false) // 规范形：无 \r 残留
  })

  it('BOM 宿主 → 注入后 BOM 剥除（写侧规范形，读侧容忍不变）', () => {
    const root = tempProject()
    writeManifest(root, [])
    const fp = join(root, '知识层', 'y.md')
    writeFileSync(fp, '\uFEFF带 BOM 的正文。', 'utf-8')
    const r = commitKnowledgeFile(root, { target: '知识层/y.md', source: 's', license: 'l' })
    expect(r.ok).toBe(true)
    const after = readFileSync(fp, 'utf-8')
    expect(after.includes('\uFEFF')).toBe(false) // BOM 随规范形写回收口剥除
    expect(after.startsWith('---')).toBe(true) // fm 注入在位
  })

  it('LF 无 BOM 宿主 → 逐字节形态不变（无 \\r 引入）', () => {
    const root = tempProject()
    writeManifest(root, [])
    const fp = join(root, '知识层', 'z.md')
    writeFileSync(fp, '---\n场景: 战斗\n---\n\n既有 fm 正文。\n', 'utf-8')
    const r = commitKnowledgeFile(root, { target: '知识层/z.md', source: 's2', license: 'l2' })
    expect(r.ok).toBe(true)
    const after = readFileSync(fp, 'utf-8')
    expect(after.includes('\r')).toBe(false)
    expect(after.includes('场景: 战斗')).toBe(true) // 既有键保留
    expect(after.includes('source: s2')).toBe(true) // 新键注入
  })
})
