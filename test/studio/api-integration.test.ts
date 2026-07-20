/**
 * API 集成测(横切 P1 e2e 第一刀):启动 studio server + 临时工作目录 fixture,
 * 端到端验证 GUI 后端 API 链(不涉 driver/大模型,守护已上线功能)。
 *
 * 覆盖:书架 → 设定台(P2 角色卡读写 + 境界写回 + 防穿越)→ 配置。
 * router 全局 routes 靠 vitest module isolate(每文件独立 routes 实例)。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'
import { readBooks } from '../../src/install/books.js'

const BOOK = '测试书'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-api-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(join(bookRoot, '大纲'), { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nbook:\n  title: 测试书\n  genre: 仙侠\nkind: long\nhost: cc\n',
  )
  writeFileSync(join(bookRoot, '大纲', '总纲.md'), '# 总纲\n仙侠:林远/旧案反转')
  mkdirSync(join(bookRoot, '定稿', '设定', '角色'), { recursive: true })
  writeFileSync(
    join(bookRoot, '定稿', '设定', '角色', '林远.md'),
    '---\n姓名: 林远\n身份: 弟子\n目标: 旧案\n境界: 练气\n---\n性格沉稳。',
  )
  writeFileSync(
    join(bookRoot, '定稿', '设定', '境界体系.md'),
    '---\n体系:\n  - 名称: 修真\n    序列: [炼气, 筑基, 金丹]\n---\n境界说明',
  )

  server = startServer({ port: 0, workDir })
  await new Promise<void>((r) => server!.once('listening', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const bootR = await fetch(`${baseUrl}/api/boot`)
  token = ((await bootR.json()) as { token: string }).token
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()))
  if (workDir) rmSync(workDir, { recursive: true, force: true })
})

describe('GUI API 集成链(设定台 P2)', () => {
  it('GET /api/books 书架含测试书', async () => {
    const r = await fetch(`${baseUrl}/api/books`)
    expect(r.ok).toBe(true)
    const d = (await r.json()) as { books: { name: string }[] }
    expect(d.books.some((b) => b.name === BOOK)).toBe(true)
  })

  it('POST /api/books 新建短篇落到短篇/二级目录', async () => {
    const r = await fetch(`${baseUrl}/api/books`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ name: 'API短篇', genre: '悬疑', kind: 'short' }),
    })
    expect(r.ok).toBe(true)
    const d = (await r.json()) as { name: string; kind: string; path: string }
    expect(d).toMatchObject({ name: 'API短篇', kind: 'short', path: '短篇/API短篇' })
    expect(existsSync(join(workDir, '短篇', 'API短篇', 'book.yaml'))).toBe(true)
    expect(readBooks(workDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'API短篇', kind: 'short', path: '短篇/API短篇' }),
    ]))
  })

  it('GET /api/books/:name/settings 设定台读角色 + 境界', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings`)
    const d = (await r.json()) as {
      kind: string
      characters: { 姓名: string; 境界: string }[]
      realm: { 体系: { 名称: string; 序列: string[] }[] } | null
    }
    expect(d.kind).toBe('long')
    const 林远 = d.characters.find((c) => c.姓名 === '林远')
    expect(林远?.境界).toBe('练气')
    expect(d.realm?.体系[0]?.名称).toBe('修真')
    expect(d.realm?.体系[0]?.序列).toEqual(['炼气', '筑基', '金丹'])
  })

  it('PUT /settings/character 角色卡写回 + 再读验证', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings/character`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({
        file: '定稿/设定/角色/林远.md',
        姓名: '林远',
        身份: '内门弟子',
        目标: '查清旧案',
        境界: '筑基',
        正文: '性格沉稳,升级了。',
      }),
    })
    const putD = (await r.json()) as { ok: boolean }
    expect(putD.ok).toBe(true)
    const r2 = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings`)
    const d2 = (await r2.json()) as { characters: { 姓名: string; 境界: string; 身份: string }[] }
    const 林远 = d2.characters.find((c) => c.姓名 === '林远')!
    expect(林远.境界).toBe('筑基')
    expect(林远.身份).toBe('内门弟子')
  })

  it('PUT /settings/character 防穿越:拒绝非法 file(大纲/总纲.md)', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings/character`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ file: '大纲/总纲.md', 姓名: 'X' }),
    })
    expect(r.status).toBe(400)
  })

  it('PUT /settings/character 防穿越:拒绝 .. 穿越', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings/character`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ file: '定稿/设定/角色/../../../etc/passwd.md', 姓名: 'X' }),
    })
    expect(r.status).toBe(400)
  })

  it('PUT /settings/realm 境界写回 + 再读验证', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings/realm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({
        体系: [{ 名称: '修真', 序列: ['炼气', '筑基', '金丹', '元婴'] }],
        正文: '新增元婴境',
      }),
    })
    const putD = (await r.json()) as { ok: boolean }
    expect(putD.ok).toBe(true)
    const r2 = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/settings`)
    const d2 = (await r2.json()) as { realm: { 体系: { 序列: string[] }[] } | null }
    expect(d2.realm?.体系[0]?.序列).toContain('元婴')
  })

  it('GET /api/books/:name/config 配置读回(kind + title)', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/config`)
    const d = (await r.json()) as { config: { kind: string; book: { title: string } } }
    expect(d.config.kind).toBe('long')
    expect(d.config.book.title).toBe('测试书')
  })

  it('GET /file 只允许读可编辑 Markdown，拒绝 book.yaml', async () => {
    const ok = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('大纲/总纲.md')}`)
    expect(ok.ok).toBe(true)
    const okD = (await ok.json()) as { content: string }
    expect(okD.content).toContain('# 总纲')

    const blocked = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('book.yaml')}`)
    expect(blocked.status).toBe(400)
  })

  it('PUT /file 只允许写可编辑 Markdown，拒绝 book.yaml', async () => {
    const ok = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('大纲/总纲.md')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: '# 总纲\n已更新' }),
    })
    expect(ok.ok).toBe(true)

    const blocked = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/file?file=${encodeURIComponent('book.yaml')}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify({ content: 'broken: true\n' }),
    })
    expect(blocked.status).toBe(400)
  })

  it('GET /api/books/:name/search?q= 全书扫描 + 行级匹配（W2A 收尾）', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/search?q=${encodeURIComponent('林远')}`)
    const d = (await r.json()) as { results: { path: string; matches: { line: number; text: string }[] }[] }
    expect(d.results.length).toBeGreaterThan(0)
    expect(
      d.results.some((it) => it.path.includes('林远') || it.matches.some((m) => m.text.includes('林远'))),
    ).toBe(true)
  })

  it('GET /search?scope=设定 限定范围（只搜定稿/设定/）', async () => {
    const r = await fetch(`${baseUrl}/api/books/${encodeURIComponent(BOOK)}/search?q=${encodeURIComponent('林远')}&scope=${encodeURIComponent('设定')}`)
    const d = (await r.json()) as { results: { path: string }[] }
    expect(d.results.length).toBeGreaterThan(0)
    expect(d.results.every((it) => it.path.startsWith('定稿/设定/'))).toBe(true)
  })
})
