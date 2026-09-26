/**
 * R71-11（总七十一轮）style 删条目幂等回归：
 * 条目已不存在时 statSync(safe.abs) ENOENT 裸抛 → dispatch 兜底 500。修复后按不存在
 * 处理（幂等删除 200，与 rmSync force 语义一致）；目录形态递归删（R70-23）不回归。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio（本地 req 无 origin 头、
 * content-type 常驻——非同形，保留本地）。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = 'R71删条目书'
let studio: StudioHarness

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const r = await fetch(`${studio.baseUrl}${path}`, {
    method,
    headers: {
      'x-studio-token': studio.token,
      'content-type': 'application/json',
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
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-r71-style-del-',
    dirs: ['文风/条目/手法'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: R71删条目书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n',
  })
})

afterAll(() => studio.close())

describe('R71-11: DELETE /style/entries 幂等（不存在条目不再 500）', () => {
  it('删除从未存在的条目路径 → 200（修复前 statSync ENOENT 裸抛 500）', async () => {
    const p = '文风/条目/手法/不存在-001.md'
    expect(existsSync(join(studio.bookRoot, p))).toBe(false)
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: p })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true })
  })

  it('删除已存在条目 → 200 且落盘删除；重复删同一（已消失）条目 → 仍 200 幂等', async () => {
    const p = '文风/条目/手法/通用-001.md'
    writeFileSync(join(studio.bookRoot, p), '---\n场景: 通用\n---\n对话不用提示语。', 'utf-8')
    const first = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: p })
    expect(first.status).toBe(200)
    expect(existsSync(join(studio.bookRoot, p))).toBe(false)

    // 第二次删除（条目已不在）——幂等 200，不再 500
    const second = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: p })
    expect(second.status).toBe(200)
    expect(second.json).toMatchObject({ ok: true })
  })

  it('目录形态条目（R70-23）递归删不回归', async () => {
    const dirRel = '文风/条目/样章'
    mkdirSync(join(studio.bookRoot, dirRel, '战斗'), { recursive: true })
    writeFileSync(join(studio.bookRoot, dirRel, '战斗', '战斗-001.md'), '刀光没入雪雾。', 'utf-8')
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: dirRel })
    expect(r.status).toBe(200)
    expect(existsSync(join(studio.bookRoot, dirRel))).toBe(false)
  })

  it('R0913-win P2-1: 反斜杠 .. 段（win 形态）→ 400，条目目录外文件不受影响', async () => {
    mkdirSync(join(studio.bookRoot, '设定', '角色'), { recursive: true })
    writeFileSync(join(studio.bookRoot, '设定', '角色', '林远.md'), '---\n---\n角色卡', 'utf-8')
    // 修复前：insideDir 只按 '/' 切段，`..\` 不产独立 '..' 段 → 放行；resolveWithinRoot
    // 的 resolve 把 \ 折叠后仍在书内 → 也放行 → 可删条目目录以外的书内文件
    const attack = '文风/条目/..\\..\\设定\\角色\\林远.md'
    const r = await req('DELETE', `/api/books/${encodeURIComponent(BOOK)}/style/entries`, { path: attack })
    expect(r.status).toBe(400)
    // 错误信封 = { code, error }（http.ts replyError，无 ok 字段）
    expect(r.json).toMatchObject({ code: 'BAD_INPUT' })
    expect(existsSync(join(studio.bookRoot, '设定', '角色', '林远.md'))).toBe(true)
  })

  it('R0913-win P2-1: 同型守卫覆盖 candidates/ignore（反斜杠穿越 → 400）', async () => {
    const r = await req('POST', `/api/books/${encodeURIComponent(BOOK)}/style/candidates/ignore`, {
      path: '文风/候选/..\\..\\设定\\x.md',
    })
    expect(r.status).toBe(400)
    expect(r.json).toMatchObject({ code: 'BAD_INPUT' })
  })
})
