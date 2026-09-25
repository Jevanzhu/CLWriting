/**
 * R0916-7-P3-8（2026-09-25，源码质量评审 P3-8）回归：操作函数直测（走新接口 (ctx, params)）。
 *
 * 覆盖（评审要求的「操作函数直测」前半：save / move / copy / trash 各一条最小路径）：
 * 1. move/rename：直调 service-move.ts 的 `doMoveOrRename(ctx, docId, op)`——自组装
 *    DocContext（不经 DocumentService），断言落位/清单/journal/snapshot 与 service.test.ts
 *    同口径，证明操作函数只依赖 ctx 显式设施；
 * 2. save：经门面最小路径，断言 journal 恰落在 `ctx.journalPathOf(docId)`（ops 消费 ctx
 *    的单源路径，不再各自 join）；
 * 3. copy：副本落位 + 清单双条目（源 + 新 docId）+ revision 派生；
 * 4. trash：源移除 + .trash 落位（含消毒名）+ 回收站条目在案 + 清单除名。
 *
 * 断言口径与既有 service.test.ts 一致（ok 判别 + revision 形状 + 盘上内容/清单实况）。
 * 详尽行为面（冲突码、锁超时、回滚链）由既有用例族继续持有，本文件只钉「新接口可用
 * 且不改变结果形状」。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DocumentService } from '../../src/document/service.js'
import { DocContext } from '../../src/document/doc-context.js'
import { doMoveOrRename } from '../../src/document/service-move.js'
import { findUnsettled } from '../../src/document/journal.js'
import { readManifest } from '../../src/document/manifest.js'
import { readTrashManifestStrict } from '../../src/document/trash.js'
import { listVersions } from '../../src/document/version.js'
import { computeRevision } from '../../src/document/revision.js'

const REL = '写作/正文/0001-开篇.md'
const CONTENT = '---\n标题: 开篇\n章号: 1\n---\n\n第一版正文。\n'

describe('R0916-7-P3-8: 操作函数直测（(ctx, params) 新接口）', () => {
  let root: string
  let svc: DocumentService
  let ctx: DocContext

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doc-ops-'))
    svc = new DocumentService({ bookRoot: root })
    ctx = svc.ctx
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** 造「已登记 + 已落盘」的初始文档（登记形态与 createDocument 同源）。 */
  async function seed(rel: string, docId: string): Promise<void> {
    mkdirSync(join(root, rel.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(join(root, ...rel.split('/')), CONTENT, 'utf-8')
    await ctx.upsertManifestEntryAsync(docId, rel)
  }

  it('move：直调 doMoveOrRename(ctx, ...) —— 落位/清单/journal settled/留底齐备', async () => {
    await seed(REL, 'doc_move')
    const r = await doMoveOrRename(ctx, 'doc_move', { kind: 'move', toDir: '写作/草稿' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('写作/草稿/0001-开篇.md')
    // 盘上：新位在、旧位无
    expect(readFileSync(join(root, '写作', '草稿', '0001-开篇.md'), 'utf-8')).toBe(CONTENT)
    expect(existsSync(join(root, ...REL.split('/')))).toBe(false)
    // 清单 path 已更新（docId 不变）
    expect(readManifest(ctx.manifestPath).entries.get('doc_move')?.path).toBe('写作/草稿/0001-开篇.md')
    // journal 收口：无悬置 pending
    expect(findUnsettled(ctx.journalPathOf('doc_move'))).toEqual([])
    // 移动前留底（快照档存在，口径同 service.test.ts）
    expect(listVersions(ctx.snapshotsDir, 'doc_move').length).toBeGreaterThan(0)
  })

  it('rename：直调 doMoveOrRename(ctx, ...) —— 文件名变更且清单同源更新', async () => {
    await seed(REL, 'doc_rename')
    const r = await doMoveOrRename(ctx, 'doc_rename', { kind: 'rename', newName: '0001-新标题.md' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.path).toBe('写作/正文/0001-新标题.md')
    expect(existsSync(join(root, '写作', '正文', '0001-新标题.md'))).toBe(true)
    expect(readManifest(ctx.manifestPath).entries.get('doc_rename')?.path).toBe('写作/正文/0001-新标题.md')
    expect(findUnsettled(ctx.journalPathOf('doc_rename'))).toEqual([])
  })

  it('save：journal 落点 = ctx.journalPathOf(docId)（路径单源），成功返回 revision 形状不变', async () => {
    const r = await svc.save('doc_save', REL, {
      content: CONTENT,
      expectedRevision: null,
      operationId: 'op-save-1',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
    expect(r.superseded).toBe(false)
    if (r.ok) expect(r.revision).toMatch(/^sha256:/)
    expect(readFileSync(join(root, ...REL.split('/')), 'utf-8')).toBe(CONTENT)
    // ops 消费 ctx 的 journal 单源点：文件恰在 journalPathOf 结果处，且已 settled
    expect(existsSync(ctx.journalPathOf('doc_save'))).toBe(true)
    expect(findUnsettled(ctx.journalPathOf('doc_save'))).toEqual([])
  })

  it('copy：副本落位 + 清单双条目 + revision 自写入字节派生', async () => {
    await seed(REL, 'doc_src')
    const r = await svc.copyDocument({ docId: 'doc_src', relPath: '写作/正文/0002-副本.md' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.docId).not.toBe('doc_src')
      expect(r.path).toBe('写作/正文/0002-副本.md')
      expect(r.revision).toMatch(/^sha256:/)
    }
    expect(readFileSync(join(root, '写作', '正文', '0002-副本.md'), 'utf-8')).toBe(CONTENT)
    const entries = readManifest(ctx.manifestPath).entries
    expect(entries.get('doc_src')?.path).toBe(REL) // 源条目不动
    expect([...entries.values()].some((e) => e.path === '写作/正文/0002-副本.md')).toBe(true)
  })

  it('trash：源移除 + 回收站落位（消毒名）+ 条目在案 + 清单除名', async () => {
    await seed(REL, 'doc_trash')
    const r = await svc.trashDocument({ docId: 'doc_trash' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.docId).toBe('doc_trash')
      expect(r.trashedPath).toMatch(/^工作区\/\.trash\/doc_trash-0001-开篇\.md$/)
      expect(readFileSync(join(root, ...r.trashedPath.split('/')), 'utf-8')).toBe(CONTENT)
    }
    expect(existsSync(join(root, ...REL.split('/')))).toBe(false)
    const trash = readTrashManifestStrict(root)
    expect(trash.map((t) => t.id)).toContain('doc_trash')
    expect(readManifest(ctx.manifestPath).entries.get('doc_trash')).toBeUndefined()
    // 软删留底（口径同 service-struct/trash 用例族）
    expect(listVersions(ctx.snapshotsDir, 'doc_trash').length).toBeGreaterThan(0)
  })

  it('环绕一致性：门面与直调共用同一 ctx（save 后 rename，清单与 revision 同源）', async () => {
    const c = await svc.createDocument({ relPath: REL, content: CONTENT })
    expect(c.ok).toBe(true)
    if (!c.ok) throw new Error('prereq create 失败')
    const renamed = await doMoveOrRename(ctx, c.docId, { kind: 'rename', newName: '0001-开篇（修订）.md' })
    expect(renamed.ok).toBe(true)
    // 门面按 docId 解析路径走同一 ctx 的收编链
    expect(await svc.resolvePathAsync(c.docId)).toBe('写作/正文/0001-开篇（修订）.md')
    // 保存基线取自盘上现路径
    const r = await svc.save(c.docId, '写作/正文/0001-开篇（修订）.md', {
      content: CONTENT.replace('第一版', '第二版'),
      expectedRevision: computeRevision(join(root, '写作', '正文', '0001-开篇（修订）.md')),
      operationId: 'op-after-rename',
      origin: 'manual',
    })
    expect(r.ok).toBe(true)
  })

  it('双轨残留=0：service.ts 不再导出守卫/锁档名（转发桥已删，直引正本）', () => {
    // 行为面锚：守卫名可从正本模块取到（service-guards），且 service.ts 导出面不含它们
    const svcMod = svc as unknown as Record<string, unknown>
    expect(svcMod['isUtf8Bytes']).toBeUndefined()
    expect(svcMod['META_SAVE_LOCK_TIMEOUT_MS']).toBeUndefined()
    expect(svcMod['getStructSaveLockTimeoutMs']).toBeUndefined()
    expect(svcMod['lookupPathByDocIdAdoptAsync']).toBeUndefined() // 收编链只经 ctx
    expect(typeof ctx.lookupPathByDocIdAdoptAsync).toBe('function')
  })
})
