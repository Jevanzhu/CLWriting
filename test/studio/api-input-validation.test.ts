/**
 * R0916-7-P3-13（2026-09-25 源码质量评审批 3）回归：输入校验两套纪律的两处收口。
 *
 * ① /api/providers/models 手输分支复用连接参数校验单源（parseConnectionInput ← 与
 *    parseProviderInput 同源）：非法 protocol / 缺 scheme 的 baseUrl 就地 400 BAD_INPUT
 *    且文案指明字段——修复前这两格只做 as 断言，非法值直落 listModels（恰是 scheme 校验
 *    注释点名的「打错目标」面）后以 500 GEN_FAIL 收场；id 分支不受影响（凭据取已存配置）。
 * ② defineRoute 的 gate（parse 前置闸）：原本绕开 parse 的两个端点（/spawn、/auto-write）
 *    改 gate+parse——忙闸仍先于 body 校验（409 非 400，即原绕开的唯一理由）；非法体由
 *    parse 拦截即 400 且 handler 未被调用（无 session / 无 self-heal 登记）；gate 内
 *    holdSpawnGate 的占位由统一收尾释放（不泄漏、不少放）。
 *
 * 表驱动地逐个覆盖合法性 / 前置优先级的迁移点见 api-input-validation-migrated.test.ts。
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { isSpawnRunning, __setSpawnRunning } from '../../src/studio/server/api/stream.js'
import { isSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'
import { waitInFlightWorkSettled } from '../../src/studio/server/api/in-flight-work.js'
import { getSession } from '../../src/driver/index.js'

const BOOK = '校验纪律书'
const BOOK_B = '校验纪律书乙'

let studio: StudioHarness
/** providers 族与 /auto-write 都需要应用级数据目录（缺 = 400 NO_USERDATA），本文件自建自清 */
let userDataPath = ''
const bp = (suffix: string): string => `/api/books/${encodeURIComponent(BOOK)}${suffix}`
const bpB = (suffix: string): string => `/api/books/${encodeURIComponent(BOOK_B)}${suffix}`

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-p313-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-p313-validation-',
    userDataPath,
    // 合法体臂：listModels/probe/写稿走 mock 快路（不出网、不等真实生成）
    env: { CLWRITING_DRIVER: 'mock' },
    dirs: ['写作/正文', '设定'],
    bookYaml: 'spec_version: 1\nkind: long\nbook:\n  title: 校验纪律书\n  genre: 玄幻\nhost: cc\n',
  })
  // 第二本：合法体臂各自起 fire-and-forget 编排，分书避免「上一臂在途闸」影响下一臂
  mkdirSync(join(studio.workDir, BOOK_B), { recursive: true })
  writeFileSync(
    join(studio.workDir, BOOK_B, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 校验纪律书乙\n  genre: 玄幻\nhost: cc\n',
  )
  writeFileSync(
    join(studio.workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) +
      '\n' +
      JSON.stringify({ name: BOOK_B, path: BOOK_B, kind: 'long' }) +
      '\n',
  )
})

afterAll(async () => {
  // 合法体臂起了写稿/全自动写章（fire-and-forget）——等后台编排落定再关服
  await waitInFlightWorkSettled(10_000)
  await studio.close()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('P3-13 ① /api/providers/models 连接参数校验（parseConnectionInput 单源）', () => {
  it('非法 protocol → 400 且文案指 protocol（不再由 listModels 兜成 500 GEN_FAIL）', async () => {
    const r = await studio.req('POST', '/api/providers/models', {
      protocol: 'gemini',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-abcdef1234567890',
    })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'protocol 需为 anthropic / openai / openai-responses' })
  })

  it('baseUrl 缺 scheme → 400 且文案指 baseUrl', async () => {
    const r = await studio.req('POST', '/api/providers/models', {
      protocol: 'openai',
      baseUrl: 'api.example.com/v1',
      apiKey: 'sk-abcdef1234567890',
    })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'baseUrl 须以 http(s):// 开头' })
  })

  it('apiKey 含不可传输字符 → 400（同一单源的传输不变量，文案不回显 key 本体）', async () => {
    const r = await studio.req('POST', '/api/providers/models', {
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-abc def',
    })
    expect(r.status).toBe(400)
    expect((r.json as { code: string }).code).toBe('BAD_INPUT')
    expect(String((r.json as { error: string }).error)).toContain('API Key 含 HTTP 头无法传输的字符')
  })

  it('id 分支不受连接校验影响：未登记 id 走既有 404', async () => {
    const r = await studio.req('POST', '/api/providers/models', { id: 'p_not_registered' })
    expect(r.status).toBe(404)
    expect(r.json).toEqual({ code: 'NOT_FOUND', error: '供应商不存在' })
  })

  it('合法手输体照常 → 200（mock 短路 listModels，证明校验放行而非拦死）', async () => {
    const r = await studio.req('POST', '/api/providers/models', {
      protocol: 'anthropic',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-abcdef1234567890',
    })
    expect(r.status).toBe(200)
    expect((r.json as { models: string[] }).models.length).toBeGreaterThan(0)
  })
})

describe('P3-13 ② gate（parse 前置闸）在绕开端点生效', () => {
  it('/spawn 非法体 → parse 400，handler 未被调用（无 session；占位闸由 cleanup 释放）', async () => {
    expect(getSession(BOOK)).toBeNull() // 前置条件：本文件尚无任何 spawn 建过会话
    const r = await studio.req('POST', bp('/spawn'), { role: 'writer', prompt: '   ' })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'prompt 不能为空（请先拉取 /draft-prompt 组写稿上下文）' })
    // handler 首句即 ensureSession——handler 未被调用则无会话（旧实现由 handler 内校验自回 400）
    expect(getSession(BOOK)).toBeNull()
    // gate 内 holdSpawnGate 的占位：parse 失败后由 defineRoute 的闸收尾释放
    expect(isSpawnRunning(BOOK)).toBe(false)
  })

  it('/spawn 忙闸在持 + 非法体 → 409（闸先于 body 校验，原绕开 parse 的唯一理由）', async () => {
    __setSpawnRunning(BOOK, true)
    try {
      const r = await studio.req('POST', bp('/spawn'), {}) // 空 prompt 的非法体也必须先吃 409
      expect(r.status).toBe(409)
      expect((r.json as { code?: string }).code).toBe('BUSY')
    } finally {
      __setSpawnRunning(BOOK, false)
    }
  })

  it('/spawn 未知 role → 400 且文案指 role（白名单校验随 parse 前置，handler 不进）', async () => {
    const r = await studio.req('POST', bp('/spawn'), { role: 'rewriter', prompt: '写一段' })
    expect(r.status).toBe(400)
    expect(String((r.json as { error: string }).error)).toContain('未知角色 role=rewriter')
    expect(getSession(BOOK)).toBeNull()
  })

  it('/auto-write 非法体 → parse 400，handler 未被调用（无 session / 无 self-heal 登记）', async () => {
    const r = await studio.req('POST', bp('/auto-write'), { chapter: 0 })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'chapter 需为正整数' })
    expect(getSession(BOOK)).toBeNull()
    expect(isSelfHealRunning(BOOK)).toBe(false)
  })

  it('/auto-write batchSize 越界 → 400（同一 parse 的第二道门）', async () => {
    const r = await studio.req('POST', bp('/auto-write'), { chapter: 1, batchSize: 21 })
    expect(r.status).toBe(400)
    expect(r.json).toEqual({ code: 'BAD_INPUT', error: 'batchSize 需为 1-20 的整数' })
  })

  it('/auto-write 忙闸在持 + 非法体 → 409（首检即拦，不进 chapter 校验）', async () => {
    __setSpawnRunning(BOOK, true) // spawn 在持 = auto-write 忙闸信号之一
    try {
      const r = await studio.req('POST', bp('/auto-write'), { chapter: 0 })
      expect(r.status).toBe(409)
      expect((r.json as { code?: string }).code).toBe('BUSY')
    } finally {
      __setSpawnRunning(BOOK, false)
    }
  })

  it('合法体照常：/spawn → 200（handler 这次被调用，会话已建）', async () => {
    const r = await studio.req('POST', bp('/spawn'), { role: 'writer', prompt: '写第一章' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, role: 'writer' })
    expect(getSession(BOOK)).not.toBeNull()
  })

  it('合法体照常：/auto-write → 200（另起一本，避开上一臂的写稿在途）', async () => {
    const r = await studio.req('POST', bpB('/auto-write'), { chapter: 1 })
    expect(r.status).toBe(200)
    expect((r.json as { ok: boolean }).ok).toBe(true)
  })
})
