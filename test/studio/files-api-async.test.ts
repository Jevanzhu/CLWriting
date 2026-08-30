/**
 * S4（五十九轮）回归：files.ts 同步 IO 换 fs/promises。
 *
 * 原实现 readFileSync + hashFile 双份同步整读（PUT 乐观锁路径双份），数百 KB 设定
 * 文件阻塞事件循环秒级（SSE 心跳停摆）。修复：单次异步读取共源出 content + revision
 * （哈希口径与 fs/hash hashFile 同构）。本测试锚定行为契约不回归：
 * GET content/revision、PUT 乐观锁 409、PUT 成功回滚动基线 revision。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '文件异步测试书'
const FILE_Q = encodeURIComponent('设定/总纲.md')
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      origin: baseUrl,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 留 null */
  }
  return { status: r.status, json }
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-files-async-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '设定'), { recursive: true })
  writeFileSync(join(bookRoot, '设定', '总纲.md'), '旧总纲内容')
  writeFileSync(join(bookRoot, 'book.yaml'), 'spec_version: 1\nkind: long\nbook:\n  title: 文件异步测试书\n  genre: 玄幻\nhost: cc\n')
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

describe('S4: /file 端点异步化后行为契约不回归', () => {
  const path = `/api/books/${encodeURIComponent(BOOK)}/file?file=${FILE_Q}`

  it('GET → content + sha256 revision（与 hashFile 口径同构）', async () => {
    const r = await req('GET', path)
    expect(r.status).toBe(200)
    const j = r.json as { content: string; revision: string }
    expect(j.content).toBe('旧总纲内容')
    expect(j.revision).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('GET 不存在文件 → 404（异步 ENOENT 判定）', async () => {
    const r = await req('GET', `/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('设定/不存在.md')}`)
    expect(r.status).toBe(404)
  })

  it('PUT 基线不符 → 409 REVISION_CONFLICT（乐观锁不回归）', async () => {
    const r = await req('PUT', path, { content: 'x', expectedRevision: 'sha256:stale' })
    expect(r.status).toBe(409)
    expect((r.json as { code: string }).code).toBe('REVISION_CONFLICT')
  })

  it('PUT 成功 → 回新 revision = 写入内容指纹（滚动基线）', async () => {
    const got = await req('GET', path)
    const base = (got.json as { revision: string }).revision
    const r = await req('PUT', path, { content: '新总纲内容', expectedRevision: base })
    expect(r.status).toBe(200)
    const rev = (r.json as { revision: string }).revision
    expect(rev).toMatch(/^sha256:[0-9a-f]{64}$/)
    // 回读复核：盘上内容与 revision 自洽（异步读取无错位）
    const again = await req('GET', path)
    const j = again.json as { content: string; revision: string }
    expect(j.content).toBe('新总纲内容')
    expect(j.revision).toBe(rev)
  })

  // B-22（第六十轮）：同 expectedRevision 并发双 PUT 的 TOCTOU 残窗——「读基线→比对→写」
  // 跨两个 await，两请求双双读到同一旧基线先后过检（乐观锁挡基线不符、挡不住双双过检）。
  // 修复前两请求均 200（后写静默覆盖先写）；per-file 串行链后后到者重读基线即见先写者
  // 指纹 → 恰一 200 一 409。
  it('B-22: 同 expectedRevision 并发双 PUT → 恰一 200 一 409（不再双双过检后写覆盖）', async () => {
    const got = await req('GET', path)
    const base = (got.json as { revision: string }).revision
    const [a, b] = await Promise.all([
      req('PUT', path, { content: '甲的保存', expectedRevision: base }),
      req('PUT', path, { content: '乙的保存', expectedRevision: base }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    // 胜者内容落盘（谁先到不定，但必是二者之一且与胜者响应一致）
    const after = await req('GET', path)
    const content = (after.json as { content: string }).content
    expect(['甲的保存', '乙的保存']).toContain(content)
  })
})

// ── R26-9（二十六轮）：PUT /file 覆盖写前快照留底回归 ─────────
// 编辑器 PUT 直接 atomicWriteFile 覆盖既有 .md，旧内容此前无版本链、误存即不可恢复；
// 修复后写前经 snapshotBeforeOverwrite 留底（工作区/.版本/<docId>/<ULID>.md）。
// 注：PUT /file 无创建路径（目标不存在 → 404，见临界段基线闸），「首次创建不触发留底」
// 在本端点由构造保证——snapshotBeforeOverwrite 的 existsSync null 短路天然不可达；
// 端点侧可测的不触发面是「内容未变化」短路（同下）。

describe('R26-9: PUT /file 覆盖写前快照留底', () => {
  const NEW_FILE = encodeURIComponent('设定/留底新文件.md')
  const newPath = `/api/books/${encodeURIComponent(BOOK)}/file?file=${NEW_FILE}`
  const NEW_ABS = () => join(workDir, BOOK, '设定', '留底新文件.md')

  /** 递归收集 .版本 目录下全部文件绝对路径（目录不存在 → 空数组）。 */
  function versionFiles(): string[] {
    const versionsDir = join(workDir, BOOK, '工作区', '.版本')
    if (!existsSync(versionsDir)) return []
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      )
    return walk(versionsDir)
  }

  it('目标文件不存在 → 404（PUT 无创建路径，留底「文件不存在」分支构造性不触发）', async () => {
    const before = versionFiles().length
    const r = await req('PUT', newPath, { content: '第一版留底新文件' })
    expect(r.status).toBe(404)
    expect(versionFiles().length).toBe(before) // 快照目录无新增
  })

  it('覆盖已有文件 → .版本 出现含旧内容的留底记录', async () => {
    // 前置播种：直接落一份「已存在」文件（PUT 不能建新文件）
    writeFileSync(NEW_ABS(), '作者手改的旧内容', 'utf8')
    const before = versionFiles().length

    const r = await req('PUT', newPath, { content: '第二版留底新文件（覆盖）' })
    expect(r.status).toBe(200)

    const snaps = versionFiles()
    expect(snaps.length).toBeGreaterThan(before) // 覆盖写新增留底
    expect(snaps.some((p) => readFileSync(p, 'utf8').includes('作者手改的旧内容'))).toBe(true)
    // 主流程不受影响：新内容落盘
    expect(readFileSync(NEW_ABS(), 'utf8')).toBe('第二版留底新文件（覆盖）')
  })

  it('内容未变化 → 不留底（snapshotBeforeOverwrite 同内容 null 短路）', async () => {
    const before = versionFiles().length
    const r = await req('PUT', newPath, { content: '第二版留底新文件（覆盖）' })
    expect(r.status).toBe(200)
    expect(versionFiles().length).toBe(before) // 同内容不产生新快照
  })
})
