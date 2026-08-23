/**
 * resolveDraftPath 路径安全测试：标题含路径分隔符时须净化，防 AI 产出越出 bookRoot。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
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

describe('resolveDraftPath W-P2-2 改名旁路防护', () => {
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

  function markFinalized(root: string, rel: string): void {
    mkdirSync(join(root, '项目'), { recursive: true })
    const manifestPath = join(root, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, {
      // 防线只看 finalizedRevision 是否在位，测试用合成指纹即可（文件可能已被改名）
      id: generateDocId(), nodeType: 'document', path: rel, parentId: null,
      finalizedRevision: 'sha256:test-baseline', finalizedAt: new Date().toISOString(),
    })
    writeManifest(manifestPath, m)
  }

  it('定稿章被改名（清单仍挂旧 path）→ 按章号前缀拦截，仍拒绝覆盖', () => {
    const oldRel = writeChapter(bookRoot, 3, '雪夜')
    // 磁盘改名（fm 章号不变 → readChapterDir 仍按章号命中新文件）
    const newRel = '写作/正文/003-雪夜改.md'
    renameSync(join(bookRoot, oldRel), join(bookRoot, newRel))
    markFinalized(bookRoot, oldRel) // 清单登记的是旧 path

    expect(() => resolveDraftPath(bookRoot, 3)).toThrow(/已定稿/)
  })

  it('邻近章号定稿不受牵连：005 定稿不影响写 006', () => {
    const five = writeChapter(bookRoot, 5, '第五章')
    markFinalized(bookRoot, five)
    writeChapter(bookRoot, 6, '第六章') // 磁盘已有第六章草稿（未定稿）

    const r = resolveDraftPath(bookRoot, 6) // 不 throw
    expect(r.existed).toBe(true)
    expect(r.relPath).toContain('006-第六章.md')
  })

  it('章号前缀不误伤跨数量级：5 定稿不影响 50', () => {
    const five = writeChapter(bookRoot, 5, '五')
    markFinalized(bookRoot, five)
    writeChapter(bookRoot, 50, '五十')

    const r = resolveDraftPath(bookRoot, 50)
    expect(r.existed).toBe(true)
  })

  it('RB-KN-P1-2: 清单条目为 4 位补零名（service 重命名产物 0005-x.md）→ 写同章号仍拦截', () => {
    // 磁盘文件按 3 位约定写第 5 章；清单因 service 重命名挂的是 4 位补零 path
    writeChapter(bookRoot, 5, '第五章')
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    const m = readManifest(manifestPath)
    upsertEntry(m, {
      id: generateDocId(), nodeType: 'document', path: '写作/正文/0005-第五章.md', parentId: null,
      finalizedRevision: 'sha256:test-baseline', finalizedAt: new Date().toISOString(),
    })
    writeManifest(manifestPath, m)

    // 修复前：3 位前缀 '005-' 不匹配 4 位名 '0005-' → 防线失守、静默覆盖定稿章
    expect(() => resolveDraftPath(bookRoot, 5)).toThrow(/已定稿/)
    // 数值口径不误伤：写第 6 章不受 0005 条目牵连
    writeChapter(bookRoot, 6, '第六章')
    const r = resolveDraftPath(bookRoot, 6)
    expect(r.existed).toBe(true)
  })
})

// ── R-10（第十六轮）：写章文件名净化上限 ──────────────────────────

describe('resolveDraftPath R-10 文件名净化上限', () => {
  it('超长 emoji 标题 → 文件名合法且有限长（码位/字节双封顶）', () => {
    // 4 字节 emoji × 100 = 100 码位 / 400 字节——远超单段文件名安全预算
    const content = `---\n标题: ${'🔥'.repeat(100)}\n---\n\n正文`
    const { relPath } = resolveDraftPath(bookRoot, 1, content)
    const name = relPath.split('/').pop()!
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(255 - 52) // 留原子写 tmp 余量
    expect(Array.from(name.replace(/\.md$/, '')).length).toBeLessThanOrEqual(64) // 前缀 4 位 + 标题 ≤60 码位
  })

  it('标题含换行等控制字符（块标量多行标题）→ 剥除，文件名单行合法', () => {
    const content = '---\n标题: |\n  第一行\n  第二行\n---\n\n正文'
    const { relPath } = resolveDraftPath(bookRoot, 2, content)
    const name = relPath.split('/').pop()!
    expect(name).not.toMatch(/[\n\r\t\u0000-\u001f]/)
    expect(name).toContain('第一行')
    expect(name.endsWith('.md')).toBe(true)
  })

  it('标题含非法文件名字符（:*?"<>|）→ 替换为下划线', () => {
    const content = '---\n标题: 问?答:是\n---\n\n正文'
    const { relPath } = resolveDraftPath(bookRoot, 3, content)
    const name = relPath.split('/').pop()!
    expect(name).not.toMatch(/[:*?"<>|]/)
  })
})
