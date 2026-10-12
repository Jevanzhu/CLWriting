/**
 * 诊断包（排查用打包件）：把「排查一个 bug 需要的最小信息集」打成 ZIP（超单卷上限
 * 按条目边界分卷，见 zip.ts 头注；单卷时行为与既有逐字节一致）。
 *
 * 口径（基础集）：
 * - 环境：应用版本（版本单源，调用方注入）、平台/架构、运行环境（node/electron/chrome/v8 版本，
 *   缺者不列）、生成时间；
 * - 配置白名单：**显式列名**取键（全局编辑器偏好 / 供应商协议与模型名 / 档位 / RAG 服务商），
 *   加上书库书数——不整份拷配置，也不读任何书稿文件；
 * - 日志：近 7 天 `app-YYYYMMDD.jsonl`（保留期口径与日志轮转同源），逐行脱敏；来源
 *   = 入参 userDataPath（共享根）下的 `logs/` 与 `instances/<key>/logs` 两处形态全收
 *  （多库多窗下各实例各写一份，只读前者会得到空日志段，见 logSourceDirs）；
 * - 说明.txt：包内清单 + 隐私边界声明（给拿到包的开发者/作者看）。
 *
 * 隐私红线（写死在本模块，测试锚定）：
 * - **书稿正文永不入包**——本模块不读 `写作/` 下任何文件，只读应用级数据目录；日志段另设内容门：
 *   可能内嵌书库文本的来源（见 CONTENT_BEARING_LOG_TAGS）只保留事件标签，正文片段（账本原文/
 *   章文件名/front matter 行内容）一律省略；
 * - **密钥永不入包**——供应商只取 protocol / 模型名 / 「是否配了 key」布尔，apiKey（含密文）与
 *   baseUrl 值一概不入包（读入仅为判「是否已配置」）；日志逐行过 redactSecret（既有脱敏单源，
 *   同 app-*.jsonl 落盘链）；
 * - **路径脱敏**——应用数据/用户目录/书库根在文本里替换为占位符，另加家目录形态正则兜底
 *  （win `C:\Users\x` / mac+linux `/Users|x/home`）。
 *
 * 落点：`<userData>/诊断包/诊断包-<本地时间戳>.zip`——不放书库目录：诊断包是应用级排查件
 *（与书是否同步/搬走无关），落书库会被云同步带走、并在 `工作区/导出/` 里与导出稿混面。
 * 旧包不清理（同「归档不删」哲学）。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { redactSecret } from '../log/redact.js'
import { errMsg, recentLogFiles } from '../log/index.js'
import { buildZipStoreVolumes, type ZipEntry, type ZipStoreLimits } from './zip.js'

/** 日志收集天数（与日志轮转的保留期同口径，见 recentLogFiles） */
const LOG_DAYS = 7
/** 诊断包目录名（userData 下） */
const BUNDLE_DIR = '诊断包'
/** 实例目录名（共享根下；实例 key 即此目录下的子目录名，见 fs/user-data-path） */
const INSTANCES_DIR = 'instances'
/** 白名单里允许的字符串值长度上限（防某个键藏了长路径/长文本混进包） */
const MAX_WHITELIST_STRING = 60
/** 非 JSON 半行只留长度标记（结构不可解析 → 无法分类是否含书库文本，宁多勿漏） */
const HALF_LINE_PLACEHOLDER = '[非 JSON 行已省略：内容不可分类，仅记字符数]'

/**
 * 可能内嵌书库文本的日志来源——msg 只保留「事件标签」（首个载荷分隔符之前），
 * err 一概不取。正文/设定/账本/章文件名可能出现在这些来源的消息里：
 * leads/lead-updates = 履历与账本推进原文；yaml/book.yaml/frontmatter = 配置与
 * front matter 行内容；state = 已定稿文件路径（含章标题）；rebuild = 摘要目录名；
 * check/metrics = 章文件路径（含书名与章标题）、章纲名与原样 errMsg。
 *
 * 标签位口径（族内改写消息时必须遵守）：内容门只留首个 `「（(：:` 之前的文字，
 * 故**规则 id / 计数 / 降级语义放标签位、路径与原文放分隔符之后**——载荷在标签位
 * 时会被一并保留（相对章路径不属绝对路径替换面，改名后仍带章标题）。
 *
 * 名单由 test/diagnostics/bundle.test.ts 的静态对账维持，三族判据都必须显式分类
 *（收入本名单，或按点位登记理由）：① 实参含 `slice(` 的调用点；② 声明家族
 *（src/check、src/metrics）内的全部调用点；③ 标签位出现书库侧取值插值的调用点。
 * 新的日志来源因此不会静默入包——脱敏漏点是机器门顶红，而不是靠人工回看。
 */
export const CONTENT_BEARING_LOG_TAGS: ReadonlySet<string> = new Set([
  'leads',
  'lead-updates',
  'yaml',
  'book.yaml',
  'frontmatter',
  'learn-commit',
  'state',
  'rebuild',
  'check',
  'metrics',
  // batch-pause：坏暂停记录的留证副本路径是「<共享根>/instances 以外」的书库内绝对
  // 路径（改名后仍带书目录名）；与 check/metrics 同族理由收入名单
  'batch-pause',
])

/**
 * 内容门分类例外的登记表（**不得静默放过**：判为承载书库侧取值、而其 tag 又不在
 * 名单里的调用点，必须在此逐条登记，否则 test/diagnostics/bundle.test.ts 的对账顶红）。
 *
 * key = `<tag>@<src 内相对路径>#<插值表达式原文>`——按点位登记而非按 tag 整支放行：
 * 同文件同 tag 新增的**其它**取值表达式会重新顶红，分类粒度与漏点粒度一致。
 * value = 保留理由（一条一句，能写清就不靠「已知」搪塞）。
 *
 * 通用背景（rel 系）：这些来源的载荷是排查主证据（错误原文 + 定位路径），整支收入
 * 内容门会连带把有用信息一起丢弃，而它们的书库侧取值是**书库内相对路径**（不含绝对
 * 路径前缀，故绝对路径替换面兜不住）。本项范围先收 check/metrics 族；其余族是否收入
 * 名单另行逐一决策——在此之前如实登记保留，不作静默绕过。
 */
export const CONTENT_GATE_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  // 书库内相对路径（文档/章纲/回收站相对路径）——排查「哪一篇/哪一章」的唯一线索
  ['document@document/service-move.ts#oldListRel', '移动失败日志：书纲相对路径是定位被移文档的唯一线索'],
  ['document@document/service-move.ts#newListRel', '移动失败日志：目标相对路径用于判定半成态落位'],
  ['document@document/service.ts#relPath', '文档操作失败日志：相对路径定位该文档'],
  ['document@document/service.ts#rel', '软删/归档失败日志：相对路径定位该文档'],
  ['document@document/service.ts#finalTrashRel', '软删失败日志：最终回收站相对路径用于人工核对'],
  ['books@install/books-repair.ts#relPath', '书库登记修复日志：相对路径定位破损登记项'],
  ['api@studio/server/api/onboard.ts#relPath', '开书引导日志：相对路径定位未落位的文档'],
  ['draft-pipeline@process/draft-pipeline.ts#relPath', '批量起草日志：相对路径定位失败章'],
  [
    'knowledge-seed@knowledge/seed.ts#rel',
    '知识层播种/升级失败日志:该篇相对路径是定位失败篇的唯一线索(随包语料文件名,跨书恒定)',
  ],
  ['prepare@process/prepare.ts#relative(bookRoot, r.path)', '备料失败日志：书内相对路径定位材料文件'],
  // 书库侧文件名/题名（basename 与章节事件标题）
  ['style@format/style.ts#basename(filePath)', '样章文件名是定位该样章的唯一线索（仅「来源」值非法时触发）'],
  ["rag@rag/build.ts#basename(ch._path ?? '')", '索引跳过日志：章文件名定位被跳过的章'],
  ['chain-bridge@events/chain-bridge.ts#e.标题', '链事件回放日志：章节事件标题用于核对事件归属'],
  // 书库绝对路径（宿主目录与家目录替换面只吃前缀，书目录名仍随路径入包）——登记为
  // 有意保留：该行是「同章号两次入库、后写覆盖」的唯一证据（两路径都要看）
  ["cache@cache/sync.ts#ch._path ?? ''", '重复章号入库日志：新旧两路径对照是排查覆盖的唯一证据'],
])

/** 事件标签 = 首个股载荷分隔符（「（(：:）之前的文字 + 省略标记——载荷一律不保留 */
function eventLabelOf(msg: string): string {
  const cut = msg.search(/[「（(：:]/)
  const label = (cut === -1 ? msg : msg.slice(0, cut)).trim()
  return `${label || '(无标签)'}（详情已省略）`
}

/** 内容门：承载书库文本的来源只留事件标签（在 scrub 之后执行，标签面已无载荷） */
function gateLogContent(v: unknown): unknown {
  const r = asRecord(v)
  if (!r) return v
  const tag = typeof r['tag'] === 'string' ? r['tag'] : ''
  if (!CONTENT_BEARING_LOG_TAGS.has(tag)) return v
  return {
    ...r,
    msg: typeof r['msg'] === 'string' ? eventLabelOf(r['msg']) : eventLabelOf(''),
    err: undefined,
  }
}

export interface DiagnosticsOptions {
  /** APP 级数据目录（Electron userData / CLI 约定路径）；null = 无法生成 */
  userDataPath: string | null
  /** 书库根（只用于「书数」计数与路径脱敏占位） */
  workDir: string | null
  /** 应用版本（版本单源 resolveAppVersion，由调用方注入——本模块不反向依赖 update 链） */
  appVersion: string
  /** 生成时刻（测试注入固定值；缺省当前时刻） */
  now?: Date
  /** ZIP 单卷上限收窄（测试注入窄限走分卷/截断路径；生产缺省 = 格式硬上限，见 zip.ts） */
  zipLimits?: Partial<ZipStoreLimits>
}

export interface DiagnosticsResult {
  ok: boolean
  /** 生成的包绝对路径（多卷时 = 第一卷） */
  file?: string
  /** 全部卷路径（卷序；单卷时仅一项。超单卷上限按条目边界分卷，不再整包失败） */
  files?: string[]
  /** 包所在目录绝对路径 */
  dir?: string
  /** 实际入卷条目名（按输入序；首条为 说明.txt；超限被截断省略的条目不列） */
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
    '  日志/        近 7 天应用日志（共享根 logs/ 与各实例 instances/<key>/logs/，逐行脱敏后的 JSONL）',
    '  说明.txt     本文件',
    '',
    '隐私边界：',
    '  · 不含书稿正文、设定、大纲等任何书库内容；',
    '  · 日志段对可能内嵌书库文本的来源（履历/账本/book.yaml/front matter/健康探测/',
    '    缓存重建/机检/画像）只保留事件标签，正文片段与章文件路径一律省略；',
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

  // ── 日志/（近 7 天，逐行脱敏；来源 = 共享根 logs/ + 各实例 instances/<key>/logs/）──
  const logEntries = collectLogEntries(logSourceDirs(userDataPath), now, scrubValue, warnings)

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
    // 超单卷上限（>4GiB 累计或 >65535 条目）不再整包失败——按条目边界分卷，
    // 单条自身超限则截断省略，两条路径都经 warnings 显式提示（不静默丢）。
    const pack = buildZipStoreVolumes(entries, { mtime: now, ...(opts.zipLimits ? { limits: opts.zipLimits } : {}) })
    if (pack.volumes.length === 0) {
      return {
        ok: false,
        error: '诊断包体积超单卷上限且无可入卷条目，未写入任何内容',
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    }
    const files = pack.volumes.map((_, i) => (i === 0 ? file : join(dir, `诊断包-${stamp}-${i + 1}.zip`)))
    let bytes = 0
    for (let i = 0; i < pack.volumes.length; i++) {
      atomicWriteFile(files[i]!, pack.volumes[i]!)
      bytes += pack.volumes[i]!.length
    }
    if (pack.droppedNames.length > 0) {
      const head = pack.droppedNames.slice(0, 3).join('、')
      const more = pack.droppedNames.length > 3 ? ` 等 ${pack.droppedNames.length} 条` : ''
      warnings.push(`诊断包有 ${pack.droppedNames.length} 条超出单卷上限被省略：${head}${more}`)
    }
    if (pack.volumes.length > 1) {
      warnings.push(
        `诊断包超出单卷上限，已按条目边界分 ${pack.volumes.length} 卷写入（${files.map((f) => basename(f)).join('、')}）`,
      )
    }
    return {
      ok: true,
      file: files[0],
      files,
      dir,
      entries: pack.packedNames,
      bytes,
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

/**
 * 日志来源目录清单（共享根 → 各实例目录，升序）。
 *
 * 多库多窗目录分工下日志按实例落盘（`<共享根>/instances/<key>/logs`），共享根自身
 * 无 logs/——只读共享根会得到空日志段（诊断包最有用的一段恒空）。故两处形态全收：
 * 先收共享根 `logs/`（历史布局：目录拆分前的单实例落点；目录存在即收，与实例目录
 * 并存时也收，避免升级后旧包期日志丢失），再收每个 `instances/<key>/logs`。
 * 枚举不按 `instances/` 条目的 Dirent 类型预筛（`isDirectory()` 对**软链**实例目录
 * 为假——数据目录被整体搬迁的机器上会出现「实例在、日志不收」的静默丢面）；
 * 一律按条目名拼 `<key>/logs` 交给 recentLogFiles，非目录（普通文件/损坏项）在其
 * 内部 readdirSync 抛错后返回空清单，读不到就是零条目，不存在静默排除。
 * 也不校验 key 形态——实例 key 的生成规则（库路径 hash / welcome）属
 * fs/user-data-path 的面，此处只认「instances 下各条目的 logs/」这一磁盘事实。
 * 读 instances/ 失败（不存在/权限/竞态）不阻断：退化为「只有共享根一处来源」。
 */
function logSourceDirs(userDataPath: string): Array<{ dir: string; key: string | null }> {
  const dirs: Array<{ dir: string; key: string | null }> = [{ dir: join(userDataPath, 'logs'), key: null }]
  const instancesRoot = join(userDataPath, INSTANCES_DIR)
  let keys: string[] = []
  try {
    keys = readdirSync(instancesRoot).sort()
  } catch {
    // 无 instances/（目录拆分前的旧布局 / 纯 CLI 数据目录）：只有共享根一处来源
    keys = []
  }
  for (const key of keys) dirs.push({ dir: join(instancesRoot, key, 'logs'), key })
  return dirs
}

/** 日志段（近 LOG_DAYS 天，逐行脱敏 + 内容门）：JSON 行 parse→遍历脱敏→内容门
 *  →序列化（转义形态差异下仍能命中路径替换）；非 JSON 半行只留长度标记（结构不可
 *  解析则无法分类来源，载荷一律不保留）。单文件不可读记 warning 不阻断。
 *
 *  重名去重判据：**条目名即包内身份**——多实例各自的 `app-YYYYMMDD.jsonl` 同名，平铺
 *  入包会产出同名条目（解压端同路径后写覆盖先写，先写那份日志静默丢失）。故实例来源
 *  的条目名一律带一层实例 key：`日志/<key>/app-YYYYMMDD.jsonl`。加前缀即完成去重，
 *  无需再比名跳过：实例 key 是 `instances/` 下的唯一目录名（同名目录在一个父目录下
 *  不可能共存），而共享根 `logs/` 的条目名 `日志/app-YYYYMMDD.jsonl` 少一层路径段，
 *  与任何实例来源都不可相撞。历史布局（目录拆分前的共享根 `logs/`）保持裸名，旧包
 *  形态与既有消费方零变化。 */
function collectLogEntries(
  sources: ReadonlyArray<{ dir: string; key: string | null }>,
  now: Date,
  scrubValue: (v: unknown) => unknown,
  warnings: string[],
): ZipEntry[] {
  const out: ZipEntry[] = []
  for (const { dir, key } of sources) {
    const prefix = key === null ? '日志/' : `日志/${key}/`
    for (const abs of recentLogFiles(dir, LOG_DAYS, now)) {
      const base = abs.slice(abs.lastIndexOf('app-'))
      const name = `${prefix}${base}`
      try {
        const redacted = readFileSync(abs, 'utf-8')
          .split('\n')
          .map((line) => {
            if (line.trim() === '') return line
            try {
              return JSON.stringify(gateLogContent(scrubValue(JSON.parse(line) as unknown)))
            } catch {
              return HALF_LINE_PLACEHOLDER
            }
          })
        out.push({ name, data: redacted.join('\n') })
      } catch (e) {
        warnings.push(`日志 ${name} 读取失败：${errMsg(e)}`)
      }
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
