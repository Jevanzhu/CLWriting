/**
 * R67-12（十五轮）：readVersionMeta 头部读取上限 4KB → 64KB 回归。
 *
 * 超长 frontmatter（异常长的「原因」等字段）跨过 4KB 边界时闭合 --- 落在读取窗外，
 * splitFrontMatter 失败 → 整版本被静默跳过（列版本缺条/去重/prune 失明）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeVersion, listVersions, readVersionMeta } from '../../src/document/version.js'

let dir: string
const docId = 'doc_r67_12'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clw-r67-12-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('R67-12: 超长 frontmatter 版本不被静默跳过', () => {
  it('fm 超 4KB（原因 ~5KB）→ readVersionMeta 可读、listVersions 不缺条', () => {
    const longReason = '守'.repeat(5_000) // 15KB UTF-8 字节，稳跨旧 4KB 窗
    const id = writeVersion(dir, docId, '正文内容', { origin: 'manual', reason: longReason })
    expect(id).not.toBeNull()

    const meta = readVersionMeta(dir, docId, id!)
    expect(meta).not.toBeNull() // 旧实现：head 截断 → splitFrontMatter 失败 → null
    expect(meta!.meta.origin).toBe('manual')

    const list = listVersions(dir, docId)
    expect(list.length).toBe(1) // 旧实现：列版本静默缺条
  })

  it('常规 fm（<4KB）行为守恒', () => {
    const id = writeVersion(dir, docId, '常规正文', { origin: 'ai', reason: '节流留底' })
    expect(readVersionMeta(dir, docId, id!)!.meta.origin).toBe('ai')
    expect(listVersions(dir, docId).length).toBe(1)
  })
})
