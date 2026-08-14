/**
 * resolveDraftPath 路径安全测试：标题含路径分隔符时须净化，防 AI 产出越出 bookRoot。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveDraftPath } from '../../src/format/draft.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { computeRevision } from '../../src/document/revision.js'

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

describe('resolveDraftPath V-P1-3 定稿防护', () => {
  function writeChapter(root: string, num: number, title: string): string {
    mkdirSync(join(root, '写作', '正文'), { recursive: true })
    const rel = `写作/正文/${String(num).padStart(3, '0')}-${title}.md`
    writeFileSync(
      join(root, rel),
      `---\n章号: ${num}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n正文。`,
      'utf-8',
    )
    return rel
  }

  it('同章号文件已定稿 → 拒绝覆盖（throw，防静默摧毁定稿）', () => {
    const rel = writeChapter(bookRoot, 3, '雪夜')
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, {
      id: generateDocId(), nodeType: 'document', path: rel, parentId: null,
      finalizedRevision: computeRevision(join(bookRoot, rel)), finalizedAt: new Date().toISOString(),
    })
    writeManifest(manifestPath, m)

    expect(() => resolveDraftPath(bookRoot, 3)).toThrow(/已定稿/)
  })

  it('同章号文件未定稿（草稿续写）→ 照常返回覆盖路径', () => {
    writeChapter(bookRoot, 3, '雪夜') // 无清单 → 无定稿信息可依，维持旧行为
    const r = resolveDraftPath(bookRoot, 3)
    expect(r.existed).toBe(true)
    expect(r.relPath).toBe('写作/正文/003-雪夜.md')
  })
})
