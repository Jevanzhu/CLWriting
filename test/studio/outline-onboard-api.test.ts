/**
 * outline / onboard 端点集成测试（评审 §六测试盲区：outline/onboard 端点零 spec）。
 *
 * 核心回归：P0-1 mockText 守卫——非 mock 装配下 mockText 不短路，
 * 端点走 resolveProvider（无 provider → 500 NO_PROVIDER），而非返回 mock 文本。
 *
 * mock 环境：验证 mock 快路正常返回 + 落盘。
 * 非 mock 环境：验证 mockText 守卫生效（不走 mock 快路）。
 *
 * R0916-7-P3-6：mock / 非 mock 由**组装根**在装配期定（CLWRITING_DRIVER 只在
 * driver-port.ts 的宿主里读一次，runner 侧不再按调用期读环境变量），故两类形态各起
 * 一个实例、非 mock 形态排在 mock 形态之后（同进程内装配开关后装配者生效——与旧
 * 实现「调用期读 env」的进程级语义同位，此处按用例所需顺序装配）。
 *
 * 测试精简批（2026-09-12）：启动样板收编 bootStudio——CLWRITING_DRIVER=mock 的
 * prev/保存还原对改 env 选项（close 时统一还原；用例内的临时删/复原有其自身节奏，
 * 保持原样）；userDataPath 由本文件自建自清；req 走 node:http（手工
 * content-length、无 origin）形态保留本地，改绑 studio.baseUrl/studio.token。
 */
import http from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'

const BOOK = '大纲测试书'
const BOOK_YAML =
  'spec_version: 1\nkind: long\nbook:\n  title: 大纲测试书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: []\n'
let studio: StudioHarness
let workDir = ''
let userDataPath = ''

function reqOn(
  base: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(base)
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

let realStudio: StudioHarness
let realUserDataPath = ''

beforeAll(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'clwriting-outline-ud-'))
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clwriting-outline-',
    userDataPath,
    env: { CLWRITING_DRIVER: 'mock' },
    dirs: ['写作/正文', '大纲'],
    bookYaml: BOOK_YAML,
  })
  workDir = studio.workDir
})

afterAll(async () => {
  await studio.close()
  if (userDataPath) rmSync(userDataPath, { recursive: true, force: true })
})

describe('POST /outline（大纲生成）', () => {
  it('mock 组装 → 200 + mock 文本落盘', async () => {
    const r = await reqOn(studio.baseUrl, studio.token, 'POST', `/api/books/${encodeURIComponent(BOOK)}/outline`, {
      chapter: 1,
    })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; words: number; path: string }
    expect(body.ok).toBe(true)
    expect(body.words).toBeGreaterThan(0)
    // 落盘验证（细纲路径：工作区/细纲.md）
    const bookRoot = join(workDir, BOOK)
    expect(existsSync(join(bookRoot, '工作区', '细纲.md'))).toBe(true)
  })
})

describe('POST /onboard-ai（开书引导）', () => {
  it('mock 组装 → 200 + mock 设定落盘', async () => {
    const r = await reqOn(studio.baseUrl, studio.token, 'POST', `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`, {
      step: 'synopsis',
    })
    expect(r.status).toBe(200)
    const body = r.json as { ok: boolean; words: number; step: string; path: string }
    expect(body.ok).toBe(true)
    expect(body.step).toBe('synopsis')
    expect(body.words).toBeGreaterThan(0)
    // 落盘验证
    const bookRoot = join(workDir, BOOK)
    expect(existsSync(join(bookRoot, '大纲', '总纲.md'))).toBe(true)
  })
})

/**
 * 非 mock 组装（CLWRITING_DRIVER 缺省 = cc，userData 无 providers.json）：
 * 独立实例 + 独立工作区，钉 P0-1 守卫的另一侧。置 mock 用例之后——装配开关是
 * 进程级（同旧 env 读法），后装配者的 kind 对后续调用生效。
 */
describe('非 mock 组装：mockText 不短路（P0-1 回归）', () => {
  beforeAll(async () => {
    realUserDataPath = mkdtempSync(join(tmpdir(), 'clwriting-outline-real-ud-'))
    realStudio = await bootStudio({
      book: BOOK,
      prefix: 'clwriting-outline-real-',
      userDataPath: realUserDataPath,
      env: { CLWRITING_DRIVER: undefined }, // 非 mock 装配（生产口径）
      dirs: ['写作/正文', '大纲'],
      bookYaml: BOOK_YAML,
    })
  })

  afterAll(async () => {
    await realStudio.close()
    if (realUserDataPath) rmSync(realUserDataPath, { recursive: true, force: true })
  })

  it('outline 非 mock + 无 provider → 400 NO_PROVIDER（mockText 不短路，P0-1 回归；R43-24 code 映射）', async () => {
    const r = await reqOn(
      realStudio.baseUrl,
      realStudio.token,
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/outline`,
      { chapter: 1 },
    )
    // R43-24（四十三轮）：outline 失败封套透传 TaskCode——NO_PROVIDER 族由 500 GEN_FAIL
    // 改映射 400（配置缺失是客户端可处置），文案不变；P0-1 回归语义仍在（非 mock
    // 不走 mockText 短路，真实走到 provider 解析失败）
    expect(r.status).toBe(400)
    const j = r.json as { code: string; error: string }
    expect(j.code).toBe('NO_PROVIDER')
    expect(j.error).toContain('未配置')
  })

  it('onboard-ai 非 mock + 无 provider → 500（mockText 不短路，P0-1 回归）', async () => {
    const r = await reqOn(
      realStudio.baseUrl,
      realStudio.token,
      'POST',
      `/api/books/${encodeURIComponent(BOOK)}/onboard-ai`,
      { step: 'characters' },
    )
    expect(r.status).toBe(500)
    expect((r.json as { error: string }).error).toContain('未配置')
  })
})
