/**
 * 重评二轮-P3-1（2026-09-13 全库源码重评二轮 GLM-5.3）：snapshots restore 的
 * readJson 窗口后写前书注册重验（config.ts:99 家族 / R0911-B-P3-4 同型防线）。
 *
 * 竞态时序：restore 入口 resolveDoc/readVersionRaw 在 readJson 之前完成（快照
 * 内容已进内存），await readJson(req) 的窗口可跨过 books.ts 删书/改名时点——修复
 * 前对旧捕获 bookRoot 调 save，保存锁获取会在旧路径 mkdir 复活幽灵目录骨架；
 * 修复后 bookMovedFailure 重验 409 BOOK_MOVED 拒写保旧。
 *
 * 手法（复审-0914-修复批 P3-R3-3 记正）：原版用「80ms 悬持 body + 40ms 中途改名」
 * 的真实竞态 timer 复现——可绿但时序脆。现改用产品侧测试注入口
 * __setSnapshotsRestoreYieldForTest（先例 __setLearnCommitYieldForTest）在 readJson
 * 前确定性停走：钩子 parked 信号到手后直接改写 books.jsonl + renameSync 搬书
 * （books.ts 改名完成态模拟），放行即 409，零 timer。对照组：不搬书的 restore
 * 照常 200。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { __setSnapshotsRestoreYieldForTest } from '../../src/studio/server/api/snapshots.js'

const BOOK = '快照重验书'
const NEW_NAME = '快照重验书乙'
const CHAPTER = '写作/正文/0001-开篇.md'
let studio: StudioHarness

function api(p: string): string {
  return `/api/books/${encodeURIComponent(BOOK)}${p}`
}

function save(content: string, expectedRevision: string | null, op: string) {
  return studio.req('PUT', api('/documents/doc_1/content'), {
    content,
    expectedRevision,
    operationId: op,
    origin: 'manual',
  })
}

async function revisionOf(r: { json: unknown }): Promise<string> {
  return (r.json as { revision: string }).revision
}

/** 当前盘面 revision；正文未建时返回 null（首存走建档语义）——用例顺序无关
 *  （复审-0914-修复批 P3-R3-4：原版对缺文件硬算 revision，单独跑第二用例即抛）。 */
async function currentRevision(): Promise<string | null> {
  const p = join(studio.bookRoot, CHAPTER)
  if (!existsSync(p)) return null
  const { computeRevision } = await import('../../src/document/revision.js')
  return computeRevision(p)
}

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-snap-bm-',
    dirs: ['项目'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 快照重验书\n  genre: 玄幻\nhost: cc\n',
    files: [
      {
        rel: '项目/文档清单.jsonl',
        content:
          [
            '{"version":1,"type":"header"}',
            `{"id":"doc_1","nodeType":"document","path":"${CHAPTER}","parentId":null,"status":"draft"}`,
          ].join('\n') + '\n',
      },
    ],
  })
})

afterAll(() => studio.close())

describe('重评二轮-P3-1: snapshots restore readJson 窗口书注册重验', () => {
  it('对照组：不搬书 → restore 200 且正文回到快照版（重验不改变成功路径语义）', async () => {
    const v1 = await save('对照组第一版', null, 'ctrl-op1')
    expect(v1.status).toBe(200)
    const v2 = await save('对照组第二版', await revisionOf(v1), 'ctrl-op2')
    expect(v2.status).toBe(200)
    const list = await studio.req('GET', api('/documents/doc_1/snapshots'))
    const id = (list.json as { entries: { id: string }[] }).entries[0]!.id

    const r = await studio.req('POST', api(`/documents/doc_1/snapshots/${id}/restore`), {
      expectedRevision: await revisionOf(v2),
    })
    expect(r.status).toBe(200)
    expect(readFileSync(join(studio.bookRoot, CHAPTER), 'utf-8')).toBe('对照组第一版')
  })

  it('readJson 窗口内书被改名 → 409 BOOK_MOVED，旧路径无幽灵目录、新路径内容保旧', async () => {
    const v1 = await save('窗口第一版', await currentRevision(), 'win-op1')
    expect(v1.status).toBe(200)
    const v2 = await save('窗口第二版', await revisionOf(v1), 'win-op2')
    expect(v2.status).toBe(200)
    const list = await studio.req('GET', api('/documents/doc_1/snapshots'))
    const id = (list.json as { entries: { id: string }[] }).entries[0]!.id

    // 确定性停走：钩子进入即发 parked 信号，unpark 前 handler 悬在 readJson 前
    let unpark!: () => void
    const parked = new Promise<void>((resolveParked) => {
      __setSnapshotsRestoreYieldForTest(() => {
        const gate = new Promise<void>((resolveGate) => {
          unpark = resolveGate
        })
        resolveParked()
        return gate
      })
    })
    const restore = studio.req('POST', api(`/documents/doc_1/snapshots/${id}/restore`), {
      expectedRevision: await revisionOf(v2),
    })
    try {
      await parked
      // books.ts 改名完成态模拟：登记换新名 + 目录搬走
      writeFileSync(
        join(studio.workDir, '.clwriting', 'books.jsonl'),
        JSON.stringify({ name: NEW_NAME, path: NEW_NAME, kind: 'long' }) + '\n',
        'utf-8',
      )
      renameSync(studio.bookRoot, join(studio.workDir, NEW_NAME))
    } finally {
      __setSnapshotsRestoreYieldForTest(null)
      unpark()
    }

    const r = await restore
    expect(r.status).toBe(409)
    expect((r.json as { code: string }).code).toBe('BOOK_MOVED')
    // 旧 bookRoot 不得被 save 的保存锁 mkdir 复活
    expect(existsSync(studio.bookRoot)).toBe(false)
    // 新路径正文仍是第二版（快照恢复未发生、原内容随目录迁移无损）
    expect(readFileSync(join(studio.workDir, NEW_NAME, CHAPTER), 'utf-8')).toBe('窗口第二版')
  })
})
