/**
 * R66-26 / R66-27（十四轮）回归：analysis 端点读盘守卫。
 *
 * R66-26：analyze 端点 sourceHash 与进 prompt 正文分两次读盘（readDraft 一读 +
 * sourceHashOf(readFileSync) 二读），两读间保存会让 body 与 hash 对应不同稿；
 * 且第二次 readFileSync 无守卫，existsSync 后竞态删除的 ENOENT 裸穿 dispatch。
 * 修复：单次读取取 buffer，readDraft 经 content 吃同一快照；读失败转人话 500 IO。
 * （hash 与正文同源的竞态行为面已由 source-hash-race.test.ts 锚定，此处锚守卫。）
 *
 * R66-27：analysis-overview 的 readdirSync 无守卫（existsSync 后目录被移/占位
 * 抛 ENOTDIR/ENOENT 裸穿 500）。修复：读失败降级空趋势。
 *
 * 复现方式：µs 级竞态无法从外部稳定命中，用「路径被目录占位 / 分析目录是文件」
 * 制造 existsSync 命中 + read 必抛的稳定形态（同型于 review.ts R64-10 守卫口径）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '读稿守卫测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-r66-26-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 读稿守卫测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  )
  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = (await (await fetch(`${baseUrl}/api/boot`)).json()) as { token: string }
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

/** 登记一个 manifest 文档条目，返回 docId */
function registerDoc(relPath: string): string {
  const bookRoot = join(workDir, BOOK)
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  const docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: relPath, parentId: null })
  writeManifest(manifestPath, m)
  return docId
}

describe('R66-26: analyze 端点单次读盘 + 读稿守卫', () => {
  it('正文路径被目录占位（existsSync true + read 必抛）→ 人话 500 IO，不裸穿', async () => {
    // 0002-占位.md 建成目录：resolveDocEntry/existsSync 命中，readFileSync 抛 EISDIR
    // ——稳定复现 existsSync→read 间读失败形态。修复前：readDraft 先吃到目录
    // 返回 NOT_CHAPTER 400（或第二次 readFileSync EISDIR 裸穿 500）；修复后统一
    // 走守卫人话 500 IO。
    mkdirSync(join(workDir, BOOK, '写作', '正文', '0002-占位.md'), { recursive: true })
    const docId = registerDoc('写作/正文/0002-占位.md')
    const res = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analyze`, { kind: 'score' })
    expect(res.status).toBe(500)
    expect((res.json as { code?: string }).code).toBe('IO_ERROR')
    expect((res.json as { error?: string }).error).toContain('读不到正文文件')
  })
})

describe('R66-27: analysis-overview readdir 守卫', () => {
  it('分析目录被文件占位（existsSync true + readdir 抛 ENOTDIR）→ 空趋势 200，不裸穿', async () => {
    // 项目/分析 建成普通文件：existsSync 命中，readdirSync 必抛——稳定复现
    // existsSync→readdir 间目录消失/被占位的竞态形态（修复前 ENOTDIR 裸穿 500）
    writeFileSync(join(workDir, BOOK, '项目', '分析'), '不是目录\n')
    const res = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/analysis-overview`)
    expect(res.status).toBe(200)
    const d = res.json as { ok?: boolean; scoreTrend?: unknown[] }
    expect(d.ok).toBe(true)
    expect(d.scoreTrend).toEqual([])
  })
})
