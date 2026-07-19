import { describe, it, expect } from 'vitest'
import { ulid, generateDocId, generateFolderId, legacyId } from '../../src/document/stable-id.js'

// Crockford base32 字母表（0-9 + A-Z 剔除 I/L/O/U）
const CROCK = '[0-9A-HJKMNP-TV-Z]'

describe('stable-id', () => {
  it('ulid 是 26 字符 Crockford base32', () => {
    const id = ulid()
    expect(id).toHaveLength(26)
    expect(id).toMatch(new RegExp(`^${CROCK}{26}$`))
  })

  it('generateDocId 带 doc_ 前缀 + 26 ULID', () => {
    expect(generateDocId()).toMatch(new RegExp(`^doc_${CROCK}{26}$`))
  })

  it('generateFolderId 带 folder_ 前缀 + 26 ULID', () => {
    expect(generateFolderId()).toMatch(new RegExp(`^folder_${CROCK}{26}$`))
  })

  it('ulid 不含易混淆字符 I/L/O/U', () => {
    for (let i = 0; i < 100; i++) {
      expect(ulid()).not.toMatch(/[ILOU]/)
    }
  })

  it('唯一性：连续生成 1000 个不重复', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(generateDocId())
    expect(ids.size).toBe(1000)
  })

  it('ulid 时间单调（跨毫秒字符串排序递增）', async () => {
    const a = ulid()
    await new Promise((r) => setTimeout(r, 2))
    const b = ulid()
    expect(b > a).toBe(true)
  })

  it('legacyId 同路径同结果（确定性）', () => {
    expect(legacyId('大纲/总纲.md')).toBe(legacyId('大纲/总纲.md'))
  })

  it('legacyId 不同路径不同结果', () => {
    expect(legacyId('a')).not.toBe(legacyId('b'))
  })

  it('legacyId 格式：legacy: + 16 hex', () => {
    expect(legacyId('x')).toMatch(/^legacy:[0-9a-f]{16}$/)
  })
})
