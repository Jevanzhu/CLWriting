/**
 * R71-9（总七十一轮）onboard-ai 覆盖前快照留底回归：
 * onboard-ai（分钟级）与 onboard-save 闸键不同互不阻挡——AI 完成后 atomicWriteFile
 * 直接覆盖目标文件，作者在生成期间的手改此前静默丢失（该域无版本链）。修复后复用
 * draft 侧 snapshotBeforeOverwrite：覆盖前把旧内容写进 工作区/.版本/<docId>/<ULID>.md。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = 'R71快照书'
const OLD_CONTENT = '# 作者手改版总纲\n\n主角第三章已死，AI 别再写活他。'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']

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

/** 递归收集目录下全部文件绝对路径 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listFiles(p))
    else out.push(p)
  }
  return out
}

beforeAll(async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  workDir = mkdtempSync(join(tmpdir(), 'clw-r71-onboard-'))
  const userDataPath = mkdtempSync(join(tmpdir(), 'clw-r71-onboard-ud-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  // 模拟「AI 生成期间作者已手改落盘」的现场（onboard-save 与 onboard-ai 闸键不同互不阻挡）
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), OLD_CONTENT, 'utf-8')
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R71快照书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
    'utf-8',
  )
  server = startServer({ port: 0, workDir, userDataPath })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = boot.token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('R71-9: onboard-ai 覆盖既有文件前快照留底', () => {
  it('AI 产出覆盖前 → .版本 内生成含旧内容的快照 + 响应 snapshotted 留痕', async () => {
    const versionsDir = join(workDir, BOOK, '工作区', '.版本')
    expect(listFiles(versionsDir)).toHaveLength(0) // 前置：无版本链

    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'synopsis' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; snapshotted?: boolean; content: string }
    expect(body.ok).toBe(true)
    expect(body.snapshotted).toBe(true) // 响应留痕

    // 快照存在且内容 = 作者手改的旧内容（mock 产出与之必然不同）
    const snaps = listFiles(versionsDir)
    expect(snaps.length).toBeGreaterThan(0)
    const snapContents = snaps.map((p) => readFileSync(p, 'utf8'))
    expect(snapContents.some((c) => c.includes(OLD_CONTENT))).toBe(true)

    // 主流程不受影响：目标文件被 AI 产出覆盖
    const after = readFileSync(join(workDir, BOOK, '大纲', '总纲.md'), 'utf8')
    expect(after).toBe(body.content)
    expect(after).not.toContain(OLD_CONTENT)
  })

  it('目标文件不存在（首次生成）→ 无快照、snapshotted 缺省', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, { step: 'characters' })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; snapshotted?: boolean }
    expect(body.ok).toBe(true)
    expect(body.snapshotted).toBeUndefined()
    expect(existsSync(join(workDir, BOOK, '设定', '名册.md'))).toBe(true)
  })
})
