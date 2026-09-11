/**
 * R0912-P2-① / R0912-P3-③（2026-09-11 重评-0911c 修复批）回归：task-gate 族端点接中断通道。
 *
 * 背景：重评-0911c 确认 /interrupt 对 task-gate 族完全无效且假成功——七个生成端点
 * （outline / lead-updates / review / analysis(analyze) / onboard / settings(relations-mine) /
 * rewrite）的 runSpec 均未接 driver ctrl 注册面。本批统一接线（register/unregister 形态照抄
 * stream.ts spawn/self-heal，owner='<task>:<书名>'）后：
 * - 每端点「注册 → /interrupt 真中断 → ABORTED 信封（499 + error='已中断'）」；
 * - 每端点「settle（成功）后注销」——driver.isRunning 归 false（cc X-P2-11 口径）；
 * - relations-mine 落盘前 BOOK_MOVED 重验（R0912-P3-③，对齐 style.ts R0911-B-P3-4）
 *   的 busy / moved 两臂。
 *
 * 驱动方式：真实 server + cc driver（不设 CLWRITING_DRIVER=mock，registerCtrl/isRunning/
 * interrupt 真实）+ 进程内 fake provider（delayMs 制造在途窗口，Z-P1-1 中断测试同款）。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServerSafe } from '../helpers/safe-port.js'
import { waitFor } from '../helpers/wait-for.js'
import { createFakeProvider, type FakeProvider } from '../ai/fake-provider.js'
import { withFakeProvider, tempUserData } from './fixtures.js'
// 与 server 同进程共享 driver 模块实例：getSession/isRunning 直读端点注册面
import { getSession } from '../../src/driver/index.js'
import { ccDriver } from '../../src/driver/cc.js'
import { acquireTaskGate } from '../../src/studio/server/api/task-gate.js'

const BOOK = 'R0912中断通道书'
const DOC_ID = 'doc-r0912-0001'
let workDir = ''
let bookRoot = ''
let userDataDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''
const prevDriver = process.env['CLWRITING_DRIVER']
let fake: FakeProvider

/** 在途判定：端点编排段的 ctrl 已登记到该书 session（注册面生效） */
function inFlight(): boolean {
  const s = getSession(BOOK)
  return s !== null && (ccDriver.isRunning?.(s) ?? false)
}

function post(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': token,
          origin: baseUrl,
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : { 'content-length': '0' }),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf8')))
        res.on('end', () => {
          let json: Record<string, unknown> = {}
          try {
            json = JSON.parse(data) as Record<string, unknown>
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

const bp = (seg: string): string => `/api/books/${encodeURIComponent(BOOK)}${seg}`
const interruptPath = bp('/interrupt')

/** 中断臂共享断言：脚本挂起 → 在途 → /interrupt 真中断 → ABORTED 信封（499 + 已中断） */
async function assertInterrupt(path: string, body?: unknown, label = '端点'): Promise<void> {
  const p = post(path, body)
  await waitFor(inFlight, 4000, 20, `${label} ctrl 注册（driver.isRunning 判真）`)
  const ir = await post(interruptPath)
  expect(ir.status).toBe(200)
  expect(ir.json).toMatchObject({ ok: true, interrupted: true })
  const r = await p
  expect(r.status).toBe(499)
  expect(r.json).toMatchObject({ code: 'ABORTED', error: '已中断' })
}

/** 注销臂共享断言：脚本短延时 → 在途窗口可见 → 成功 settle → isRunning 归 false */
async function assertSettleUnregisters(path: string, body: unknown, expectOk: (json: Record<string, unknown>) => void, label = '端点'): Promise<void> {
  const p = post(path, body)
  await waitFor(inFlight, 4000, 20, `${label} ctrl 注册（driver.isRunning 判真）`)
  const r = await p
  expect(r.status).toBe(200)
  expectOk(r.json)
  // reply 后 finally 同步执行（先于客户端 end 事件）——此刻注销必已完成
  expect(inFlight()).toBe(false)
}

beforeAll(async () => {
  delete process.env['CLWRITING_DRIVER'] // cc driver：registerCtrl/isRunning/interrupt 真实
  fake = await createFakeProvider()
  workDir = mkdtempSync(join(tmpdir(), 'clw-r0912-endpoint-int-'))
  userDataDir = tempUserData()
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n',
  )
  bookRoot = join(workDir, BOOK)
  // 章节文件（outline/lead-updates 走 readChapterDir；review/analyze/rewrite 经 manifest docId 直读）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-初入宗门.md'),
    '---\n章号: 1\n标题: 初入宗门\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 对话\n---\n林远踏入宗门，山门古拙，青石阶上苔痕斑驳。玉佩在胸前微微发光，温热如心跳。他抬手按住玉佩，那光芒便敛去，仿佛从未出现过。\n\n"你是新弟子？"长老问道，目光落在玉佩上，忽然一颤。\n\n林远点头，心中疑惑玉佩的来历，却忽然感到一阵锥心之痛，仿佛有什么在血里苏醒。',
    'utf8',
  )
  // 账本（进行中悬念：lead-updates 草拟 + 机检账本核对数据源）
  mkdirSync(join(bookRoot, '布线', '悬念'), { recursive: true })
  writeFileSync(
    join(bookRoot, '布线', '悬念', '悬念-001-玉佩.md'),
    '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n## 履历\n- 第1章 埋下：「玉佩在胸前微微发光」\n',
    'utf8',
  )
  // 名册（relations-mine 梳理材料非空）
  mkdirSync(join(bookRoot, '设定'), { recursive: true })
  writeFileSync(join(bookRoot, '设定', '名册.md'), '# 名册\n- 林远：新弟子\n- 赵长老：执剑长老\n', 'utf8')
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: R0912中断通道书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: [悬念]\nbudget:\n  calls_per_chapter: 8\n',
    'utf8',
  )
  // 文档清单（review/analyze/rewrite 的 docId 直读）
  mkdirSync(join(bookRoot, '项目'), { recursive: true })
  writeFileSync(
    join(bookRoot, '项目', '文档清单.jsonl'),
    [
      JSON.stringify({ version: 1, type: 'header' }),
      JSON.stringify({ id: DOC_ID, nodeType: 'document', path: '写作/正文/0001-初入宗门.md', parentId: null }),
    ].join('\n') + '\n',
    'utf8',
  )
  // fake provider：creative 档（outline/onboard/lead-updates/rewrite）；review/analysis/
  // relations-mine 的 assistant 档缺省回落 creative（tierFromStore），同打 fake stub
  withFakeProvider(userDataDir, fake.url)
  writeFileSync(join(userDataDir, 'global.json'), '{}', 'utf8')

  server = await startServerSafe({ port: 0, workDir, userDataPath: userDataDir })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const boot = await (await fetch(`${baseUrl}/api/boot`)).json()
  token = (boot as { token: string }).token
})

afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((r) => server!.close(() => r()))
  }
  if (fake) await fake.close()
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
  if (prevDriver === undefined) delete process.env['CLWRITING_DRIVER']
  else process.env['CLWRITING_DRIVER'] = prevDriver
})

describe('R0912-P2-①: outline 中断通道', () => {
  it('注册 → /interrupt 真中断 → 499 ABORTED 信封', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'text', content: '# 细纲', delayMs: 3000 }])
    await assertInterrupt(bp('/outline'), { chapter: 1 }, 'outline')
  })

  it('settle 后注销（isRunning 归 false）', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'text', content: '第1章：主角进山，玉佩异动。\n\n推进: 无', delayMs: 300 }])
    await assertSettleUnregisters(
      bp('/outline'),
      { chapter: 1 },
      (json) => {
        expect(json['ok']).toBe(true)
        expect(json['path']).toBe('工作区/细纲.md')
      },
      'outline',
    )
  })
})

describe('R0912-P2-①: lead-updates 中断通道', () => {
  it('注册 → /interrupt 真中断 → 499 ABORTED 信封', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'text', content: '- 悬念-001 递进：玉佩在胸前微微发光', delayMs: 3000 }])
    await assertInterrupt(bp('/lead-updates'), { chapter: 1 }, 'lead-updates')
  })

  it('settle 后注销（isRunning 归 false）', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'text', content: '- 悬念-001 递进：玉佩在胸前微微发光', delayMs: 300 }])
    await assertSettleUnregisters(
      bp('/lead-updates'),
      { chapter: 1 },
      (json) => {
        expect(json['ok']).toBe(true)
        expect(json['count']).toBe(1)
      },
      'lead-updates',
    )
  })
})

describe('R0912-P2-①: review 三审中断通道', () => {
  it('注册 → /interrupt 真中断 → 499 ABORTED 信封', { timeout: 15_000 }, async () => {
    // 逐 lens runSpec 重复脚本尾条；中断发生在首 lens 在途窗口
    fake.setScript([{ type: 'tool', name: 'submit_issues', input: { issues: [] }, delayMs: 3000 }])
    await assertInterrupt(bp(`/documents/${DOC_ID}/review`), undefined, 'review')
  })

  it('settle 后注销（isRunning 归 false）', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'submit_issues', input: { issues: [] }, delayMs: 300 }])
    await assertSettleUnregisters(
      bp(`/documents/${DOC_ID}/review`),
      undefined,
      (json) => {
        expect(json['ok']).toBe(true)
        expect(Array.isArray(json['lenses'])).toBe(true)
      },
      'review',
    )
  })
})

describe('R0912-P2-①: analysis(analyze) 中断通道', () => {
  it('注册 → /interrupt 真中断 → 499 ABORTED 信封', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'submit_score', input: { score: 8, dims: {} }, delayMs: 3000 }])
    await assertInterrupt(bp(`/documents/${DOC_ID}/analyze`), { kind: 'score' }, 'analyze')
  })

  it('settle 后注销（isRunning 归 false）', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'submit_score', input: { score: 8, dims: {} }, delayMs: 300 }])
    await assertSettleUnregisters(
      bp(`/documents/${DOC_ID}/analyze`),
      { kind: 'score' },
      (json) => {
        expect(json['ok']).toBe(true)
        expect(json['envelope']).toBeTruthy()
      },
      'analyze',
    )
  })
})

describe('R0912-P2-①: onboard 中断通道', () => {
  it('注册 → /interrupt 真中断 → 499 ABORTED 信封', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'text', content: '# 总纲', delayMs: 3000 }])
    await assertInterrupt(bp('/onboard-ai'), { step: 'synopsis' }, 'onboard')
  })

  it('settle 后注销（isRunning 归 false）', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'text', content: '# 总纲\n玄幻：少年林远修真。', delayMs: 300 }])
    await assertSettleUnregisters(
      bp('/onboard-ai'),
      { step: 'synopsis' },
      (json) => {
        expect(json['ok']).toBe(true)
        expect(json['step']).toBe('synopsis')
      },
      'onboard',
    )
  })
})

describe('R0912-P2-①: rewrite 中断通道', () => {
  it('注册 → /interrupt 真中断 → 499 ABORTED 信封', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'submit_text', input: { 正文: '改写后的正文' }, delayMs: 3000 }])
    await assertInterrupt(bp(`/documents/${DOC_ID}/rewrite`), { instruction: '更紧凑' }, 'rewrite')
  })

  it('settle 后注销（isRunning 归 false）', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'submit_text', input: { 正文: '改写后的正文，与原文完全不同，节奏更紧凑。' }, delayMs: 300 }])
    await assertSettleUnregisters(
      bp(`/documents/${DOC_ID}/rewrite`),
      { instruction: '更紧凑' },
      (json) => {
        expect(json['ok']).toBe(true)
        expect(json['mode']).toBe('whole')
      },
      'rewrite',
    )
  })
})

describe('R0912-P2-①: settings(relations-mine) 中断通道', () => {
  it('注册 → /interrupt 真中断 → 499 ABORTED 信封', { timeout: 15_000 }, async () => {
    fake.setScript([{ type: 'tool', name: 'submit_relations', input: { relations: [] }, delayMs: 3000 }])
    await assertInterrupt(bp('/relations/mine'), { force: true }, 'relations-mine')
  })

  it('settle 后注销（isRunning 归 false）', { timeout: 15_000 }, async () => {
    fake.setScript([
      {
        type: 'tool',
        name: 'submit_relations',
        input: { relations: [{ from: '林远', to: '赵长老', type: '师徒', note: '名册' }] },
        delayMs: 300,
      },
    ])
    await assertSettleUnregisters(
      bp('/relations/mine'),
      { force: true },
      (json) => {
        expect(json['ok']).toBe(true)
        expect(json['cached']).toBe(false)
      },
      'relations-mine',
    )
  })
})

describe('R0912-P3-③: relations-mine 落盘前重验两臂', () => {
  it('busy 臂：任务闸被持 → 409 BUSY（并发闸语义不因接线改变）', { timeout: 15_000 }, async () => {
    const release = acquireTaskGate(BOOK, 'relations-mine')
    expect(release).not.toBeNull()
    try {
      const r = await post(bp('/relations/mine'), { force: true })
      expect(r.status).toBe(409)
      expect(r.json).toMatchObject({ code: 'BUSY', error: '本书正在梳理角色关系，请等待完成后再试' })
    } finally {
      release?.()
    }
  })

  it('moved 臂：AI 在途窗口内书被除名 → 409 BOOK_MOVED，不向旧根落盘', { timeout: 15_000 }, async () => {
    const booksJsonl = join(workDir, '.clwriting', 'books.jsonl')
    const original = JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n'
    // 前置用例（settle 臂）已落过缓存——清掉再验「moved 后不落盘」
    rmSync(join(bookRoot, '.clwriting', 'relations.json'), { force: true })
    fake.setScript([{ type: 'tool', name: 'submit_relations', input: { relations: [] }, delayMs: 1500 }])
    try {
      const p = post(bp('/relations/mine'), { force: true })
      await waitFor(inFlight, 4000, 20, 'relations-mine ctrl 注册（moved 臂）')
      // 在途窗口内书被除名（改名/删书语义）——resolveBook 捕获根失配
      writeFileSync(booksJsonl, JSON.stringify({ name: 'R0912已搬走的书', path: BOOK, kind: 'long' }) + '\n', 'utf8')
      const r = await p
      expect(r.status).toBe(409)
      expect(r.json).toMatchObject({
        code: 'BOOK_MOVED',
        error: '书已改名或已删除，本次操作已取消——请重新打开本书后再试',
      })
      // 旧根未落 relations.json（幽灵目录防线）
      expect(existsSync(join(bookRoot, '.clwriting', 'relations.json'))).toBe(false)
    } finally {
      writeFileSync(booksJsonl, original, 'utf8')
    }
  })
})
