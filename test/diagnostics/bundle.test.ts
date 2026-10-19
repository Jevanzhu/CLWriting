/**
 * 诊断包收集器（src/diagnostics/index.ts）单测——口径与隐私红线逐条锚定：
 * 基础集内容（环境/配置白名单/近 7 天日志）、**书稿正文与密钥永不入包**
 *（含日志内容门：承载书库文本的来源只留事件标签）、路径脱敏、落点与命名、
 * 缺 userDataPath 的失败面。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import {
  buildDiagnosticsBundle,
  CONTENT_BEARING_LOG_TAGS,
  CONTENT_GATE_EXCEPTIONS,
} from '../../src/diagnostics/index.js'
import { instanceUserDataPath, libraryInstanceKey } from '../../src/fs/user-data-path.js'
import { readZipStore } from '../helpers/zip-read.js'

/** 写入失败注入：默认透传真实实现，仅多卷中途失败用例置位 */
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/fs/atomic.js')>()
  return { ...actual, atomicWriteFile: vi.fn(actual.atomicWriteFile) }
})
import * as atomicWriteFileMod from '../../src/fs/atomic.js'

/** 固定生成时刻：2026-10-10 12:30:40 本地时（日志文件名/包名与之一致） */
const NOW = new Date(2026, 9, 10, 12, 30, 40)
const TODAY_LOG = 'app-20261010.jsonl'
/** 10 天前（超出保留期/收集窗） */
const OLD_LOG = 'app-20260930.jsonl'
const LEAK_KEY = 'sk-test-LEAK-1234567890abcdef'
const LEAK_RAG_KEY = 'sk-ant-LEAK-RAG-abcdefghijklmnop'
const BOOK_MARKER = 'MARKER-书稿正文-绝不入包'
/** 日志侧书库文本切片（模拟 leads 告警实形态：账本行原文） */
const LEAD_TEXT_FRAGMENT = '林晚在码头认出顾昭藏在旧钟里的钥匙'
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
      // 内容承载来源（leads）：载荷含账本行原文——内容门只留事件标签
      JSON.stringify({
        ts: '2026-10-10T04:32:00.000Z',
        level: 'warn',
        tag: 'leads',
        msg: `履历条目格式不符被丢弃（应为「- 第N章 动词：证据」）：- 第7章 揭示：${LEAD_TEXT_FRAGMENT}，她没有声张`,
        err: { message: `账本行内容：${LEAD_TEXT_FRAGMENT}` },
      }),
      // 非内容承载来源：msg 原样保留（内容门只拦名单内来源）
      JSON.stringify({
        ts: '2026-10-10T04:33:00.000Z',
        level: 'info',
        tag: 'server',
        msg: '子进程握手完成（pid 4321）',
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

  it('同一秒内重复生成 → 换序号不覆盖（先前那包可能已被作者拿去反馈）', () => {
    const first = build()
    expect(first.ok).toBe(true)
    expect(first.file).toBe(join(ud, '诊断包', '诊断包-20261010-123040.zip'))
    const before = readFileSync(first.file!)
    // 同 now 再生成一次：时刻段相同，但不得落到同名文件上
    const second = build()
    expect(second.ok).toBe(true)
    expect(second.file).not.toBe(first.file)
    expect(second.file).toBe(join(ud, '诊断包', '诊断包-20261010-123040-2.zip'))
    // 前一包字节未被改写
    expect(readFileSync(first.file!).equals(before)).toBe(true)
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

  it('日志内容门：承载书库文本的来源只留事件标签（正文片段与 err 载荷不入包），非承载来源原样保留', () => {
    const r = build()
    const log = readZipStore(readFileSync(r.file!))
      .find((e) => e.name.endsWith('.jsonl'))!
      .data.toString('utf-8')
    expect(log).not.toContain(LEAD_TEXT_FRAGMENT)
    expect(log).toContain('履历条目格式不符被丢弃（详情已省略）')
    expect(log).toContain('子进程握手完成')
  })

  it('非 JSON 半行只留长度标记（结构不可解析则来源不可分类，载荷一律不保留）', () => {
    const r = build()
    const log = readZipStore(readFileSync(r.file!))
      .find((e) => e.name.endsWith('.jsonl'))!
      .data.toString('utf-8')
    expect(log).toContain('[非 JSON 行已省略：内容不可分类，仅记字符数]')
    expect(log).not.toContain('半行非 JSON')
  })

  it('check/metrics 族：章文件路径（含书名与章标题）与 errMsg 原文概不入包，只留事件标签', () => {
    // 实形态：模板串拼接的章文件路径（书名 + 章标题）与 errMsg 双通道
    const chapterPath = join(work, '书A', '写作', '正文', '0007-钟里的钥匙.md')
    writeFileSync(
      join(ud, 'logs', 'app-20261010.jsonl'),
      [
        JSON.stringify({
          ts: '2026-10-10T04:40:00.000Z',
          level: 'warn',
          tag: 'check',
          msg: `章文件解析失败（树红点对该章失明）：${chapterPath}——章号不是整数`,
          err: { message: `读取失败：${chapterPath}` },
        }),
        JSON.stringify({
          ts: '2026-10-10T04:41:00.000Z',
          level: 'warn',
          tag: 'metrics',
          msg: `短篇集索引跳过不可读章：0007-钟里的钥匙.md（文件缺失/读失败或 fm 未闭合，不计入画像与反转分）`,
          err: { message: 'fm 未闭合' },
        }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const r = build()
    const raw = readFileSync(r.file!)
    const log = readZipStore(raw)
      .find((e) => e.name.endsWith('.jsonl'))!
      .data.toString('utf-8')
    // 章标题原文与书库绝对路径概不入包（包字节级）
    expect(log).not.toContain('0007-钟里的钥匙')
    expect(raw.includes(Buffer.from(chapterPath, 'utf-8'))).toBe(false)
    expect(log).not.toContain('章号不是整数')
    // 有用的无隐私面保留：事件标签与降级语义在
    expect(log).toContain('章文件解析失败（详情已省略）')
    expect(log).toContain('短篇集索引跳过不可读章（详情已省略）')
  })
})

describe('诊断包 · 内容门分类完备性', () => {
  // 对账判据（本块单源）：**脱敏漏点必须在机器门前可判**，不靠人工回看日志点。
  // 三族判据各自覆盖一种「载荷形态」：
  //   ① sliceBearing —— 实参含 slice( 的调用点（正文片段截断形态，既有判据）；
  //   ② family —— src/check、src/metrics 两族的**全部**调用点（点名这批来源整体入网，
  //      含模板串拼接与结构化对象两种形态——正是「模板串不在 slice 网内」的补网）；
  //   ③ bookSideMarker —— 实参插值里出现书库侧取值（相对路径 / 文件名 / 章纲 / 标题）
  //      的调用点，tag 未入内容门者必须在 CONTENT_GATE_EXCEPTIONS 逐条登记（模板串
  //      形态的兜底网，跨越「族」边界）。
  // 另有 labelPosition（第四判据，反向）：**已入内容门的 tag**，其标签位（首个载荷
  // 分隔符之前，门唯一保留的片段）不得出现书库侧取值——门只截载荷不截标签，标签位
  // 有路径等于脱敏漏点仍在。

  /** 标签位标记：这类取值一旦落在标签位就会随事件标签入包（书库内相对路径不含绝对
   *  路径前缀，绝对路径替换面兜不住）。 */
  const BOOK_SIDE_MARKER = /(basename\(|\brelative\(|\brelPath\b|\brel\b|\b\w+Rel\b|_path\b|章纲|书名|标题)/
  /** 事件标签的载荷分隔符集（与 src/diagnostics/index.ts 的 eventLabelOf 同口径） */
  const PAYLOAD_DELIMITER = /[「（(：:]/
  /** 声明家族：这些来源的日志按「可能带书库文本」整体入网（不逐点判形态）。
   *  路径口径 = 相对 src/ 的 POSIX 前缀（扫描结果同口径）。 */
  const CONTENT_BEARING_FAMILIES = ['check/', 'metrics/']

  interface LogCallSite {
    file: string
    line: number
    tag: string
    /** 实参含 slice(（切片载荷形态） */
    hasSlice: boolean
    /** 标签位的插值表达式（首个载荷分隔符之前） */
    labelExprs: string[]
    /** 实参内全部插值表达式（不分位置） */
    allExprs: string[]
  }

  /** 逐字符配平实参括号抽出调用点（字符串 / 模板串内的括号也计入配平，判据只用值域）。 */
  function scanLogCallSites(file: string, text: string): LogCallSite[] {
    const out: LogCallSite[] = []
    for (const m of text.matchAll(/log\.(?:warn|info|error|debug)\(/g)) {
      const start = m.index + m[0].length
      let depth = 1
      let i = start
      while (i < text.length && depth > 0) {
        const ch = text[i]
        if (ch === '(') depth++
        else if (ch === ')') depth--
        i++
      }
      const args = text.slice(start, i - 1)
      const tag = args.match(/^\s*'([^']+)'/)?.[1] ?? '(非字面量 tag)'
      const msg = args.replace(/^\s*'[^']*'\s*,\s*/, '')
      const labelExprs: string[] = []
      if (msg.startsWith('`')) {
        let j = 1
        let delimHit = false
        while (j < msg.length) {
          const ch = msg[j]!
          if (ch === '`') break
          if (ch === '$' && msg[j + 1] === '{') {
            let d = 1
            let k = j + 2
            while (k < msg.length && d > 0) {
              const c = msg[k]!
              if (c === '{') d++
              else if (c === '}') d--
              k++
            }
            if (!delimHit) labelExprs.push(msg.slice(j + 2, k - 1).trim())
            j = k
            continue
          }
          if (!delimHit && PAYLOAD_DELIMITER.test(ch)) delimHit = true
          j++
        }
      }
      out.push({
        file,
        line: text.slice(0, m.index).split('\n').length,
        tag,
        hasSlice: args.includes('slice('),
        labelExprs,
        allExprs: [...args.matchAll(/\$\{([^}]*)\}/g)].map((x) => (x[1] ?? '').trim()),
      })
    }
    return out
  }

  /** 收集 src 下全部 .ts 的调用点（相对 src 的 POSIX 路径） */
  function scanSrc(): LogCallSite[] {
    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) {
          if (e.name !== 'node_modules') walk(p)
        } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) files.push(p)
      }
    }
    const srcRoot = join(import.meta.dirname, '..', '..', 'src')
    walk(srcRoot)
    return files.flatMap((f) => scanLogCallSites(relative(srcRoot, f).split(sep).join('/'), readFileSync(f, 'utf-8')))
  }

  const sites = scanSrc()
  const familyMisses = sites.filter(
    (s) => CONTENT_BEARING_FAMILIES.some((p) => s.file.startsWith(p)) && !CONTENT_BEARING_LOG_TAGS.has(s.tag),
  )
  const labelMisses = sites.filter(
    (s) => CONTENT_BEARING_LOG_TAGS.has(s.tag) && s.labelExprs.some((e) => BOOK_SIDE_MARKER.test(e)),
  )
  const unregisteredBookSide = sites
    .filter((s) => !CONTENT_BEARING_LOG_TAGS.has(s.tag))
    .flatMap((s) =>
      s.allExprs
        .filter((e) => BOOK_SIDE_MARKER.test(e))
        .map((e) => ({ site: s, key: `${s.tag}@${s.file}#${e}` }))
        .filter(({ key }) => !CONTENT_GATE_EXCEPTIONS.has(key)),
    )

  it('扫描器不空转：切片载荷点/家族调用点两族都有命中', () => {
    expect(
      sites.filter((s) => s.hasSlice).length,
      '扫描器未命中任何切片载荷日志点——检查扫描口径是否失效',
    ).toBeGreaterThanOrEqual(5)
    // 家族地板（src/check、src/metrics 当前共 20 处调用点）
    expect(
      sites.filter((s) => CONTENT_BEARING_FAMILIES.some((p) => s.file.startsWith(p))).length,
      '家族扫描未命中 check/metrics 调用点——家族名单或路径口径失效',
    ).toBeGreaterThanOrEqual(10)
  })

  it('① 实参含 slice( 的日志点，其 tag 必须列入内容门（或逐条登记例外）', () => {
    const missing = [...new Set(sites.filter((s) => s.hasSlice).map((s) => s.tag))]
      .filter((tag) => !CONTENT_BEARING_LOG_TAGS.has(tag))
      .filter((tag) => ![...CONTENT_GATE_EXCEPTIONS.keys()].some((k) => k.startsWith(`${tag}@`)))
    expect(missing, `切片载荷日志点未分类：${missing.join('、')}`).toEqual([])
  })

  it('② check/metrics 族的全部日志点必须走内容门（模板串形态也在此族内整体入网）', () => {
    const missing = familyMisses.map((s) => `${s.tag}（${s.file}:${s.line}）`)
    expect(missing, `声明家族的日志点未入内容门：${missing.join('、')}`).toEqual([])
  })

  it('③ 已入内容门的 tag，标签位不得出现书库侧取值（门只截载荷，标签位漏点照样入包）', () => {
    const misses = labelMisses.map((s) => `${s.tag}（${s.file}:${s.line}）：${s.labelExprs.join('；')}`)
    expect(misses, `内容门标签位带书库侧取值：${misses.join('、')}`).toEqual([])
  })

  it('④ 未入内容门的 tag 带书库侧取值插值（模板串形态）→ 必须在例外表逐条登记理由', () => {
    const misses = unregisteredBookSide.map(({ key, site }) => `${key}（${site.file}:${site.line}）`)
    expect(misses, `书库侧取值日志点未分类：${misses.join('、')}`).toEqual([])
  })

  it('⑤ 判据对合成样例生效：模板串载荷点被 ②/④ 抓出、标签位载荷被 ③ 抓出', () => {
    // 合成样例：两段含模板串载荷的伪源码——三类漏点各有命中、合规形态零命中（判据不得空转）
    const familySample = [
      'export function f(basename: (p: string) => string, relPath: string) {',
      // 家族内新增 tag（带模板串载荷）：判据②（家族整体入网）抓出
      "  log.warn('metrics-new', `短篇集索引跳过不可读章：${relPath}（文件缺失/读失败）`)",
      // 已入内容门的 tag 把路径写在标签位（首个分隔符之前）：判据③（标签位漏点）抓出
      "  log.warn('metrics', `短篇章纲 ${basename(relPath)} 读取失败（评估系统性低估）`)",
      // 合规形态：载荷在分隔符之后 → 三条判据都不该报
      "  log.warn('metrics', `短篇章纲读取失败、本篇按无章纲计（章纲：${relPath}）`)",
      '}',
    ].join('\n')
    const outsideSample = [
      'export function g(relPath: string) {',
      // 家族外 tag 带模板串路径载荷：判据④（书库侧取值未登记）抓出
      "  log.warn('document-new', `移动失败、原稿保留原位（受限文档：${relPath}）`)",
      '}',
    ].join('\n')
    const familySites = scanLogCallSites('metrics/sample.ts', familySample)
    const outsideSites = scanLogCallSites('analysis/sample.ts', outsideSample)
    expect(familySites).toHaveLength(3)
    expect(outsideSites).toHaveLength(1)
    const familyMiss = familySites.filter(
      (s) => CONTENT_BEARING_FAMILIES.some((p) => s.file.startsWith(p)) && !CONTENT_BEARING_LOG_TAGS.has(s.tag),
    )
    expect(familyMiss.map((s) => s.tag)).toEqual(['metrics-new'])
    const labelMiss = familySites.filter(
      (s) => CONTENT_BEARING_LOG_TAGS.has(s.tag) && s.labelExprs.some((e) => BOOK_SIDE_MARKER.test(e)),
    )
    expect(labelMiss).toHaveLength(1)
    expect(labelMiss[0]!.tag).toBe('metrics')
    const unregistered = [...familySites, ...outsideSites]
      .filter((s) => !CONTENT_BEARING_LOG_TAGS.has(s.tag))
      .flatMap((s) => s.allExprs.filter((e) => BOOK_SIDE_MARKER.test(e)).map((e) => `${s.tag}#${e}`))
    expect(unregistered.sort()).toEqual(['document-new#relPath', 'metrics-new#relPath'])
  })
})

describe('诊断包 · 超限分卷与截断提示（P2-12）', () => {
  it('超单卷条目上限 → 分卷写入（files 全列、卷名带序号），warning 提示分卷，各卷可解析', () => {
    const r = buildDiagnosticsBundle({
      userDataPath: ud,
      workDir: work,
      appVersion: '1.0.0-rc.4',
      now: NOW,
      zipLimits: { maxEntries: 2 },
    })
    expect(r.ok).toBe(true)
    expect(r.files).toEqual([
      join(ud, '诊断包', '诊断包-20261010-123040.zip'),
      join(ud, '诊断包', '诊断包-20261010-123040-2.zip'),
    ])
    expect(r.file).toBe(r.files![0])
    expect(r.dir).toBe(join(ud, '诊断包'))
    for (const f of r.files!) expect(existsSync(f)).toBe(true)
    const names = r.files!.flatMap((f) => readZipStore(readFileSync(f)).map((e) => e.name))
    expect(names).toEqual(['说明.txt', '环境.json', '配置.json', `日志/${TODAY_LOG}`])
    expect(r.entries).toEqual(names)
    expect(
      r.warnings!.some((w) => w.includes('分 2 卷')),
      '分卷须有 warning 提示（不静默改落点形态）',
    ).toBe(true)
  })

  it('单条超单卷字节上限 → 截断省略 + warning 点名该条，其余条目照常成包', () => {
    const BIG_LOG = 'app-20261009.jsonl'
    writeFileSync(join(ud, 'logs', BIG_LOG), JSON.stringify({ msg: 'x'.repeat(6000) }) + '\n', 'utf-8')
    const r = buildDiagnosticsBundle({
      userDataPath: ud,
      workDir: work,
      appVersion: '1.0.0-rc.4',
      now: NOW,
      zipLimits: { maxArchiveBytes: 4096 },
    })
    expect(r.ok).toBe(true)
    expect(r.files!.length).toBe(1)
    expect(r.entries).not.toContain(`日志/${BIG_LOG}`)
    expect(r.entries).toContain(`日志/${TODAY_LOG}`)
    expect(readZipStore(readFileSync(r.file!)).map((e) => e.name)).toEqual(r.entries)
    expect(
      r.warnings!.some((w) => w.includes('省略') && w.includes(BIG_LOG)),
      '截断省略须 warning 点名（不静默丢条目）',
    ).toBe(true)
  })

  it('全部条目都超单卷上限 → ok:false 点名病因，不产半截包', () => {
    const r = buildDiagnosticsBundle({
      userDataPath: ud,
      workDir: work,
      appVersion: '1.0.0-rc.4',
      now: NOW,
      zipLimits: { maxArchiveBytes: 10 },
    })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('单卷上限')
    expect(existsSync(join(ud, '诊断包', '诊断包-20261010-123040.zip'))).toBe(false)
  })

  it('多卷写到中途失败 → 已落的卷整批清掉，不留半套包', () => {
    // 第 2 卷落盘时失败：第 1 卷已写成，若不清就是「一套缺卷的包」，作者拿去反馈会缺料而不知
    const spy = vi.mocked(atomicWriteFileMod.atomicWriteFile)
    const real = spy.getMockImplementation()!
    let n = 0
    spy.mockImplementation((...args: Parameters<typeof atomicWriteFileMod.atomicWriteFile>) => {
      n++
      // 第 1 卷真落盘，第 2 卷抛：只有第 1 卷真的写过，「清掉半套」才有可观察的判据
      if (n >= 2) throw new Error('磁盘已满')
      ;(real as (...a: unknown[]) => void)(...args)
    })
    try {
      const r = buildDiagnosticsBundle({
        userDataPath: ud,
        workDir: work,
        appVersion: '1.0.0-rc.4',
        now: NOW,
        zipLimits: { maxEntries: 2 },
      })
      expect(r.ok).toBe(false)
      expect(r.error).toContain('写入失败')
      // 卷 1 与被试写的卷 2 都不得留在盘上
      expect(existsSync(join(ud, '诊断包', '诊断包-20261010-123040.zip'))).toBe(false)
      expect(existsSync(join(ud, '诊断包', '诊断包-20261010-123040-2.zip'))).toBe(false)
    } finally {
      // 还原透传实现本身，不能用 restoreAllMocks（会把 vi.fn 的默认实现一并清空）
      spy.mockImplementation(real!)
    }
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

// ── 日志来源覆盖（多库多窗：共享根 logs/ 与各实例 instances/<key>/logs/）───────────
// 收集侧只认「共享根下 logs/ 与 instances/<key>/logs/ 两处磁盘事实」；实例目录用
// fs/user-data-path 的实例布局原语算出（不硬抄目录名），布局漂移时用例随之红。

/** 共享根 env 钩子作用域：appDataHomeDir 读 CLW_SMOKE_USER_DATA（调用期取值） */
function withHomeRoot<T>(fn: () => T): T {
  const prev = process.env['CLW_SMOKE_USER_DATA']
  process.env['CLW_SMOKE_USER_DATA'] = ud
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env['CLW_SMOKE_USER_DATA']
    else process.env['CLW_SMOKE_USER_DATA'] = prev
  }
}

/** 在某实例的日志目录落一份今日日志（返回该实例 key） */
function writeInstanceLog(libPath: string, marker: string): string {
  const key = libraryInstanceKey(libPath)
  const dir = join(instanceUserDataPath(key), 'logs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, TODAY_LOG),
    JSON.stringify({ ts: '2026-10-10T05:00:00.000Z', level: 'info', tag: 'desktop', msg: marker }) + '\n',
    'utf-8',
  )
  return key
}

describe('诊断包 · 日志来源（共享根 + 各实例目录）', () => {
  it('instances/<key>/logs 各实例日志都入包：条目名带实例 key、内容各归其份、不与共享根同名条目相撞', () => {
    const keyA = withHomeRoot(() => writeInstanceLog('/libs/书甲', '实例甲独有日志行'))
    const keyB = withHomeRoot(() => writeInstanceLog('/libs/书乙', '实例乙独有日志行'))
    const r = build()
    expect(r.ok).toBe(true)
    const entries = readZipStore(readFileSync(r.file!))
    // 共享根 logs/（历史布局，夹具预置）与两实例日志并存：三份都收，条目名互不相同
    //（实例条目多一层 key 路径段）
    expect(entries.map((e) => e.name)).toEqual([
      '说明.txt',
      '环境.json',
      '配置.json',
      `日志/${TODAY_LOG}`,
      ...[keyA, keyB].sort().map((k) => `日志/${k}/${TODAY_LOG}`),
    ])
    const textOf = (name: string): string => entries.find((e) => e.name === name)!.data.toString('utf-8')
    expect(textOf(`日志/${keyA}/${TODAY_LOG}`)).toContain('实例甲独有日志行')
    expect(textOf(`日志/${keyA}/${TODAY_LOG}`)).not.toContain('实例乙独有日志行')
    expect(textOf(`日志/${keyB}/${TODAY_LOG}`)).toContain('实例乙独有日志行')
    expect(textOf(`日志/${keyB}/${TODAY_LOG}`)).not.toContain('实例甲独有日志行')
    expect(textOf(`日志/${TODAY_LOG}`)).not.toContain('实例甲独有日志行')
  })

  it('历史布局（只有共享根 logs/）：条目名保持裸名，旧包形态与既有消费方不变', () => {
    const r = build()
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual(['说明.txt', '环境.json', '配置.json', `日志/${TODAY_LOG}`])
    expect(r.warnings ?? []).toEqual([])
  })

  it('两处来源都不存在 → 只出其它段，ok:true 且不报错', () => {
    rmSync(join(ud, 'logs'), { recursive: true, force: true })
    const r = build()
    expect(r.ok).toBe(true)
    expect(r.entries).toEqual(['说明.txt', '环境.json', '配置.json'])
    expect(r.warnings ?? []).toEqual([])
    expect(readZipStore(readFileSync(r.file!)).map((e) => e.name)).toEqual(r.entries)
  })

  it('实例目录下的过期日志文件与共享根同口径排除（近 7 天窗口跨来源一致）', () => {
    const key = withHomeRoot(() => writeInstanceLog('/libs/书丙', '近期行'))
    withHomeRoot(() => {
      writeFileSync(join(instanceUserDataPath(key), 'logs', OLD_LOG), JSON.stringify({ msg: '十天前' }) + '\n', 'utf-8')
    })
    const r = build()
    expect(r.entries).toContain(`日志/${key}/${TODAY_LOG}`)
    expect(r.entries!.some((n) => n.includes('20260930'))).toBe(false)
  })
})
