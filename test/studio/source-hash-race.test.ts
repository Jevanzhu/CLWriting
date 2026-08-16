/**
 * CC-P1-2 回归：sourceHash 必须与进 prompt 的正文同刻同源。
 *
 * 缺陷：analyze / review 两条路由原先在分钟级 AI 任务**完成后**才 readFileSync 重读
 * 正文算 hash——任务期间作者保存会让信封 hash 对应新稿、而 payload 分析/审校的是旧稿，
 * stale 判定恒为 false（「新鲜」标签与实际内容错配）。
 *
 * 测法：mock runSpec（两条路由共同的 AI 执行边界），在其内部先改稿（确定性复现
 * 「作者中途保存」窗口）再返回——断言信封 sourceHash === 读稿时的原稿指纹（≠当前盘上
 * 内容），即 GET stale=true。修复前 hash 取自改后文件，stale 恒 false。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, it, expect, vi } from 'vitest'

// 唯一注入点：两条路由的 AI 执行边界（analyze → runAnalyst → runSpec；review →
// runLensSpawnLoop 逐 lens → runSpec）。首次调用时模拟「作者在任务运行中保存」。
const mutatePath = { file: '' }
vi.mock('../../src/ai/tasks/spec.js', () => ({
  runSpec: async () => {
    if (mutatePath.file) {
      writeFileSync(mutatePath.file, readFileSync(mutatePath.file, 'utf-8') + '\n任务运行期间作者补写的一段。\n', 'utf-8')
      mutatePath.file = '' // 只改一次（review 多 lens 不重复追加）
    }
    return { ok: true as const, data: { input: { score: 8, issues: [] }, text: '' }, usage: null }
  },
}))

import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'
import { readAnalysis, sourceHashOf } from '../../src/document/analysis.js'

const BOOK = '哈希竞态测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let docId = ''
let chapterPath = ''
let originalContent = ''
const prevDriver = process.env['CLWRITING_DRIVER']

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
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-hash-race-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(join(workDir, '.clwriting', 'books.jsonl'), JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n')
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 哈希竞态测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  )
  chapterPath = join(bookRoot, '写作', '正文', '0001-开篇.md')
  originalContent = '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，初入宗门。\n'
  writeFileSync(chapterPath, originalContent)
  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json() as { token: string }
  token = boot.token
})

afterAll(() => {
  if (server) server.close()
  rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
  vi.restoreAllMocks()
})

it('analyze：任务运行中作者保存 → 信封 hash 仍是读稿时的原稿，GET stale=true', async () => {
  mutatePath.file = chapterPath
  const res = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analyze`, { kind: 'score' })
  expect(res.status).toBe(200)

  // 信封 hash = 进 prompt 时的原稿指纹（修复前：任务后重读 → 改后文件的指纹）
  const bookRoot = join(workDir, BOOK)
  const env = readAnalysis(bookRoot, docId, 'score')
  expect(env?.sourceHash).toBe(sourceHashOf(originalContent))
  // 盘上内容已变 → 过期标注必须亮起（修复前恒 false，错配）
  expect(env?.sourceHash).not.toBe(sourceHashOf(readFileSync(chapterPath, 'utf-8')))

  const get = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/analysis/score`)
  expect(get.status).toBe(200)
  expect((get.json as { stale: boolean }).stale).toBe(true)
})

it('review：三审运行中作者保存 → 信封 hash 仍是读稿时的原稿', async () => {
  // 还原原稿，再触发一次「运行中保存」
  writeFileSync(chapterPath, originalContent)
  mutatePath.file = chapterPath
  const res = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/documents/${docId}/review`, {})
  expect(res.status).toBe(200)

  const bookRoot = join(workDir, BOOK)
  const env = readAnalysis(bookRoot, docId, 'review')
  expect(env?.sourceHash).toBe(sourceHashOf(originalContent))
  expect(env?.sourceHash).not.toBe(sourceHashOf(readFileSync(chapterPath, 'utf-8')))
})
