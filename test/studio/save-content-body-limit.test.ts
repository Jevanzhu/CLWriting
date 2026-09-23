/**
 * RC 源码重审 B-1（Opus-5.5 轮）回归：正文类写端点的请求体上限。
 *
 * 旧形态：保存端点沿用 readJson 默认 1MB 档——中文正文约 34 万字即 413；而读取/编辑
 * 两侧无上限、前端 dirty-mirror 还专为 >1M 字符文档设了节流档（前后端规模假设不一致）：
 * 作者导入整本旧稿后可开可编辑、却永远存不上，autosave 每拍重传整文再失败。413 又混在
 * BAD_INPUT 里，无「拆分」出路。
 * 修复：正文三端点（documents content PUT / 新建带 content / file PUT）走内容档
 * CONTENT_BODY_LIMIT_BYTES(16MB)；413 单独给码 PAYLOAD_TOO_LARGE 供前端给出路。
 * 本文件钉三件事：①超旧默认档的正文现在存得上；②越过内容档仍是 413 且带专用码；
 * ③前端预检镜像常量与服务端单源等值（防两侧漂移）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { CONTENT_BODY_LIMIT_BYTES } from '../../src/studio/server/http.js'
import { MAX_SAVE_BODY_BYTES } from '../../src/studio/web-next/src/shared/save-limits.js'

const BOOK = '上限测试书'
const MIB = 1024 * 1024
let studio: StudioHarness

beforeAll(async () => {
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-bodylimit-',
    dirs: ['项目'],
    files: [
      {
        rel: '项目/文档清单.jsonl',
        content:
          [
            '{"version":1,"type":"header"}',
            '{"id":"doc_big","nodeType":"document","path":"定稿/正文/0001-大章.md","parentId":null,"status":"draft"}',
          ].join('\n') + '\n',
      },
    ],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 上限测试书\n  genre: 玄幻\nhost: cc\n',
  })
  // 定稿目录需在盘（保存链要求目标文件存在/可建）
  mkdirSync(join(studio.bookRoot, '定稿', '正文'), { recursive: true })
})

afterAll(() => studio.close())

function putContent(content: string): Promise<{ status: number; json: unknown }> {
  return studio.req('PUT', `/api/books/${encodeURIComponent(BOOK)}/documents/doc_big/content`, {
    content,
    expectedRevision: null,
    operationId: `op-${content.length}`,
    origin: 'manual',
  })
}

describe('RC 源码重审 B-1：正文保存请求体上限', () => {
  it('约 1.2MB 中文正文可保存（旧 1MB 默认档下必 413 的规模）', async () => {
    // 中文 3 字节/字：40 万字 ≈ 1.2MB —— 恰是评审点名的「>35 万字存不上」面
    const content = '正'.repeat(400_000)
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(MIB)
    const r = await putContent(content)
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
  })

  it('越过内容档（>16MB）→ 413 且码为专用 PAYLOAD_TOO_LARGE（不再混同 BAD_INPUT）', async () => {
    const content = 'x'.repeat(CONTENT_BODY_LIMIT_BYTES + 4096)
    const r = await putContent(content)
    expect(r.status).toBe(413)
    const j = r.json as { code?: string; error?: string }
    expect(j.code).toBe('PAYLOAD_TOO_LARGE')
    expect(j.error).toBe('请求体过大')
  })

  it('前端预检镜像常量与服务端单源等值（改单边即红）', () => {
    expect(MAX_SAVE_BODY_BYTES).toBe(CONTENT_BODY_LIMIT_BYTES)
  })
})
