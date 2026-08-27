/**
 * R66-5（十四轮）：move 的 toDir 入层归一回归。
 *
 * 脏输入（尾单斜杠/尾双斜杠/中间双斜杠）必须归一到同一 manifest 键——原实现只剥
 * 一个尾斜杠，`写作/正文//` 会把 `写作/正文//0001-x.md` 记入清单造成目录身份分裂
 * （该文档永久 REVISION_CONFLICT + finalizedPathSet 失配）。前导 `/` 与空目录拒绝。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentService } from '../../src/document/service.js'
import { readManifest } from '../../src/document/manifest.js'

let bookRoot: string
let svc: DocumentService
let seq = 0

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'clw-r66-5-'))
  mkdirSync(join(bookRoot, '工作区'), { recursive: true })
  svc = new DocumentService({ bookRoot })
})

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true })
})

/** 造一个笔记文档，返回 docId（每个用例内文件名唯一，避免目标冲突） */
async function createNote(name: string): Promise<string> {
  const r = await svc.createDocument({ relPath: `笔记/${name}`, content: `内容-${name}` })
  if (!r.ok) throw new Error(`prereq create 失败：${r.reason}`)
  return r.docId
}

/** 读清单里该 docId 的登记路径 */
function registeredPath(docId: string): string {
  return readManifest(join(bookRoot, '项目', '文档清单.jsonl')).entries.get(docId)!.path
}

describe('R66-5: move toDir 归一（脏输入单键 + 前导斜杠拒绝）', () => {
  it('尾单斜杠/尾双斜杠 → 归一到同一路径（清单键与落盘位置一致）', async () => {
    for (const dirty of ['素材', '素材/', '素材//']) {
      const name = `原位${seq++}.md`
      const docId = await createNote(name)
      const m = await svc.moveDocument({ docId, toDir: dirty })
      expect(m.ok, dirty).toBe(true)
      // 归一后清单键唯一：全部脏变体落同一个 素材/<name>（旧实现 素材// 会记 素材//<name>）
      expect(registeredPath(docId), dirty).toBe(`素材/${name}`)
      expect(existsSync(join(bookRoot, '素材', name)), dirty).toBe(true)
      expect(existsSync(join(bookRoot, '笔记', name)), dirty).toBe(false)
    }
  })

  it('中间双斜杠折叠为单斜杠（素//材 是 素/材 的脏写法，非 素材）', async () => {
    const name = `折叠${seq++}.md`
    const docId = await createNote(name)
    const m = await svc.moveDocument({ docId, toDir: '素//材' })
    expect(m.ok).toBe(true)
    expect(registeredPath(docId)).toBe(`素/材/${name}`) // 折叠不吞并目录层级
    expect(existsSync(join(bookRoot, '素', '材', name))).toBe(true)
  })

  it('前导斜杠拒绝（BAD_INPUT，文件不动、清单不换键）', async () => {
    const name = `前导${seq++}.md`
    const docId = await createNote(name)
    const m = await svc.moveDocument({ docId, toDir: '/素材' })
    expect(m.ok).toBe(false)
    if (!m.ok) expect(m.code).toBe('BAD_INPUT')
    expect(registeredPath(docId)).toBe(`笔记/${name}`)
    expect(existsSync(join(bookRoot, '笔记', name))).toBe(true)
  })

  it('空串与纯斜杠拒绝（BAD_INPUT，文件不动）', async () => {
    for (const dirty of ['', '//', '///']) {
      const name = `空串${seq++}.md`
      const docId = await createNote(name)
      const m = await svc.moveDocument({ docId, toDir: dirty })
      expect(m.ok, JSON.stringify(dirty)).toBe(false)
      if (!m.ok) expect(m.code, JSON.stringify(dirty)).toBe('BAD_INPUT')
      expect(existsSync(join(bookRoot, '笔记', name)), JSON.stringify(dirty)).toBe(true)
    }
  })

  it('脏输入归一后等于当前目录 → 幂等 ok 不产生畸形键', async () => {
    const name = `幂等${seq++}.md`
    const docId = await createNote(name)
    // 旧实现：'笔记//' 只剥一个尾斜杠 → newPath '笔记//<name>' ≠ oldPath → 真实移动到畸形键
    const m = await svc.moveDocument({ docId, toDir: '笔记//' })
    expect(m.ok).toBe(true)
    if (m.ok) expect(m.path).toBe(`笔记/${name}`)
    expect(registeredPath(docId)).toBe(`笔记/${name}`)
    expect(existsSync(join(bookRoot, '笔记', name))).toBe(true)
  })
})
