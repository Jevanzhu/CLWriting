/**
 * RC 源码重审 A-5（Opus-5.5 轮）跨层回归：留底降级不阻断正文保存，且降级事实能到达调用方。
 *
 * 服务端 executeSave 的留底（maybeSnapshot）已改 fail-open（`.版本` 不可写 → warn +
 * snapshotDegraded 旗，正文照常落盘）。本用例走真实 HTTP：钉住端点契约——健康路径
 * 200 且响应不带该字段（信封形状零改动）；`.版本` 坏掉时**仍 200**、响应带
 * snapshotDegraded:true、盘上正文已更新（旧形态：500/WRITE_ERROR 且正文一字未写）。
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { computeRevision } from '../../src/document/revision.js'
import { VERSIONS_DIR_NAME } from '../../src/document/version.js'

const BOOK = '留底降级测试书'
const DOC = 'doc_deg'
const REL = '写作/正文/0001-开篇.md'
const OLD = '---\n标题: 开篇\n章号: 1\n---\n旧正文'
const NEW = '---\n标题: 开篇\n章号: 1\n---\n新正文'
const NEWER = '---\n标题: 开篇\n章号: 1\n---\n更新正文'

let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-a5-',
    dirs: ['项目'],
    files: [
      {
        rel: '项目/文档清单.jsonl',
        content:
          [
            '{"version":1,"type":"header"}',
            `{"id":"${DOC}","nodeType":"document","path":"${REL}","parentId":null,"status":"draft"}`,
          ].join('\n') + '\n',
      },
      { rel: REL, content: OLD },
    ],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 留底降级测试书\n  genre: 玄幻\nhost: cc\n',
  })
})
afterAll(() => studio.close())

function put(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  return studio.req('PUT', `/api/books/${encodeURIComponent(BOOK)}/documents/${encodeURIComponent(DOC)}/content`, body)
}

describe('A-5 跨层：content PUT 的留底降级信封', () => {
  it('对照：.版本 健康 → 200 且响应不含 snapshotDegraded', async () => {
    const abs = join(studio.bookRoot, REL)
    const r = await put({
      content: NEW,
      expectedRevision: computeRevision(abs),
      operationId: 'op-a5-ok',
      origin: 'manual',
    })
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; revision: string; snapshotDegraded?: boolean }
    expect(j.ok).toBe(true)
    expect(j.revision).toMatch(/^sha256:/)
    expect(j.snapshotDegraded).toBeUndefined() // 信封形状零改动：仅降级时才带
    expect(readFileSync(abs, 'utf-8')).toBe(NEW)
  })

  it('.版本 是普通文件（不可写）→ 仍 200 + snapshotDegraded:true + 正文落盘', async () => {
    // 工作区/.版本 做成普通文件 → mkdir 必败（对齐 test/process/save-draft-guard.test.ts 装置）；
    // 上一笔健康保存已建出真目录，先移除再占位（等价于「目录被同步盘锁死/被文件顶掉」）
    const versionsDir = join(studio.bookRoot, '工作区', VERSIONS_DIR_NAME)
    rmSync(versionsDir, { recursive: true, force: true })
    mkdirSync(join(studio.bookRoot, '工作区'), { recursive: true })
    writeFileSync(versionsDir, 'not-a-dir')

    const abs = join(studio.bookRoot, REL)
    const r = await put({
      content: NEWER,
      expectedRevision: computeRevision(abs),
      operationId: 'op-a5-deg',
      origin: 'manual',
    })
    expect(r.status).toBe(200) // 修复点：旧形态此处 500 WRITE_ERROR（正文一字未写）
    const j = r.json as { ok: boolean; revision: string; snapshotDegraded?: boolean }
    expect(j.ok).toBe(true)
    expect(j.snapshotDegraded).toBe(true)
    expect(readFileSync(abs, 'utf-8')).toBe(NEWER)
  })
})
