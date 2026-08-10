/**
 * resolveDraftPath 路径安全测试：标题含路径分隔符时须净化，防 AI 产出越出 bookRoot。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveDraftPath } from '../../src/format/draft.js'

let bookRoot: string

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-draft-'))
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

describe('resolveDraftPath 标题净化', () => {
  it('标题含正斜杠 → 替换为下划线', () => {
    const content = '---\n标题: evil/path\n---\n\n正文'
    const { relPath } = resolveDraftPath(bookRoot, 1, content)
    expect(relPath).not.toContain('evil/path')
    expect(relPath).toContain('evil_path')
  })

  it('标题含反斜杠 → 替换为下划线', () => {
    const content = '---\n标题: evil\\path\n---\n\n正文'
    const { relPath } = resolveDraftPath(bookRoot, 1, content)
    expect(relPath).not.toContain('evil\\path')
  })

  it('标题含 ../ 序列 → 不构成路径穿越', () => {
    const content = '---\n标题: ../../../etc/passwd\n---\n\n正文'
    const { relPath } = resolveDraftPath(bookRoot, 1, content)
    // 所有 / 已被替换为 _，不会越出 bookRoot
    expect(relPath).not.toContain('../')
    expect(relPath).not.toContain('..%2F')
  })

  it('正常标题不受影响', () => {
    const content = '---\n标题: 初入江湖\n---\n\n正文'
    const { relPath } = resolveDraftPath(bookRoot, 1, content)
    expect(relPath).toContain('001-初入江湖.md')
  })

  it('无标题 → 默认 第N章', () => {
    const { relPath } = resolveDraftPath(bookRoot, 42)
    expect(relPath).toContain('042-第42章.md')
  })
})
