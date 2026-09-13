/**
 * 重评-0912-4 P2-1（2026-09-12 全量重评修复批）回归：draft-save per-book 串行链
 * + 删书排水清单收编 + bookMovedFailure 重验。
 *
 * 修复前：draft-save 端点游离于全部排水闸之外——删书排水清单（busyGate → abort →
 * awaitOrchestrationsSettled → drainDocumentSaves → drainFilePutChainsUnder →
 * drainForeshadowSaveChains）不含 draft-save 链，在途/迟到 draft-save 跨墓地 rename
 * 落地，saveDraft 的 mkdirSync(recursive) 按旧书路径重建幽灵目录树并返 200（内容不
 * 属于任何书）；readJson await 窗内书被删/改名亦无重验（stale 客户端续存旧键）。
 * 修复后：per-book Promise 链（files.ts filePutChains R69-25/R70-6 同款范式）+
 * drainDraftSaveChainsUnder 进删书/改名排水段 + 链内临界段 bookMovedFailure 单源重验。
 * 顺带锚定 P1-1 同族口径：GBK 存量章 draft-save → 400 NOT_UTF8_TARGET（不再 generic
 * 500「落盘失败」）。
 */
import { existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { acquireCrossProcessLockAsync } from '../../src/fs/cross-process-lock.js'
import { __draftSaveChainKeysForTest } from '../../src/studio/server/api/draft.js'
import { legacyId } from '../../src/document/stable-id.js'
import { encodeDocDirName } from '../../src/document/version.js'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '草稿竞态测试书'
/** GBK「你好」——非 UTF-8 存量形态 */
const GBK = Buffer.from([0xc4, 0xe3, 0xba, 0xc3])
let studio: StudioHarness

function postDraft(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/draft-save`, {
    method: 'POST',
    headers: { 'x-studio-token': studio.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }))
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r0912-4-draftdrain-',
    dirs: ['写作/正文/第一卷', '工作区'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 草稿竞态测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(() => studio.close())

describe('重评-0912-4 P2-1: draft-save 串行链与删书排水', () => {
  it('P1-1 同族：GBK 存量章 draft-save → 400 NOT_UTF8_TARGET（透传转码指引）', async () => {
    const rel = '写作/正文/第一卷/0003-第3章.md'
    writeFileSync(join(studio.bookRoot, rel), GBK)
    const r = await postDraft({ chapter: 3, content: 'AI 生成的新章稿。' })
    expect(r.status).toBe(400)
    expect(r.json['code']).toBe('NOT_UTF8_TARGET')
    expect(String(r.json['error'])).toContain('转码为 UTF-8')
    // 盘上字节原样（保存被拒绝，未覆盖）
    expect(readFileSync(join(studio.bookRoot, rel))).toEqual(GBK)
  })

  it('在途 draft-save（save 锁被占）在链上可见；删书 drain 等待其收尾，零幽灵残留', async () => {
    // 占住 per-doc 保存锁（executeSave R72-1 / saveDraft R73-32 同键）→ draft-save
    // 在 saveDraft 锁等待处悬置 = 「在途保存」的确定性装置
    const rel = '写作/正文/第一卷/0002-第2章.md'
    const docId = legacyId(rel)
    const jPath = join(studio.bookRoot, '工作区', '.journal', `${encodeDocDirName(docId)}.jsonl`)
    const release = await acquireCrossProcessLockAsync(`${jPath}.save.lock`, 100)
    expect(release).not.toBeNull()

    let saveSettled = false
    const saveP = postDraft({ chapter: 2, content: '竞态窗内的保存。' }).then((r) => {
      saveSettled = true
      return r
    })
    // 链注册可见（files.ts __filePutChainKeysForTest 同款观测面）
    await vi.waitFor(() => {
      expect([...__draftSaveChainKeysForTest()]).toContain(studio.bookRoot)
    })

    let delSettled = false
    const delP = studio.req('DELETE', `/api/books/${encodeURIComponent(BOOK)}`).then((r) => {
      delSettled = true
      return r
    })
    await new Promise((r) => setTimeout(r, 400))
    // 删书被 drainDraftSaveChainsUnder 拦下等待（修复前此处直接 rename，draft-save
    // 随后 mkdirSync 重建幽灵目录树并返 200）
    expect(delSettled).toBe(false)
    expect(saveSettled).toBe(false)

    release!()
    const saveRes = await saveP
    expect(saveRes.status).toBe(200) // 删书未推进，保存正常落盘
    expect(saveRes.json['ok']).toBe(true)
    const delRes = await delP
    expect(delRes.status).toBe(200)
    expect(delSettled).toBe(true)

    // 删书收口：书目录已入墓地，workDir 顶层无旧书路径残留（幽灵目录零残留）
    expect(existsSync(studio.bookRoot)).toBe(false)
    expect(existsSync(join(studio.workDir, BOOK))).toBe(false)
  })

  it('书已删后 draft-save → 入口 404（resolveBook 守卫，不写旧键）', async () => {
    const r = await postDraft({ chapter: 9, content: '对已删书的迟到保存。' })
    expect(r.status).toBe(404)
    expect(existsSync(join(studio.workDir, BOOK))).toBe(false)
  })
})
