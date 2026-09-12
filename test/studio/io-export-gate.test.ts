/**
 * S3（五十九轮）回归：export 端点并发闸。
 *
 * 双击并发 exportBook 互踩（rmSync 导出目录互删 → ENOENT 500）。修复：入口套
 * acquireTaskGate 同款同步占位 + finally 释放，并发第二请求 409。
 * S4 留档：export 内核（src/export/index.ts）仍为全同步 IO——先收并发面，
 * 全量异步化另行批次收口（files.ts 已改 fs/promises，见 files-api-async.test.ts）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio；本地 req 与 harness req 逐字
 * 同形（fetch + token + origin + 条件 content-type），删本地改用 studio.req。
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'

const BOOK = '导出闸测试书'
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-export-gate-',
    // 章节布局对齐 test/export/export.test.ts 的 makeLongBook/writeLongChapter
    // （写作/正文/<num>-<标题>.md + front matter——exportBook 的定稿扫描口径）
    dirs: ['写作/正文'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 导出闸测试书\n  genre: 玄幻\nhost: cc\n',
    files: [{ rel: '写作/正文/1-第一章.md', content: '---\n章号: 1\n标题: 第一章\n---\n雪落在了城墙上。' }],
  })
})

afterAll(() => studio.close())

describe('S3: export 端点并发闸（409 + 释放后可重试）', () => {
  const path = `/api/books/${encodeURIComponent(BOOK)}/export`

  it('闸被持有（并发第二请求）→ 409 BUSY', async () => {
    const release = acquireTaskGate(BOOK, 'export', { lockDir: null })
    expect(release).toBeTruthy()
    try {
      const r = await studio.req('POST', path, { format: 'merged' })
      expect(r.status).toBe(409)
      expect((r.json as { code: string }).code).toBe('BUSY')
    } finally {
      release!()
    }
  })

  it('闸释放后 → 非 409（导出正常执行，业务失败编码在 body.ok）', async () => {
    const r = await studio.req('POST', path, { format: 'merged' })
    expect(r.status).not.toBe(409)
    expect((r.json as { ok: boolean }).ok).toBe(true)
  })
})
