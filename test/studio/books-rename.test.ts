/**
 * POST /api/books/:name/rename 改名闭环集成测：
 * 磁盘目录 + books.jsonl 登记 + active 指针 + book.yaml title 全量同步（防「书名/文件夹/登记名」三分歧）；
 * 校验重名冲突 / 非法字符 / 空名 / 同名 no-op / 未知书 404 / 目标目录占用 400。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const OLD = '旧名测试书'
const NEW = '新名测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  let json: unknown = null
  try {
    json = await r.json()
  } catch {
    /* 非 JSON 响应留 null */
  }
  return { status: r.status, json }
}

function bookYaml(title: string): string {
  return `spec_version: 1\nkind: long\nbook:\n  title: ${title}\n  genre: 玄幻\nhost: cc\n`
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-rename-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  // 登记两本书：OLD（分组布局）+ 重名冲突靶子「别的书」
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    [
      JSON.stringify({ name: OLD, path: `长篇/${OLD}`, kind: 'long', created_at: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ name: '别的书', path: '长篇/别的书', kind: 'long' }),
    ].join('\n') + '\n',
  )
  writeFileSync(join(workDir, '.clwriting', 'active'), OLD + '\n')
  // OLD 书仓库（含一个文件，验证目录搬家内容跟随）
  const oldRoot = join(workDir, '长篇', OLD)
  mkdirSync(join(oldRoot, '写作', '正文'), { recursive: true })
  writeFileSync(join(oldRoot, 'book.yaml'), bookYaml(OLD))
  writeFileSync(join(oldRoot, '写作', '正文', '0001-开篇.md'), '# 开篇\n\n正文。\n')
  // 别的书仓库（重名冲突靶子）
  const otherRoot = join(workDir, '长篇', '别的书')
  mkdirSync(otherRoot, { recursive: true })
  writeFileSync(join(otherRoot, 'book.yaml'), bookYaml('别的书'))

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await fetch(`${baseUrl}/api/boot`)
  token = ((await boot.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('POST /api/books/:name/rename 全量改名', () => {
  it('改名成功：目录搬家 + 登记/active/title 同步 + 旧名 404', async () => {
    const oldRoot = join(workDir, '长篇', OLD)
    const newRoot = join(workDir, '长篇', NEW)
    expect(existsSync(oldRoot)).toBe(true)
    expect(existsSync(newRoot)).toBe(false)

    const r = await req('POST', `/api/books/${encodeURIComponent(OLD)}/rename`, { name: NEW })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, renamed: true, name: NEW, path: `长篇/${NEW}` })

    // 磁盘：旧目录没了、新目录在、内容跟着搬
    expect(existsSync(oldRoot)).toBe(false)
    expect(existsSync(join(newRoot, '写作', '正文', '0001-开篇.md'))).toBe(true)
    // book.yaml title 同步
    expect(readFileSync(join(newRoot, 'book.yaml'), 'utf8')).toContain(`title: ${NEW}`)
    // 登记更新：新名在、旧名不在、未知字段（created_at）保留
    const entries = readFileSync(join(workDir, '.clwriting', 'books.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const entry = entries.find((e) => e.name === NEW)
    expect(entry).toBeDefined()
    expect(entry!.path).toBe(`长篇/${NEW}`)
    expect(entry!.created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(entries.find((e) => e.name === OLD)).toBeUndefined()
    // active 指针换新
    expect(readFileSync(join(workDir, '.clwriting', 'active'), 'utf8').trim()).toBe(NEW)
    // 旧名 404、新名 200（title 已同步）
    expect((await req('GET', `/api/books/${encodeURIComponent(OLD)}`)).status).toBe(404)
    const nb = await req('GET', `/api/books/${encodeURIComponent(NEW)}`)
    expect(nb.status).toBe(200)
    expect((nb.json as { title: string }).title).toBe(NEW)
  })

  it('重名冲突 → 400', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(NEW)}/rename`, { name: '别的书' })
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toContain('已有一本')
  })

  it('非法字符（路径分隔符）→ 400', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(NEW)}/rename`, { name: 'a/b' })
    expect(r.status).toBe(400)
  })

  it('空书名 → 400', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(NEW)}/rename`, { name: '  ' })
    expect(r.status).toBe(400)
  })

  it('同名 no-op → renamed:false 且目录不动', async () => {
    const newRoot = join(workDir, '长篇', NEW)
    const r = await req('POST', `/api/books/${encodeURIComponent(NEW)}/rename`, { name: NEW })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, renamed: false, name: NEW })
    expect(existsSync(newRoot)).toBe(true)
  })

  it('未知书 → 404', async () => {
    const r = await req('POST', '/api/books/不存在/rename', { name: 'x' })
    expect(r.status).toBe(404)
  })

  it('目标目录已存在且非空 → 400', async () => {
    // 造一个与改名目标同名的非空目录（未登记），改名到它会撞目录级冲突
    const clash = join(workDir, '长篇', '撞名目录')
    mkdirSync(clash, { recursive: true })
    writeFileSync(join(clash, 'x.md'), 'x')
    const r = await req('POST', `/api/books/${encodeURIComponent(NEW)}/rename`, { name: '撞名目录' })
    expect(r.status).toBe(400)
  })
})
