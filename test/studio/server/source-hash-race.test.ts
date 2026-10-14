/**
 * analysis 信封的读改写竞态行为面（analyze / review / review-verdict 三端点）。
 *
 * sourceHash 必须与进 prompt 的正文同刻同源：analyze / review 两条路由原先在分钟级 AI
 * 任务**完成后**才 readFileSync 重读正文算 hash——任务期间作者保存会让信封 hash 对应新稿、
 * 而 payload 分析/审校的是旧稿，stale 判定恒为 false（「新鲜」标签与实际内容错配）。
 *
 * 测法：mock runSpec（两条路由共同的 AI 执行边界），在其内部先改稿（确定性复现
 * 「作者中途保存」窗口）再返回——断言信封 sourceHash === 读稿时的原稿指纹（≠当前盘上
 * 内容），即 GET stale=true。修复前 hash 取自改后文件，stale 恒 false。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（req 走裸 http.request 定制形态，保留本地；
 * 原裸 startServer+手动 listen 收编 safe 形态——语义等价且带受限端口重绑）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { startServerSafe } from '../../helpers/safe-port.js'

// 唯一注入点：两条路由的 AI 执行边界（analyze → runAnalyst → runSpec；review →
// runLensSpawnLoop 逐 lens → runSpec）。首次调用时模拟「作者在任务运行中保存」。
const mutatePath = { file: '' }
vi.mock('../../../src/ai/tasks/spec.js', () => ({
  runSpec: async () => {
    if (mutatePath.file) {
      writeFileSync(
        mutatePath.file,
        readFileSync(mutatePath.file, 'utf-8') + '\n任务运行期间作者补写的一段。\n',
        'utf-8',
      )
      mutatePath.file = '' // 只改一次（review 多 lens 不重复追加）
    }
    return { ok: true as const, data: { input: { score: 8, issues: [] }, text: '' }, usage: null }
  },
}))

// 同域并入组之二（verdict 读改写竞态）的注入点：readAnalysis 序列桩——默认不武装
// （全透传真实现），仅供该组显式逐次排定返回值；writeAnalysis 等其余导出恒透传。
const verdictSeq = vi.hoisted(() => ({
  armed: false,
  seq: [] as unknown[],
}))
vi.mock('../../../src/document/analysis.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/document/analysis.js')>()
  return {
    ...orig,
    readAnalysis: (...args: Parameters<typeof orig.readAnalysis>) => {
      if (verdictSeq.armed && verdictSeq.seq.length > 0) {
        return verdictSeq.seq.shift() as ReturnType<typeof orig.readAnalysis>
      }
      return orig.readAnalysis(...args)
    },
  }
})

import { bootStudio, type StudioHarness } from '../../helpers/studio-server.js'
import { readManifest, writeManifest, upsertEntry } from '../../../src/document/manifest.js'
import { generateDocId } from '../../../src/document/stable-id.js'
import { readAnalysis, sourceHashOf, type Envelope } from '../../../src/document/analysis.js'

const BOOK = '哈希竞态测试书'
let studio: StudioHarness
let workDir = ''
let docId = ''
let chapterPath = ''
let originalContent = ''

function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const payload = body ? JSON.stringify(body) : ''
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method,
        headers: {
          'x-studio-token': studio.token,
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
  originalContent =
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场，初入宗门。\n'
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-hash-race-',
    env: { CLWRITING_DRIVER: 'mock' },
    dirs: ['写作/正文', '项目'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 哈希竞态测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    files: [{ rel: '写作/正文/0001-开篇.md', content: originalContent }],
  })
  workDir = studio.workDir
  chapterPath = join(studio.bookRoot, '写作', '正文', '0001-开篇.md')
  const manifestPath = join(studio.bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  docId = generateDocId()
  upsertEntry(m, { id: docId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  writeManifest(manifestPath, m)
})

afterAll(async () => {
  await studio.close()
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

// ── verdict 写回与三审完成的读改写竞态：POST /review-verdict 首次 readAnalysis 拿到旧
// payload（无三审结果），随后（读稿/写盘之间）三审恰好完成落盘新 collected/lenses。修复前
// verdict 用旧读的 payload 整体回写 → 新三审结果被静默写丢。修复后写前重读、以磁盘最新值
// 浅合并，只覆盖 verdict 字段。
// 注入方式：上文 readAnalysis 序列桩（第 1 次返旧、第 2 次返三审落盘后的新值——精确模拟
// 竞态窗口），writeAnalysis 走真实实现；断言以真实文件读回为准。
// 独立环境自建自清：本组用临时 workDir 直起服务器（同域用例组的既有形态），与上文
// bootStudio 书根互不干扰。──

describe('review-verdict 与三审完成的读改写竞态', () => {
  const V_BOOK = '裁决竞态测试书'
  let vWorkDir = ''
  let vServer: http.Server | undefined
  let vBaseUrl = ''
  let vToken = ''
  let vDocId = ''

  // 旧读（verdict 首次 readAnalysis）：只有一条旧 collected
  const OLD_ENV: Envelope = {
    generatedAt: '2026-08-01T00:00:00.000Z',
    model: 'cc/old',
    sourceHash: 'a'.repeat(64),
    payload: { collected: [{ lens: 'logic', level: 'yellow', text: '旧意见' }] },
  }
  // 新落盘（三审恰在竞态窗口完成）：全新 collected + lenses
  const NEW_ENV: Envelope = {
    generatedAt: '2026-08-22T00:00:00.000Z',
    model: 'cc/new',
    sourceHash: 'b'.repeat(64),
    payload: { collected: [{ lens: 'consistency', level: 'red', text: '新三审意见' }], lenses: ['consistency'] },
  }

  function verdictReq(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const u = new URL(vBaseUrl)
      const payload = body ? JSON.stringify(body) : ''
      const r = http.request(
        {
          host: u.hostname,
          port: u.port,
          path,
          method,
          headers: {
            'x-studio-token': vToken,
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
    vWorkDir = mkdtempSync(join(tmpdir(), 'clwriting-verdict-race-'))
    mkdirSync(join(vWorkDir, '.clwriting'), { recursive: true })
    writeFileSync(
      join(vWorkDir, '.clwriting', 'books.jsonl'),
      JSON.stringify({ name: V_BOOK, path: V_BOOK, kind: 'long' }) + '\n',
    )
    const bookRoot = join(vWorkDir, V_BOOK)
    mkdirSync(join(bookRoot, '定稿', '正文'), { recursive: true })
    mkdirSync(join(bookRoot, '项目'), { recursive: true })
    writeFileSync(
      join(bookRoot, 'book.yaml'),
      'spec_version: 1\nkind: long\nbook:\n  title: 裁决竞态测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
      'utf8',
    )
    writeFileSync(
      join(bookRoot, '定稿', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n主角登场。\n',
      'utf8',
    )
    const m = readManifest(join(bookRoot, '项目', '文档清单.jsonl'))
    vDocId = generateDocId()
    upsertEntry(m, { id: vDocId, nodeType: 'document', path: '定稿/正文/0001-开篇.md', parentId: null })
    writeManifest(join(bookRoot, '项目', '文档清单.jsonl'), m)

    vServer = await startServerSafe({ port: 0, workDir: vWorkDir })
    vBaseUrl = `http://127.0.0.1:${(vServer.address() as AddressInfo).port}`
    const r = await fetch(`${vBaseUrl}/api/boot`)
    vToken = ((await r.json()) as { token: string }).token
  })

  afterAll(async () => {
    if (vServer) await new Promise<void>((r) => vServer!.close(() => r()))
    if (vWorkDir) rmSync(vWorkDir, { recursive: true, force: true })
  })

  it('三审恰在 verdict 读后写前落盘 → verdict 落盘且新 collected/lenses 保留不丢', async () => {
    // 预置旧信封（真实写盘，模拟此前已有一次旧三审）
    const { writeAnalysis } = await import('../../../src/document/analysis.js')
    writeAnalysis(join(vWorkDir, V_BOOK), vDocId, 'review', OLD_ENV)

    // 序列桩：第 1 次（verdict 首读）= 旧值；第 2 次（写前重读）= 三审刚落盘的新值
    verdictSeq.armed = true
    verdictSeq.seq = [OLD_ENV, NEW_ENV]

    const r = await verdictReq('POST', `/api/books/${encodeURIComponent(V_BOOK)}/documents/${vDocId}/review-verdict`, {
      approved: true,
    })
    expect(r.status).toBe(200)
    expect((r.json as { verdict: { approved: boolean } }).verdict.approved).toBe(true)

    // 真实文件读回（绕开 mock）：verdict 在 + 新三审 collected/lenses 在 + 旧意见不残留
    const raw = JSON.parse(readFileSync(join(vWorkDir, V_BOOK, '项目', '分析', `${vDocId}.json`), 'utf-8')) as {
      review: Envelope
    }
    const payload = raw.review.payload as {
      collected: { lens: string; level: string; text: string }[]
      lenses: string[]
      verdict: { approved: boolean }
    }
    expect(payload.verdict.approved).toBe(true) // verdict 不丢
    expect(payload.collected).toEqual((NEW_ENV.payload as { collected: unknown[] }).collected) // 新三审结果不被旧读覆写
    expect(payload.lenses).toEqual(['consistency'])
  })
})
