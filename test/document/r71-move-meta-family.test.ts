/**
 * R71-7 / R71-22 / R71-23（十九轮）回归：move/rename 落盘防覆盖 + 章号-only 标题回落
 * + toDir 反斜杠归一。
 *
 * - R71-7：文件落盘改 linkSync 原子探测（EEXIST → ALREADY_EXISTS，无静默覆盖窗口）；
 *   「link 成功、删源前崩溃」的两端同 inode 中间态由 healthCheck 确定性收口（删旧 +
 *   清单对齐 + settled）。
 * - R71-22：updateChapterMeta 只传章号且 fm 缺标题 → 沿用现有文件名标题段，不再吞成
 *   「未命名」；显式传空标题仍走 X-P3a「未命名」兜底。
 * - R71-23：win 侧含 '\' 的 toDir 归一为 '/' 再入清单（R66-5 同族），伪 UNC 拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, linkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { appendMovePending } from '../../src/document/journal.js'
import { detectState } from '../../src/state/state.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'

let bookRoot: string
let svc: DocumentService
let seq = 0

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r71-doc-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

async function createNote(name: string, content = '内容'): Promise<string> {
  const r = await svc.createDocument({ relPath: `笔记/${name}`, content })
  if (!r.ok) throw new Error(`prereq create 失败：${r.reason}`)
  return r.docId
}

function registeredPath(docId: string): string {
  return readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)!.path
}

describe('R71-23: toDir 反斜杠归一', () => {
  it('win 形态反斜杠 toDir → 归一为 / 入清单（清单键与落盘位置 posix 一致）', async () => {
    const name = `反斜杠${seq++}.md`
    const docId = await createNote(name)
    const m = await svc.moveDocument({ docId, toDir: '素材\\子目' })
    expect(m.ok).toBe(true)
    expect(registeredPath(docId)).toBe(`素材/子目/${name}`)
    expect(existsSync(join(bookRoot, '素材', '子目', name))).toBe(true)
    expect(existsSync(join(bookRoot, '笔记', name))).toBe(false)
  })

  it('混合分隔 + 尾斜杠变体归一到同一键；内嵌双反斜杠折叠；前导反斜杠（伪 UNC）拒绝', async () => {
    for (const dirty of ['素材\\', '素材\\\\']) {
      const name = `混合${seq++}.md`
      const docId = await createNote(name)
      const m = await svc.moveDocument({ docId, toDir: dirty })
      expect(m.ok, JSON.stringify(dirty)).toBe(true)
      expect(registeredPath(docId), JSON.stringify(dirty)).toBe(`素材/${name}`)
    }
    // 内嵌双反斜杠 = 两级分隔（与 posix 连续斜杠折叠语义一致）→ 素/材 单级目录
    {
      const name = `混合内嵌${seq++}.md`
      const docId = await createNote(name)
      const m = await svc.moveDocument({ docId, toDir: '素\\\\材' })
      expect(m.ok).toBe(true)
      expect(registeredPath(docId)).toBe(`素/材/${name}`)
      expect(existsSync(join(bookRoot, '素', '材', name))).toBe(true)
    }
    const name = `伪UNC${seq++}.md`
    const docId = await createNote(name)
    const m = await svc.moveDocument({ docId, toDir: '\\\\server\\share' })
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.code).toBe('BAD_INPUT')
    expect(registeredPath(docId)).toBe(`笔记/${name}`)
  })
})

describe('R71-7: move/rename 落盘防覆盖', () => {
  it('正常 move：link+rm 后旧位消失、新位在、清单对齐', async () => {
    const name = `正常${seq++}.md`
    const docId = await createNote(name, '防覆盖内容')
    const m = await svc.moveDocument({ docId, toDir: '归档' })
    expect(m.ok).toBe(true)
    expect(registeredPath(docId)).toBe(`归档/${name}`)
    expect(existsSync(join(bookRoot, '归档', name))).toBe(true)
    expect(existsSync(join(bookRoot, '笔记', name))).toBe(false)
    expect(readFileSync(join(bookRoot, '归档', name), 'utf-8')).toContain('防覆盖内容')
  })

  it('目标已存在 → ALREADY_EXISTS，双方内容原样（不静默覆盖）', async () => {
    const name = `占用${seq++}.md`
    const docId = await createNote(name, '先到者内容')
    mkdirSync(join(bookRoot, '素材'), { recursive: true })
    writeFileSync(join(bookRoot, '素材', name), '占位内容', 'utf-8')
    const m = await svc.moveDocument({ docId, toDir: '素材' })
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.code).toBe('ALREADY_EXISTS')
    // 双方内容原样：源在旧位、目标未被覆盖
    expect(readFileSync(join(bookRoot, '笔记', name), 'utf-8')).toContain('先到者内容')
    expect(readFileSync(join(bookRoot, '素材', name), 'utf-8')).toBe('占位内容')
    expect(registeredPath(docId)).toBe(`笔记/${name}`)
  })

  it('「link 成功、删源前崩溃」两端同 inode → detectState 确定性收口（删旧 + 清单对齐 + settled）', async () => {
    const name = `崩溃${seq++}.md`
    const docId = await createNote(name, '崩溃窗口内容')
    const oldRel = `笔记/${name}`
    const newRel = `素材/${name}`
    // 手工构造 R71-7 引入的中间态：pending 已写、两端同 inode（link 完成、rm 未发生）
    const jPath = join(bookRoot, '工作区', '.journal', `${docId}.jsonl`)
    appendMovePending(jPath, docId, oldRel, newRel)
    mkdirSync(join(bookRoot, '素材'), { recursive: true })
    linkSync(join(bookRoot, oldRel), join(bookRoot, newRel))
    expect(existsSync(join(bookRoot, oldRel))).toBe(true)
    expect(existsSync(join(bookRoot, newRel))).toBe(true)

    const d = detectState(bookRoot, DEFAULT_CONFIG)
    if (d.state === 1) {
      expect(d.issues.some((i) => i.kind === 'crashedWrite')).toBe(false) // 自愈不门禁
    }
    expect(existsSync(join(bookRoot, oldRel))).toBe(false) // 旧位已删
    expect(readFileSync(join(bookRoot, newRel), 'utf-8')).toContain('崩溃窗口内容')
    expect(readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)?.path).toBe(newRel)
  })
})

describe('R71-22: 章号-only 标题回落', () => {
  it('只传章号且 fm 缺标题 → 沿用现有文件名标题段（0001-我的章节 → 0005-我的章节）', async () => {
    // 手建文件（空 fm 无 标题 键——服务端支持章号-only PATCH 的触发形态）
    mkdirSync(join(bookRoot, '笔记'), { recursive: true })
    writeFileSync(join(bookRoot, '笔记', '0001-我的章节.md'), '---\n---\n\n正文。\n', 'utf-8')
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    const m = readManifest(manifestPath)
    const docId = `r71-22-a${seq++}`
    upsertEntry(m, { id: docId, nodeType: 'document', path: '笔记/0001-我的章节.md', parentId: null })
    writeManifest(manifestPath, m)

    const r = svc.updateChapterMeta(docId, { 章号: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('笔记/0005-我的章节.md')
    expect(existsSync(join(bookRoot, '笔记', '0005-我的章节.md'))).toBe(true)
    expect(existsSync(join(bookRoot, '笔记', '0001-我的章节.md'))).toBe(false)
  })

  it('显式传空标题 → X-P3a「未命名」兜底保留', async () => {
    mkdirSync(join(bookRoot, '笔记'), { recursive: true })
    writeFileSync(join(bookRoot, '笔记', '0002-原标题.md'), '---\n---\n\n正文。\n', 'utf-8')
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    const m = readManifest(manifestPath)
    const docId = `r71-22-b${seq++}`
    upsertEntry(m, { id: docId, nodeType: 'document', path: '笔记/0002-原标题.md', parentId: null })
    writeManifest(manifestPath, m)

    const r = svc.updateChapterMeta(docId, { 标题: '', 章号: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('笔记/0003-未命名.md')
  })

  it('fm 有标题 → fm 标题优先于文件名段（与现状一致）', async () => {
    mkdirSync(join(bookRoot, '笔记'), { recursive: true })
    writeFileSync(join(bookRoot, '笔记', '0004-文件名标题.md'), '---\n标题: 正式标题\n---\n\n正文。\n', 'utf-8')
    const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    const m = readManifest(manifestPath)
    const docId = `r71-22-c${seq++}`
    upsertEntry(m, { id: docId, nodeType: 'document', path: '笔记/0004-文件名标题.md', parentId: null })
    writeManifest(manifestPath, m)

    const r = svc.updateChapterMeta(docId, { 章号: 6 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('笔记/0006-正式标题.md')
  })
})
