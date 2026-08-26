/**
 * POST /documents/batch-finalize 端点集成测（P2-PROD-2 批量定稿）。
 * 验证：批量成功（多个 revision 章一次定稿）+ 部分失败（未登记 docId 不影响其他）
 * + 空/非法 body 400。git setup 复用 finalize-api 范式。
 */
import http from 'node:http'
import { execSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readManifest, writeManifest, upsertEntry } from '../../src/document/manifest.js'
import { generateDocId } from '../../src/document/stable-id.js'

const BOOK = '批量定稿测试书'
let workDir = ''
let bookRoot = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
let ch1DocId = ''
let ch2DocId = ''
let ch3DocId = ''

function postBatch(docIds: unknown): Promise<{ status: number; json: unknown }> {
  return postBatchDelayed(docIds, 0)
}

/** body 延迟 bodyDelayMs 才上送——制造 handler 已进入（持闸）但悬在 readJson 的在途窗口 */
function postBatchDelayed(docIds: unknown, bodyDelayMs: number): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const body = JSON.stringify({ docIds })
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `/api/books/${encodeURIComponent(BOOK)}/documents/batch-finalize`,
        method: 'POST',
        headers: {
          'x-studio-token': token,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body), // 必须带上：flushHeaders 后服务器据 length 判 body 未完
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
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
    req.on('error', reject)
    // 先 flushHeaders 发请求头（Node 的 http.request 在 end/write 前不发任何字节），
    // 服务器据此进入 handler 同步占闸、悬在 readJson 等 body；body 延迟上送模拟在途窗口。
    req.flushHeaders()
    setTimeout(() => req.end(body), bodyDelayMs)
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-batchfin-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 批量定稿测试书\n  genre: 玄幻\nhost: cc\n',
    'utf8',
  )
  // 3 章初始 commit → final 态；随后 2/3 改脏 → revision 态供批量定稿
  for (const [no, title, body] of [
    [1, '开篇', '天脉异象惊动宗门。'],
    [2, '转折', '弟子林远踏入山门。'],
    [3, '高潮', '玉佩灵光击退妖兽。'],
  ] as const) {
    writeFileSync(
      join(bookRoot, '写作', '正文', `000${no}-${title}.md`),
      `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${body}\n`,
      'utf8',
    )
  }
  execSync('git init', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.email t@t.com', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config user.name t', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git config commit.gpgsign false', { cwd: bookRoot, stdio: 'pipe' })
  execSync('git add -A && git commit -m "ch:0001-0003"', { cwd: bookRoot, stdio: 'pipe' })

  const manifestPath = join(bookRoot, '项目', '文档清单.jsonl')
  const m = readManifest(manifestPath)
  ch1DocId = generateDocId()
  ch2DocId = generateDocId()
  ch3DocId = generateDocId()
  upsertEntry(m, { id: ch1DocId, nodeType: 'document', path: '写作/正文/0001-开篇.md', parentId: null })
  upsertEntry(m, { id: ch2DocId, nodeType: 'document', path: '写作/正文/0002-转折.md', parentId: null })
  upsertEntry(m, { id: ch3DocId, nodeType: 'document', path: '写作/正文/0003-高潮.md', parentId: null })
  writeManifest(manifestPath, m)

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const r = await fetch(`${baseUrl}/api/boot`)
  token = ((await r.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('POST /documents/batch-finalize（P2-PROD-2）', () => {
  it('多个 revision 章一次批量定稿成功', async () => {
    // 改脏 2/3 两章 → revision 态
    for (const [no, title, body] of [
      [2, '转折', '弟子林远踏入山门，玉佩微光。'],
      [3, '高潮', '玉佩灵光暴涨，击退妖兽，林远震惊。'],
    ] as const) {
      writeFileSync(
        join(bookRoot, '写作', '正文', `000${no}-${title}.md`),
        `---\n章号: ${no}\n标题: ${title}\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n${body}\n`,
        'utf8',
      )
    }
    const r = await postBatch([ch2DocId, ch3DocId])
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; results: { docId: string; ok: boolean; status: string; skipped: boolean }[] }
    expect(j.ok).toBe(true)
    expect(j.results).toHaveLength(2)
    expect(j.results.every((x) => x.ok && x.status === 'final' && x.skipped === false)).toBe(true)
    // 两章均不再脏
    const status = execSync('git status --porcelain', { cwd: bookRoot, encoding: 'utf-8' })
    expect(status).not.toContain('0002-转折.md')
    expect(status).not.toContain('0003-高潮.md')
  })

  it('含未登记 docId → 该条失败，其余成功（部分失败不中断）', async () => {
    // 改脏 1 章
    writeFileSync(
      join(bookRoot, '写作', '正文', '0001-开篇.md'),
      '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n天脉异象惊动宗门，长老齐聚。\n',
      'utf8',
    )
    const r = await postBatch([ch1DocId, 'doc_unknown'])
    expect(r.status).toBe(200)
    const j = r.json as { ok: boolean; results: { docId: string; ok: boolean; error?: string }[] }
    expect(j.results).toHaveLength(2)
    expect(j.results[0]).toMatchObject({ docId: ch1DocId, ok: true })
    expect(j.results[1]).toMatchObject({ docId: 'doc_unknown', ok: false })
    expect(typeof j.results[1]?.error).toBe('string')
  })

  it('空 docIds / 非字符串数组 → 400 BAD_INPUT', async () => {
    expect((await postBatch([])).status).toBe(400)
    expect((await postBatch('x')).status).toBe(400)
    expect((await postBatch([1])).status).toBe(400)
  })

  // X-23（第五十六轮）：无条数上限的大批量同步循环会阻塞事件循环数秒——入口
  // fail-fast：超 400 条 400 BAD_INPUT（人话提示分批），上限内不受影响
  it('X-23：超过 400 条 → 400 BAD_INPUT 且提示分批；上限内（含未登记 id）不受影响', async () => {
    const tooMany = Array.from({ length: 401 }, (_, i) => `doc_${i}`)
    const r = await postBatch(tooMany)
    expect(r.status).toBe(400)
    expect((r.json as { code: string; error: string }).code).toBe('BAD_INPUT')
    expect((r.json as { error: string }).error).toContain('分批')
    // 上限边界：恰好 400 条不被拒（走正常逐条循环，未登记 id 各自失败不中断）
    const atCap = Array.from({ length: 400 }, (_, i) => `doc_missing_${i}`)
    const ok = await postBatch(atCap)
    expect(ok.status).toBe(200)
    const j = ok.json as { ok: boolean; results: unknown[] }
    expect(j.ok).toBe(true)
    expect(j.results).toHaveLength(400)
  })

  it('CC-P2-9：定稿进行中后到请求 409 BUSY（防每章双 commit + 双 manifest 写）', async () => {
    // 改脏一章供定稿
    writeFileSync(
      join(bookRoot, '写作', '正文', '0002-转折.md'),
      '---\n章号: 2\n标题: 转折\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n---\n\n弟子林远踏入山门，双击防双跑。\n',
      'utf8',
    )
    // 闸在首个 await（readJson）前同步占位。请求 1 body 延迟上送 → handler1 持闸悬在
    // readJson；期间到达的完整请求 2 必吃 409（修复前：无闸直接放行双跑）。
    // 注：定稿循环全程同步，两个 body 已齐的请求会串行各自持闸——那种双击由
    // finalize 幂等（已定稿 → skipped）兜底，本闸覆盖的是在途窗口。
    const p1 = postBatchDelayed([ch2DocId], 250)
    // R64-41（十二轮）：固定 80ms 窗口改轮询确认——慢机/压机下回环延迟超 80ms 时
    // handler1 尚未占闸，请求 2 先抢闸返回 200（409 假红）。轮询服务器侧闸状态
    // （请求 2 打 BUSY 前必然已占），最多等 2s；仍不占则按原断言失败暴露。
    const busy = await pollUntil(
      async () => (await postBatch([ch2DocId])).status === 409,
      2000,
    )
    expect(busy).toBe(true)
    const r1 = await p1
    expect(r1.status).toBe(200)
  })
})

/** R64-41：以 25ms 间隔轮询谓词直至真或超时（毫秒） */
async function pollUntil(pred: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pred()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
}
