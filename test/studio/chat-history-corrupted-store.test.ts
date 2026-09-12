/**
 * IR-8（独立重评 2026-09-02）：事件库损坏时 chat 只读端点 → 结构化 500
 * STORE_UNAVAILABLE + 人话 message（含 IR-2 损坏恢复指引），不再裸抛落 defineRoute
 * 兜底泛化文案。history 与 branches 两路同闸（audit 族同一 try/catch 形状，
 * 由 store-corruption 单测 + 同构收编覆盖，不重复起服）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { bookHash } from '../../src/events/store.js'

const BOOK = '损坏库测试书'
let studio: StudioHarness
let userDataPath = ''

beforeAll(async () => {
  // userData（事件库）由调用方创建/清理，bootStudio 只透传
  userDataPath = mkdtempSync(join(tmpdir(), 'clw-chat-corrupt-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-chat-corrupt-',
    userDataPath,
    dirs: ['项目'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 损坏库测试书\nhost: cc\n',
  })
  // 预置损坏库：session 目录 + 垃圾字节 db 文件（书根哈希命名，非零字节触发 NOTADB）
  const dbPath = join(userDataPath, 'clwriting', 'session', bookHash(studio.bookRoot) + '.db')
  mkdirSync(join(userDataPath, 'clwriting', 'session'), { recursive: true })
  writeFileSync(dbPath, 'corrupted events db, definitely not sqlite'.repeat(64))
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('IR-8 事件库损坏 → 结构化 500（chat 只读族）', () => {
  it('GET /chat/history → 500 STORE_UNAVAILABLE + 损坏恢复指引', async () => {
    const r = await fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/chat/history`)
    expect(r.status).toBe(500)
    const json = (await r.json()) as { code?: string; error?: string }
    expect(json.code).toBe('STORE_UNAVAILABLE')
    expect(json.error).toContain('事件库不可用')
    expect(json.error).toContain('损坏')
    expect(json.error).toContain('备份')
  })

  it('GET /chat/branches → 500 STORE_UNAVAILABLE（同闸）', async () => {
    const r = await fetch(`${studio.baseUrl}/api/books/${encodeURIComponent(BOOK)}/chat/branches`)
    expect(r.status).toBe(500)
    const json = (await r.json()) as { code?: string; error?: string }
    expect(json.code).toBe('STORE_UNAVAILABLE')
    expect(json.error).toContain('事件库不可用')
  })
})
