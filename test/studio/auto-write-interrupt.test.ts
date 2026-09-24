/**
 * /auto-write → /interrupt 端点级回归：端点必须把真实 driver 交给编排器（不丢中断能力）。
 *
 * 文件头锚注：源码锚 src/studio/server/api/stream.ts（books.auto-write 的 runSelfHeal 调用）
 * 与 src/ai/orchestrate/self-heal.ts（SelfHealOpts.onActivity）。
 *
 * 修复前：端点为复位 watchdog 手写包装 driver，对象只列
 * startSession/stream/dispose/emit 四个成员，registerCtrl/unregisterCtrl/isRunning/
 * interrupt 全部丢失。self-heal 通过后用它启动后台账本推进草稿（runRegisteredBgTask，
 * owner `bg-lead-draft:<书名>`），登记落空，ctrl 从未进入真实 driver——作者点「中断」时
 * 各项全假，回 interrupted:false，该调用只能等自然完成或 10 分钟总超时。
 *
 * 修复后：端点不再包装 driver（进度经 onActivity 回调复位 watchdog），真 driver 直通，
 * 后台草稿的 ctrl 登记进真实 driver，/interrupt 命中并 abort，后台任务随即收口。
 * 本用例即钉这条端到端通道：任何「交出去的 driver 丢中断能力」的改法都会让它红。
 *
 * 驱动方式：真实 server + cc driver（不设 CLWRITING_DRIVER=mock）+ 进程内 fake provider
 *（首条 submit_chapter 立即完成，第二条账本草稿 delayMs 挂起制造在途窗口）。
 */
import http from 'node:http'
import { rmSync } from 'node:fs'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { bootStudio, type StudioHarness } from '../helpers/studio-server.js'
import { waitFor } from '../helpers/wait-for.js'
import { createFakeProvider, type FakeProvider } from '../ai/fake-provider.js'
import { withFakeProvider, tempUserData } from './fixtures.js'
import { getSession } from '../../src/driver/index.js'
import { ccDriver } from '../../src/driver/cc.js'
import { isSelfHealRunning } from '../../src/ai/orchestrate/self-heal.js'
import { hasBackgroundTasks } from '../../src/ai/orchestrate/background.js'

const BOOK = '自动写章中断通道书'
let studio: StudioHarness
let userDataDir = ''
let fake: FakeProvider

/** 后台账本草稿在途：编排闸已释放，但 driver 仍持有未中止的 ctrl */
function bgDraftInFlight(): boolean {
  if (isSelfHealRunning(BOOK)) return false
  const s = getSession(BOOK)
  return s !== null && (ccDriver.isRunning?.(s) ?? false)
}

function post(path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(studio.baseUrl)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: 'POST',
        headers: {
          'x-studio-token': studio.token,
          origin: studio.baseUrl,
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

beforeAll(async () => {
  fake = await createFakeProvider()
  userDataDir = tempUserData()
  withFakeProvider(userDataDir, fake.url)
  studio = await bootStudio({
    book: BOOK,
    prefix: 'clw-autowrite-int-',
    userDataPath: userDataDir,
    env: { CLWRITING_DRIVER: undefined }, // cc driver：registerCtrl/isRunning/interrupt 真实
    dirs: ['写作/正文', '布线/悬念', '文风', '工作区', '项目'],
    bookYaml:
      'spec_version: 1\nkind: long\nbook:\n  title: 自动写章中断通道书\n  genre: 玄幻\nhost: cc\nleads:\n  enabled: [悬念]\nbudget:\n  calls_per_chapter: 8\n',
    files: [
      {
        // 履历留空：履历证据必须在对应章正文命中，预置证据会让首稿机检红项 lead-evidence-miss
        rel: '布线/悬念/悬念-001-玉佩.md',
        content: '---\n编号: 悬念-001\n标题: 玉佩\n类型: 悬念\n状态: 进行中\n开启章: 1\n---\n## 履历\n',
      },
      // 不写「推进」键：任何非空值（含「无」）都按声明编号解析，未兑现即红项 lead-declared-not-done
      { rel: '工作区/细纲.md', content: '---\n章号: 1\n---\n# 细纲\n' },
      { rel: '文风/文风铁律.md', content: '# 文风铁律\n\n## 禁词\n\n顿时\n' },
    ],
  })
})

afterAll(async () => {
  await studio.close()
  if (fake) await fake.close()
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
})

describe('/auto-write 后台账本草稿的中断通道', () => {
  it('编排通过后草稿仍在途 → /interrupt 命中并中断 → 后台任务收口', { timeout: 90_000 }, async () => {
    fake.setScript([
      // 首稿：机检全绿（铁律禁词「顿时」不命中）→ pass → 启动后台账本草稿
      {
        type: 'tool',
        name: 'submit_chapter',
        input: {
          标题: '初入宗门',
          钩子类型: '悬念钩',
          钩子强弱: '中',
          情绪定位: '铺垫',
          正文: '林远踏入宗门，山门古拙，青石阶上苔痕斑驳。',
        },
      },
      // 账本推进草稿：挂起制造在途窗口（中断后客户端断开，响应被静默丢弃）
      { type: 'text', content: '- 悬念-001 递进：玉佩在胸前微微发光', delayMs: 20_000 },
    ])

    const launched = await post(`/api/books/${encodeURIComponent(BOOK)}/auto-write`, { chapter: 1 })
    expect(launched.status).toBe(200)
    expect(launched.json['ok']).toBe(true)

    await waitFor(bgDraftInFlight, 30_000, 50, '后台账本草稿 ctrl 登记（编排闸已释放、driver.isRunning 仍真）')
    expect(hasBackgroundTasks(BOOK)).toBe(true)

    const ir = await post(`/api/books/${encodeURIComponent(BOOK)}/interrupt`)
    expect(ir.status).toBe(200)
    expect(ir.json).toMatchObject({ ok: true, interrupted: true })

    await waitFor(() => !hasBackgroundTasks(BOOK), 10_000, 50, '后台账本草稿任务随中断收口')
  })
})
