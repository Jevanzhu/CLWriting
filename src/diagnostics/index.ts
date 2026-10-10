/**
 * 诊断包（排查用打包件）：把「排查一个 bug 需要的最小信息集」打成单个 ZIP。
 *
 * 口径（基础集，拍板定案）：
 * - 环境：应用版本（版本单源，调用方注入）、平台/架构、运行环境（node/electron/
 *   chrome/v8 版本，缺者不列）、生成时间；
 * - 配置白名单：**显式列名**取键（全局编辑器偏好 / 供应商协议与模型名 /
 *   档位 / RAG 服务商），加上书库书数——不整份拷配置，也不读任何书稿文件；
 * - 日志：近 7 天 `app-YYYYMMDD.jsonl`（保留期口径与日志轮转同源），逐行脱敏；
 * - 说明.txt：包内清单 + 隐私边界声明（给拿到包的开发者/作者看）。
 *
 * 隐私红线（写死在本模块，测试锚定）：
 * - **书稿正文永不入包**——本模块不读 `写作/` 下任何文件，只读应用级数据目录；
 * - **密钥永不入包**——供应商只取 protocol / 模型名 / 「是否配了 key」布尔，
 *   apiKey（含密文）与 baseUrl 一概不读入内存；日志逐行过 redactSecret（既有脱敏
 *   单源，同 app-*.jsonl 落盘链）；
 * - **路径脱敏**——应用数据/用户目录/书库根在文本里替换为占位符，另加家目录形态
 *   正则兜底（win `C:\Users\x` / mac+linux `/Users|x/home`）。
 *
 * 落点：`<userData>/诊断包/诊断包-<本地时间戳>.zip`——不放书库目录：诊断包是应用级
 * 排查件（与书是否同步/搬走无关），落书库会被云同步带走、并在 `工作区/导出/` 里
 * 与导出稿混面。旧包不清理（同「归档不删」哲学：作者自己看得见、自己清）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { redactSecret } from '../log/redact.js'
import { errMsg, recentLogFiles } from '../log/index.js'
import { buildZipStore, type ZipEntry } from './zip.js'

/** 日志收集天数（与日志轮转的保留期同口径，见 recentLogFiles） */
const LOG_DAYS = 7
/** 诊断包目录名（userData 下） */
const BUNDLE_DIR = '诊断包'
/** 白名单里允许的字符串值长度上限（防某个键藏了长路径/长文本混进包） */
const MAX_WHITELIST_STRING = 60

export interface DiagnosticsOptions {
  /** APP 级数据目录（Electron userData / CLI 约定路径）；null = 无法生成 */
  userDataPath: string | null
  /** 书库根（只用于「书数」计数与路径脱敏占位） */
  workDir: string | null
  /** 应用版本（版本单源 resolveAppVersion，由调用方注入——本模块不反向依赖 update 链） */
  appVersion: string
  /** 生成时刻（测试注入固定值；缺省当前时刻） */
  now?: Date
}

export interface DiagnosticsResult {
  ok: boolean
  /** 生成的包绝对路径 */
  file?: string
  /** 包所在目录绝对路径 */
  dir?: string
  /** 包内条目名（首条为 说明.txt） */
  entries?: string[]
  bytes?: number
  warnings?: string[]
  error?: string
}

/** 全局编辑器偏好白名单（显式列名——不整份拷 global.json；未设的键不列） */
const PREFS_WHITELIST = [
  'theme',
  'compact',
  'uiFontSizeStep',
  'proseSize',
  'pageWidth',
  'autosaveInterval',
  'shelfView',
  'chatEnabled',
  'snapMaxDays',
  'snapMaxCount',
  'defaultGenre',
  'defaultVolumeSize',
  'defaultTargetWords',
  'defaultChapterTargetWords',
  'defaultShortStrict',
  'styleInjection',
  'autoConfirmOutline',
  'autoBatchSize',
  'callsPerChapter',
  'relationAutoMine',
  'relationMineThreshold',
  'ragEnabled',
  'checkRepeatThreshold',
  'checkRepeatCharsThreshold',
  'checkMaxSentenceLen',
  'checkImageryThreshold',
  'checkWordCountTolerance',
] as const

/** 裸值 → 白名单可收形状（string 限长且不含路径分隔符；其余基本类型直收） */
function whitelistValue(v: unknown): string | number | boolean | null | undefined {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') {
    return v.length <= MAX_WHITELIST_STRING && !v.includes('/') && !v.includes('\\') ? v : undefined
  }
  return undefined
}

/** 容错读 JSON（不存在/损坏 → null；不抛） */
function readJsonLoose(path: string): unknown {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** 供应商条目白名单：协议 + 模型名 + 「是否配了 key」布尔（apiKey 值/密文一概不取） */
function providerRow(v: unknown): Record<string, unknown> | null {
  const p = asRecord(v)
  if (!p) return null
  const models = Array.isArray(p['models'])
    ? (p['models'] as unknown[])
        .map((m) => {
          const r = asRecord(m)
          const name = r?.['model'] ?? r?.['name']
          return typeof name === 'string' ? name : null
        })
        .filter((n): n is string => n !== null)
    : []
  return {
    protocol: typeof p['protocol'] === 'string' ? p['protocol'] : '(未知)',
    models,
    keyConfigured: typeof p['apiKey'] === 'string' && p['apiKey'] !== '',
  }
}

/** 档位白名单：档名 + 模型名 + 力度（无路径/无密钥面） */
function tierRow(v: unknown): Record<string, unknown> | null {
  const t = asRecord(v)
  if (!t) return null
  return {
    model: typeof t['model'] === 'string' ? t['model'] : null,
    effort: typeof t['effort'] === 'string' ? t['effort'] : null,
  }
}

/** 生成说明.txt（包内首条目：给人看的清单 + 隐私边界） */
function readmeText(): string {
  return [
    'CLWriting 诊断包',
    '',
    '内容清单：',
    '  环境.json    应用版本、平台/架构、运行环境版本、生成时间',
    '  配置.json    配置白名单（全局偏好 / 供应商协议与模型名 / 档位 / 书库书数）',
    '  日志/        近 7 天应用日志（逐行脱敏后的 JSONL）',
    '  说明.txt     本文件',
    '',
    '隐私边界：',
    '  · 不含书稿正文、设定、大纲等任何书库内容；',
    '  · 不含任何 API Key / 令牌（只记「是否已配置」）；',
    '  · 不含供应商接口地址（只记协议与模型名）；',
    '  · 路径已替换为占位符（<应用数据> / <用户目录> / <书库根>）；',
    '  · 日志逐行经凭据脱敏（URL 凭据 / Bearer / 各厂商 key 形态）。',
    '',
    '生成方式：设置 → 诊断 → 生成诊断包。',
  ].join('\n')
}

/**
 * 生成诊断包（同步 IO——条数是「近 7 天日志 + 两个小 JSON」，量级 MB 内；
 * 调用方为设置页显式动作，非请求路径上的热路径）。
 */
export function buildDiagnosticsBundle(opts: DiagnosticsOptions): DiagnosticsResult {
  const { userDataPath, workDir, appVersion } = opts
  const now = opts.now ?? new Date()
  if (!userDataPath) {
    return { ok: false, error: '未定位到应用数据目录，无法生成诊断包' }
  }
  const warnings: string[] = []
  // 路径占位（具体目录先行：workDir/userData 常在用户目录之下，先替换具体再替换家目录；
  // 空串/根目录（长度 ≤1）不参与——免得把整条文本替成占位符）
  const subs: Array<[string, string]> = []
  if (workDir && workDir.length > 1) subs.push([workDir, '<书库根>'])
  if (userDataPath.length > 1) subs.push([userDataPath, '<应用数据>'])
  const home = homedir()
  if (home.length > 1) subs.push([home, '<用户目录>'])

  const scrubText = (s: string): string => {
    let out = s
    for (const [dir, ph] of subs) out = out.split(dir).join(ph)
    // 家目录形态兜底（同机不同用户/软链形态未被 subs 命中时）
    out = out.replace(/[A-Za-z]:\\+Users\\+[^\\/\s"']+/g, '<用户目录>')
    out = out.replace(/\/(?:Users|home)\/[^/\s"']+/g, '<用户目录>')
    return redactSecret(out)
  }
  const scrubValue = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubText(v)
    if (Array.isArray(v)) return v.map(scrubValue)
    const r = asRecord(v)
    if (r) {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(r)) out[scrubText(k)] = scrubValue(val)
      return out
    }
    return v
  }

  // ── 环境.json ──
  const versions: Record<string, string> = {}
  for (const k of ['node', 'electron', 'chrome', 'v8'] as const) {
    const v = process.versions[k]
    if (v) versions[k] = v
  }
  const env = {
    生成时间: now.toISOString(),
    应用版本: appVersion,
    平台: process.platform,
    架构: process.arch,
    运行环境: versions,
    应用数据目录: scrubText(userDataPath),
    书库根: workDir ? scrubText(workDir) : null,
  }

  // ── 配置.json（白名单；providers 只取协议/模型名/是否配 key）──
  const config = buildConfigSection(userDataPath, workDir, warnings)

  // ── 日志/（近 7 天，逐行脱敏）──
  const logEntries = collectLogEntries(join(userDataPath, 'logs'), now, scrubValue, scrubText, warnings)

  const entries: ZipEntry[] = [
    { name: '说明.txt', data: readmeText() },
    { name: '环境.json', data: JSON.stringify(env, null, 2) },
    { name: '配置.json', data: JSON.stringify(config, null, 2) },
    ...logEntries,
  ]

  const dir = join(userDataPath, BUNDLE_DIR)
  const stamp = `${localDayKeyPlain(now)}-${localClockPlain(now)}`
  const file = join(dir, `诊断包-${stamp}.zip`)
  try {
    const zip = buildZipStore(entries, { mtime: now })
    atomicWriteFile(file, zip)
    return {
      ok: true,
      file,
      dir,
      entries: entries.map((e) => e.name),
      bytes: zip.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (e) {
    return { ok: false, error: `诊断包写入失败：${errMsg(e)}`, ...(warnings.length > 0 ? { warnings } : {}) }
  }
}

/** 配置段（白名单）：全局偏好显式列名取键 + 供应商「协议/模型名/是否配 key」 +
 *  当前模型 + 任务档位 + RAG 服务商同款 + 书库书数。apiKey（含密文）与 baseUrl 不取。 */
function buildConfigSection(userDataPath: string, workDir: string | null, warnings: string[]): Record<string, unknown> {
  const prefsRaw = asRecord(readJsonLoose(join(userDataPath, 'global.json')))
  const prefs: Record<string, unknown> = {}
  for (const key of PREFS_WHITELIST) {
    const val = prefsRaw ? whitelistValue(prefsRaw[key]) : undefined
    if (val !== undefined) prefs[key] = val
  }
  const provRaw = asRecord(readJsonLoose(join(userDataPath, 'providers.json')))
  const tiersRaw = asRecord(provRaw?.['tiers'])
  const providerRows = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? (v as unknown[]).map(providerRow).filter((r): r is Record<string, unknown> => r !== null) : []
  return {
    providers: providerRows(provRaw?.['providers']),
    currentModel: typeof provRaw?.['currentModel'] === 'string' ? provRaw['currentModel'] : null,
    档位: {
      creative: tierRow(tiersRaw?.['creative']),
      assistant: tierRow(tiersRaw?.['assistant']),
    },
    ragProviders: providerRows(provRaw?.['ragProviders']),
    应用偏好: prefs,
    书库: { 书数: countBooks(workDir, warnings) },
  }
}

/** 日志段（近 LOG_DAYS 天，逐行脱敏）：JSON 行 parse→遍历脱敏→序列化（转义形态
 *  差异下仍能命中路径替换）；非 JSON 行按文本脱敏。单文件不可读记 warning 不阻断。 */
function collectLogEntries(
  logsDir: string,
  now: Date,
  scrubValue: (v: unknown) => unknown,
  scrubText: (s: string) => string,
  warnings: string[],
): ZipEntry[] {
  const out: ZipEntry[] = []
  for (const abs of recentLogFiles(logsDir, LOG_DAYS, now)) {
    const base = abs.slice(abs.lastIndexOf('app-'))
    try {
      const redacted = readFileSync(abs, 'utf-8')
        .split('\n')
        .map((line) => {
          if (line.trim() === '') return line
          try {
            return JSON.stringify(scrubValue(JSON.parse(line) as unknown))
          } catch {
            return scrubText(line)
          }
        })
      out.push({ name: `日志/${base}`, data: redacted.join('\n') })
    } catch (e) {
      warnings.push(`日志 ${base} 读取失败：${errMsg(e)}`)
    }
  }
  return out
}

/** 文件名日期段（YYYYMMDD，本地时区） */
function localDayKeyPlain(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 文件名时刻段（HHmmss，本地时区；win 文件名禁冒号，故不带分隔） */
function localClockPlain(d: Date): string {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('')
}

/** 书数（只报数量，不列书名——书名属书稿面） */
function countBooks(workDir: string | null, warnings: string[]): number | null {
  if (!workDir) return null
  try {
    const fp = join(workDir, '.clwriting', 'books.jsonl')
    if (!existsSync(fp)) return 0
    return readFileSync(fp, 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '').length
  } catch (e) {
    warnings.push(`书库登记读取失败：${errMsg(e)}`)
    return null
  }
}

/** 诊断包目录绝对路径（桌面 IPC「打开所在文件夹」与测试复用；不创建） */
export function diagnosticsDirOf(userDataPath: string): string {
  return join(userDataPath, BUNDLE_DIR)
}
