/**
 * GET /rhythm 双轨端点集成测（块4 节奏预测）：
 * 启动 studio server + 临时长篇书（写作/正文 2 章 + 大纲/章纲 3 章含字数目标），
 * 验证 written 读正文、planned 读章纲、targetWords 求和、分布含未写章。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startServer } from '../../src/studio/server/index.js'

const BOOK = '节奏测试书'
const SHORT_BOOK = '反转缺口测试集'
let workDir = ''
let server: http.Server | undefined
let baseUrl = ''
let token = ''

function get(path: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl)
    const req = http.request(
      { host: u.hostname, port: u.port, path, method: 'GET', headers: { 'x-studio-token': token } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c.toString('utf-8')))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(data)
          } catch {
            /* 非 JSON 响应留 null */
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'clwriting-rhythm-'))
  mkdirSync(join(workDir, '.clwriting'), { recursive: true })
  writeFileSync(
    join(workDir, '.clwriting', 'books.jsonl'),
    JSON.stringify({ name: BOOK, path: BOOK, kind: 'long' }) + '\n' + JSON.stringify({ name: SHORT_BOOK, path: SHORT_BOOK, kind: 'short' }) + '\n',
  )
  const bookRoot = join(workDir, BOOK)
  mkdirSync(bookRoot, { recursive: true })
  writeFileSync(
    join(bookRoot, 'book.yaml'),
    'spec_version: 1\nkind: long\nbook:\n  title: 节奏测试书\n  genre: 玄幻\nhost: cc\n',
  )
  // 写作/正文（v2 结构，已写 2 章）
  mkdirSync(join(bookRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(bookRoot, '写作', '正文', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 叙事铺陈\n---\n\n正文一二三\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '写作', '正文', '0002-转折.md'),
    '---\n章号: 2\n标题: 转折\n钩子类型: 危机钩\n钩子强弱: 强\n情绪定位: 小爽\n场景: 战斗\n---\n\n正文四五六七八\n',
    'utf8',
  )
  // 大纲/章纲（规划 3 章含字数目标；第 3 章未写 → 测待写场景）
  mkdirSync(join(bookRoot, '大纲', '章纲'), { recursive: true })
  writeFileSync(
    join(bookRoot, '大纲', '章纲', '0001-开篇.md'),
    '---\n章号: 1\n标题: 开篇\n钩子类型: 悬念钩\n钩子强弱: 中\n情绪定位: 铺垫\n场景: 叙事铺陈\n字数目标: 3000\n---\n\n章纲正文\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '大纲', '章纲', '0002-转折.md'),
    '---\n章号: 2\n标题: 转折\n钩子类型: 危机钩\n钩子强弱: 强\n情绪定位: 大爽\n场景: 战斗\n字数目标: 3500\n---\n\n章纲正文\n',
    'utf8',
  )
  writeFileSync(
    join(bookRoot, '大纲', '章纲', '0003-未写.md'),
    '---\n章号: 3\n标题: 未写\n钩子类型: 渴望钩\n钩子强弱: 中\n情绪定位: 小爽\n场景: 对话\n字数目标: 2800\n---\n\n章纲正文\n',
    'utf8',
  )
  // 短篇书（反转缺口）：3 篇含核心反转，画像池 5 类
  const shortRoot = join(workDir, SHORT_BOOK)
  mkdirSync(shortRoot, { recursive: true })
  writeFileSync(
    join(shortRoot, 'book.yaml'),
    'spec_version: 1\nkind: short\nbook:\n  title: 反转缺口测试集\n  genre: 悬疑\nhost: cc\nshort:\n  profile: 悬疑反转\n  target_reversal_types: [死者反转, 真凶反转, 身份反转, 时间/记忆反转, 现实层反转]\n',
    'utf8',
  )
  mkdirSync(join(shortRoot, '写作', '正文'), { recursive: true })
  writeFileSync(
    join(shortRoot, '写作', '正文', '001-雨夜门铃.md'),
    '---\n篇号: 1\n标题: 雨夜门铃\n核心反转: 按门铃的来客就是三年前死在七号公寓的人\n---\n\n正文\n',
    'utf8',
  )
  writeFileSync(
    join(shortRoot, '写作', '正文', '002-中奖彩票.md'),
    '---\n篇号: 2\n标题: 中奖彩票\n核心反转: 主角不是中奖者而是替真正中奖者设局的调查员\n---\n\n正文\n',
    'utf8',
  )
  writeFileSync(
    join(shortRoot, '写作', '正文', '003-循环.md'),
    '---\n篇号: 3\n标题: 循环\n核心反转: 主角以为困在循环里，每次醒来都是自己删除记忆后的重试\n---\n\n正文\n',
    'utf8',
  )
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

describe('GET /rhythm 双轨（块4 节奏预测）', () => {
  it('长篇双轨：written 读正文、planned 读章纲', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
    expect(r.status).toBe(200)
    const j = r.json as {
      kind: string
      written: { count: number }
      planned: { count: number }
    }
    expect(j.kind).toBe('long')
    expect(j.written.count).toBe(2)
    expect(j.planned.count).toBe(3)
  })

  it('planned.targetWords 求和自章纲字数目标', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
    const j = r.json as { planned: { targetWords: number } }
    expect(j.planned.targetWords).toBe(3000 + 3500 + 2800)
  })

  it('written 分布按正文章统计', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
    const j = r.json as { written: { hookTypeDist: Record<string, number>; sceneDist: Record<string, number> } }
    expect(j.written.hookTypeDist['悬念钩']).toBe(1)
    expect(j.written.hookTypeDist['危机钩']).toBe(1)
    expect(j.written.sceneDist['战斗']).toBe(1)
  })

  it('planned 分布含未写章（章纲录了就算）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
    const j = r.json as { planned: { hookTypeDist: Record<string, number>; emotionDist: Record<string, number> } }
    expect(j.planned.hookTypeDist['渴望钩']).toBe(1) // 第 3 章未写但章纲录了
    expect(j.planned.emotionDist['小爽']).toBe(1)
  })

  it('wordCurve 仅含已写章（按章号排序）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
    const j = r.json as { wordCurve: { 章号: number; 标题: string; 字数: number }[] }
    expect(j.wordCurve).toHaveLength(2)
    expect(j.wordCurve[0]!.章号).toBe(1)
    expect(j.wordCurve[1]!.章号).toBe(2)
  })

  it('chapterDiff 逐章 join：对比/偏差/待写（D3）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(BOOK)}/rhythm`)
    const j = r.json as {
      chapterDiff: {
        章号: number
        状态: string
        钩子类型?: string
        钩子类型偏差?: boolean
        情绪定位?: string
        情绪定位偏差?: boolean
        场景偏差?: boolean
        字数?: string
      }[]
    }
    const d = j.chapterDiff
    expect(d).toHaveLength(3)
    expect(d.map((x) => x.章号)).toEqual([1, 2, 3])
    // 章 1 两边一致 → 对比、字段单值、无偏差
    const ch1 = d[0]!
    expect(ch1.状态).toBe('对比')
    expect(ch1.情绪定位).toBe('铺垫') // 一致 → 单值（非「铺垫→铺垫」）
    expect(ch1.情绪定位偏差).toBe(false)
    expect(ch1.钩子类型偏差).toBe(false)
    // 章 2 正文情绪(小爽) ≠ 章纲(大爽) → 偏差；钩子/场景一致
    const ch2 = d[1]!
    expect(ch2.状态).toBe('对比')
    expect(ch2.情绪定位).toBe('大爽→小爽')
    expect(ch2.情绪定位偏差).toBe(true)
    expect(ch2.钩子类型偏差).toBe(false)
    expect(ch2.场景偏差).toBe(false)
    expect(ch2.字数).toBe('3500/7') // 目标 3500 / 实际「正文四五六七八」7 字
    // 章 3 只章纲 → 待写，带规划值
    const ch3 = d[2]!
    expect(ch3.状态).toBe('待写')
    expect(ch3.钩子类型).toBe('渴望钩')
    expect(ch3.字数).toBe('2800')
  })

  it('短篇反转缺口：target 池 vs 已写篇归类（死者/真凶/时间记忆覆盖，身份/现实层缺失）', async () => {
    const r = await get(`/api/books/${encodeURIComponent(SHORT_BOOK)}/rhythm`)
    expect(r.status).toBe(200)
    const j = r.json as {
      kind: string
      reversalGap: { type: string; count: number; missing: boolean }[]
      reversalUnrecognized: number
    }
    expect(j.kind).toBe('short')
    // 3 篇核心反转：死者/真凶/时间记忆 各 1；身份/现实层 缺
    const gap = j.reversalGap
    expect(gap).toHaveLength(5)
    const byType = new Map(gap.map((g) => [g.type, g]))
    expect(byType.get('死者反转')?.count).toBe(1)
    expect(byType.get('真凶反转')?.count).toBe(1)
    expect(byType.get('时间/记忆反转')?.count).toBe(1)
    expect(byType.get('身份反转')?.missing).toBe(true)
    expect(byType.get('现实层反转')?.missing).toBe(true)
    // 3 篇全部归类到池内 → 无未识别
    expect(j.reversalUnrecognized).toBe(0)
  })
})
