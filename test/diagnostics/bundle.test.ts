/**
 * 诊断包收集器（src/diagnostics/index.ts）单测——口径与隐私红线逐条锚定：
 * 基础集内容（环境/配置白名单/近 7 天日志）、**书稿正文与密钥永不入包**、
 * 路径脱敏、落点与命名、缺 userDataPath 的失败面。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDiagnosticsBundle } from '../../src/diagnostics/index.js'
import { readZipStore } from '../helpers/zip-read.js'

/** 固定生成时刻：2026-10-10 12:30:40 本地时（日志文件名/包名与之一致） */
const NOW = new Date(2026, 9, 10, 12, 30, 40)
const TODAY_LOG = 'app-20261010.jsonl'
/** 10 天前（超出保留期/收集窗） */
const OLD_LOG = 'app-20260930.jsonl'
const LEAK_KEY = 'sk-test-LEAK-1234567890abcdef'
const LEAK_RAG_KEY = 'sk-ant-LEAK-RAG-abcdefghijklmnop'
const BOOK_MARKER = 'MARKER-书稿正文-绝不入包'
const BASE_URL = 'https://gw.example.com/v1'

let ud = ''
let work = ''

beforeEach(() => {
  ud = mkdtempSync(join(tmpdir(), 'clw-diag-ud-'))
  work = mkdtempSync(join(tmpdir(), 'clw-diag-work-'))
  // 日志：今日（含密钥泄漏形态与绝对路径）+ 10 天前（应被排除）
  mkdirSync(join(ud, 'logs'), { recursive: true })
  writeFileSync(
    join(ud, 'logs', TODAY_LOG),
    [
      JSON.stringify({
        ts: '2026-10-10T04:30:00.000Z',
        level: 'error',
        tag: 'ai',
        msg: `401 ${BASE_URL}?api_key=${LEAK_KEY}`,
      }),
      JSON.stringify({
        ts: '2026-10-10T04:31:00.000Z',
        level: 'info',
        tag: 'fs',
        msg: `写入 ${join(ud, 'logs')} 与 ${homedir()} 下 ${join(work, '书A')}`,
      }),
      '半行非 JSON：' + LEAK_KEY,
    ].join('\n') + '\n',
    'utf-8',
  )
  writeFileSync(join(ud, 'logs', OLD_LOG), JSON.stringify({ msg: '十天前' }) + '\n', 'utf-8')
  // 供应商：协议/模型名允许进包；key 与接口地址不得进包
  writeFileSync(
    join(ud, 'providers.json'),
    JSON.stringify({
      providers: [
        {
          id: 'p1',
          name: '我的中转',
          protocol: 'openai-responses',
          auth: 'bearer',
          baseUrl: BASE_URL,
          apiKey: LEAK_KEY,
          models: [{ model: 'gpt-5' }, { model: 'gpt-5-mini' }],
        },
      ],
      currentId: 'p1',
      currentModel: 'gpt-5',
      tiers: { creative: { model: 'gpt-5', effort: 'xhigh' }, assistant: null },
      ragProviders: [{ id: 'r1', protocol: 'openai-embed', model: 'bge-m3', apiKey: LEAK_RAG_KEY }],
      revision: 3,
    }),
    'utf-8',
  )
  // 全局偏好：白名单内的进包，白名单外的（自定义键/字体名）不进
  writeFileSync(
    join(ud, 'global.json'),
    JSON.stringify({ theme: 'dark', pageWidth: 760, autosaveInterval: 30, uiFontCn: '思源宋体', 自定义键: '不应入包' }),
    'utf-8',
  )
  mkdirSync(join(work, '.clwriting'), { recursive: true })
  writeFileSync(
    join(work, '.clwriting', 'books.jsonl'),
    [
      JSON.stringify({ name: '书A', path: '书A', kind: 'long' }),
      JSON.stringify({ name: '书B', path: '书B', kind: 'short' }),
    ].join('\n') + '\n',
    'utf-8',
  )
  // 书稿正文（红线：永不入包——收集器不读写作/ 下任何文件）
  mkdirSync(join(work, '书A', '写作', '正文'), { recursive: true })
  writeFileSync(
    join(work, '书A', '写作', '正文', '0001-甲.md'),
    `---\n章号: 1\n标题: 甲\n---\n\n${BOOK_MARKER}\n`,
    'utf-8',
  )
})

afterEach(() => {
  rmSync(ud, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const build = () => buildDiagnosticsBundle({ userDataPath: ud, workDir: work, appVersion: '1.0.0-rc.4', now: NOW })

describe('诊断包 · 基础集内容', () => {
  it('落 <userData>/诊断包/诊断包-本地时间戳.zip，条目 = 说明/环境/配置/近 7 天日志', () => {
    const r = build()
    expect(r.ok).toBe(true)
    expect(r.file).toBe(join(ud, '诊断包', '诊断包-20261010-123040.zip'))
    expect(r.dir).toBe(join(ud, '诊断包'))
    expect(existsSync(r.file!)).toBe(true)
    expect(r.entries).toEqual(['说明.txt', '环境.json', '配置.json', `日志/${TODAY_LOG}`])
    const entries = readZipStore(readFileSync(r.file!))
    expect(entries.map((e) => e.name)).toEqual(r.entries)
    // 说明.txt 是首条目（拿到包的人先读它）
    expect(entries[0]!.data.toString('utf-8')).toContain('隐私边界')
  })

  it('环境.json：应用版本/平台/架构/运行环境版本/生成时间齐备', () => {
    const r = build()
    const env = JSON.parse(readZipStore(readFileSync(r.file!))[1]!.data.toString('utf-8')) as Record<string, unknown>
    expect(env['应用版本']).toBe('1.0.0-rc.4')
    expect(env['平台']).toBe(process.platform)
    expect(env['架构']).toBe(process.arch)
    expect(env['生成时间']).toBe(NOW.toISOString())
    expect((env['运行环境'] as Record<string, string>)['node']).toBe(process.versions.node)
  })

  it('配置.json：白名单内偏好进包、白名单外键不进；书数只记数量', () => {
    const r = build()
    const cfg = JSON.parse(readZipStore(readFileSync(r.file!))[2]!.data.toString('utf-8')) as {
      应用偏好: Record<string, unknown>
      书库: { 书数: number }
    }
    expect(cfg.应用偏好).toEqual({ theme: 'dark', pageWidth: 760, autosaveInterval: 30 })
    expect(cfg.书库.书数).toBe(2)
    expect(JSON.stringify(cfg)).not.toContain('思源宋体')
  })

  it('近 7 天窗口：10 天前的日志文件不入包', () => {
    const r = build()
    expect(r.entries!.some((n) => n.includes('20260930'))).toBe(false)
  })
})

describe('诊断包 · 隐私红线', () => {
  it('供应商只取协议/模型名/是否配 key——apiKey 与 baseUrl 概不入包（原文与密文面）', () => {
    const r = build()
    const raw = readFileSync(r.file!)
    const cfgText = readZipStore(raw)[2]!.data.toString('utf-8')
    // 密钥形态整包不得出现（日志侧也逐行经 redactSecret）；接口地址不入**配置**条目
    //（日志侧网关主机名可能随 SDK 报错原文入包——「走既有脱敏」口径只掩凭据不掩主机，
    //  登记为有意保留：主机名是排查连通性问题的关键信息）
    expect(raw.includes(LEAK_KEY)).toBe(false)
    expect(raw.includes(LEAK_RAG_KEY)).toBe(false)
    expect(cfgText).not.toContain('gw.example.com')
    expect(cfgText).not.toContain('baseUrl')
    const cfg = JSON.parse(cfgText) as {
      providers: Array<Record<string, unknown>>
      currentModel: string | null
      ragProviders: Array<Record<string, unknown>>
      档位: { creative: Record<string, unknown> }
    }
    expect(cfg.providers).toEqual([
      { protocol: 'openai-responses', models: ['gpt-5', 'gpt-5-mini'], keyConfigured: true },
    ])
    expect(cfg.ragProviders[0]).toEqual({ protocol: 'openai-embed', models: [], keyConfigured: true })
    expect(cfg.currentModel).toBe('gpt-5')
    expect(cfg.档位.creative).toEqual({ model: 'gpt-5', effort: 'xhigh' })
    expect(JSON.stringify(cfg)).not.toContain('我的中转') // 供应商别名（用户自述文本）不进
  })

  it('书稿正文永不入包：包字节里搜不到正文标记', () => {
    const r = build()
    expect(readFileSync(r.file!).includes(BOOK_MARKER)).toBe(false)
  })

  it('路径脱敏：应用数据/用户目录/书库根在日志里替换为占位符，原文路径不出现在包内', () => {
    const r = build()
    const raw = readFileSync(r.file!)
    for (const p of [ud, work, homedir()]) {
      // 原样 UTF-8 字节序列不得出现在包内（store 模式不压缩，可直接字节比对）
      expect(raw.includes(Buffer.from(p, 'utf-8'))).toBe(false)
    }
    const log = readZipStore(raw)
      .find((e) => e.name.endsWith('.jsonl'))!
      .data.toString('utf-8')
    expect(log).toContain('<应用数据>')
    expect(log).toContain('<用户目录>')
    expect(log).toContain('<书库根>')
    // 凭据形态（query 参数 / 裸 key）走既有 redactSecret
    expect(log).toContain('***REDACTED***')
  })

  it('非 JSON 半行按文本脱敏保留（不猜测结构、不丢行）', () => {
    const r = build()
    const log = readZipStore(readFileSync(r.file!))
      .find((e) => e.name.endsWith('.jsonl'))!
      .data.toString('utf-8')
    expect(log).toContain('半行非 JSON：***REDACTED***')
  })
})

describe('诊断包 · 失败面', () => {
  it('无 userDataPath → ok:false 且文案点名病因，盘上无产物', () => {
    const r = buildDiagnosticsBundle({ userDataPath: null, workDir: work, appVersion: '1.0.0-rc.4', now: NOW })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('应用数据目录')
    expect(r.file).toBeUndefined()
    expect(existsSync(join(ud, '诊断包'))).toBe(false)
  })
})
