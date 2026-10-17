/**
 * 阶段 53：更新检查客户端（静默、进程内一次、失败不抛）。
 *
 * 口径六面（设计 §三）：版本源见 `resolveAppVersion`；只提示**正式版**（筛选在
 * pickLatestStable）；启动后延迟一次、进程内一次、不落盘；失败/离线/被墙/限速
 * 一律静默（§3.3）。数据源 = 公开仓匿名 releases 列表（60/h/IP，每次启动至多 1 请求）。
 *
 * 阶段 55 扩资产面：结果随带便携 zip 资产与校验清单地址（纯解析在 `asset.ts`），
 * 前端「下载并更新」与主进程下载链据此定位；同一响应内解析，不额外请求。
 *
 * 出站归**主进程**：`update-controller.createUpdateCheckHost` 以 Electron `net.fetch`
 * 调本模块的 `runUpdateCheckOnce`（Chromium 网络栈受系统代理，与下载腿同通道）。服务端
 * 子进程的全局 fetch 不读代理，「只配系统代理」的用户曾因此永远收不到提示；子进程改为
 * 不下发结果即不自行出站——主进程跑完经 parentPort 送 `UPDATE_RESULT_MESSAGE_TYPE`
 * 消息，`applyUpdateCheckResult` 落态，端点（`app-info`）照旧读 `getUpdateCheckResult`。
 *
 * 与 `src/rag/embed.ts`（本仓另一出站面）的**刻意差异**（设计 §3.3）：那边失败打
 * warn 去抖，因为「配了代理为何召回为空」需要可定位；更新检查失败对用户无任何损害
 * （少一次提示而已），打 warn 只会给正常离线使用刷噪音——故失败只留一行 **info**
 * （「本次没检查成」可查，不构成告警）。
 *
 * 静默红线：本模块对外只暴露「结果」与「无结果」，不向上抛任何异常——起服链上
 * fire-and-forget 调用它，抛错会变成未处理拒绝。
 */
import process from 'node:process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { testableConst } from '../shared/testable.js'
import { log, errMsg } from '../log/index.js'
import { compareSemver, pickLatestStable } from './semver.js'
import { pickChecksumsUrl, pickPortableAsset, type UpdateAsset } from './asset.js'

/** GitHub releases 列表（公开仓匿名；per_page 上限 100，20 足够覆盖正式版 + 若干 rc） */
const RELEASES_URL = 'https://api.github.com/repos/Jevanzhu/CLWriting/releases?per_page=20'

/** 单次请求超时（设计 §3.3：5s；超时即静默放弃，不重试） */
const UPDATE_CHECK_TIMEOUT_MS = 5000

/** 起服后延迟检查的缺省毫秒数（主进程侧接线用；不与起服抢首屏） */
export const UPDATE_CHECK_DELAY_MS = 5000

/** 测试态开关（设计 §3.3）：置 1 时完全不检查——e2e/单测不打网的硬保证 */
export const UPDATE_CHECK_DISABLE_ENV = 'CLW_DISABLE_UPDATE_CHECK'

export interface UpdateCheckResult {
  /** 新版本号（已去前导 v，供前端拼「vX.Y.Z」文案） */
  version: string
  /** 发布页地址（外链 IPC 白名单前缀内） */
  url: string
  /** 便携 zip 资产（有则可一键下载更新；null = 只给发布页链接的降级态） */
  asset: UpdateAsset | null
  /** 校验清单地址（`asset.sha256` 缺失时的校验值来源；无 → null） */
  checksumsUrl: string | null
}

/** 最新正式版（tag + 原始 assets 数组）——下载链按此重新解析资产，无需二次请求 */
export interface LatestRelease {
  /** tag 原串（含前导 v） */
  tag: string
  assets: unknown
}

/** 进程内结果（随 server 生命周期，同 startup-notices sink 语义：不落盘）。
 * 收敛：原手写模块可变态（`let state` / `let result` + 测试钩子直改）
 *  换装 testableConst 工厂——生产写入/读取与测试注入走同一元组，模块面无裸可变量。
 * 写入两路：主进程跑完经 parentPort 下发（`applyUpdateCheckResult`，生产唯一路径）；
 * 测试直置（`__setUpdateCheckResultForTest`）。子进程不自行出站，见文件头。 */
const [getCheckState, setCheckState] = testableConst<'idle' | 'done'>('idle')
const [getCheckResult, setCheckResult] = testableConst<UpdateCheckResult | null>(null)

/**
 * 当前版本号**单源**（设计 §3.1）：`CLW_APP_VERSION`（主进程 app.getVersion 经
 * server-manager 注入）优先；缺省（node 直跑 dev:api / e2e / 单测）回落读仓库
 * package.json（模块相对推导，`src/update/` 与 `dist/desktop/` 两级上跳同指仓库根，
 * 与 `src/fs/resources.ts` 同款推导）。读不到一律回落 `'0.0.0'`——版本未知只影响
 * 「是否提示」，不该让起服或端点失败。
 */
export function resolveAppVersion(): string {
  const injected = process.env['CLW_APP_VERSION']
  if (injected !== undefined && injected.trim() !== '') return injected.trim()
  try {
    const here = dirname(fileURLToPath(import.meta.url)) // <root>/src/update（打包态 dist/desktop）
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as { version?: unknown }
    if (typeof pkg.version === 'string' && pkg.version.trim() !== '') return pkg.version.trim()
  } catch {
    // best-effort：dev 直跑形态 package.json 应在；缺失/畸形时静默回落
  }
  return '0.0.0'
}

/** 定位正式版的结局三态（「取到正式版」/「发布集里没有正式版」/「取不到（出错）」）。
 *  三态不可合成一个 null：检查链只对 `error` 留一行 info（另两态静默），而下载链的失败
 *  文案必须分开——`none` 不是网络问题，报「网络不可达」会把排查引向代理。 */
export type LatestReleaseOutcome =
  { kind: 'release'; release: LatestRelease } | { kind: 'none' } | { kind: 'error'; reason: string }

/**
 * 定位最新**正式版**发布（tag + 原始 assets；三态见 `LatestReleaseOutcome`，不抛）。
 * 检查链与下载链共用本面：检查链取结论，下载链在用户点「下载并更新」时重新定位资产。
 * @param fetchImpl 注入用（主进程传 `net.fetch`；测试传桩）
 * @param timeoutMs 超时毫秒；<=0 关闭超时
 */
export async function resolveLatestRelease(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): Promise<LatestReleaseOutcome> {
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const resp = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!resp.ok) {
      // 非 2xx（含 403 限速）响应体不消费则连接不回池（embed.同款）——best-effort 取消
      try {
        await resp.body?.cancel()
      } catch {
        // 已断/已尽等形态不阻断失败返回
      }
      return { kind: 'error', reason: `HTTP ${resp.status}` }
    }
    const data = (await resp.json()) as unknown
    if (!Array.isArray(data)) return { kind: 'error', reason: '响应不是数组' }
    const entries = data
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      // draft 匿名 list 本不含，防御性保留；prerelease 标记不参与筛选（rc 不标
      // prerelease，靠 tag 串里的 `-` 判别——pickLatestStable 负责）
      .filter((r) => r['draft'] !== true)
      .map((r) => ({ tag: r['tag_name'], assets: r['assets'] }))
      .filter((e): e is { tag: string; assets: unknown } => typeof e.tag === 'string')
    const tag = pickLatestStable(entries.map((e) => e.tag))
    if (tag === null) return { kind: 'none' }
    // tag → 该 release 的 assets（同一次响应内配对，不额外请求；解析交 asset.ts 纯函数面）
    const picked = entries.find((e) => e.tag === tag)
    return { kind: 'release', release: { tag, assets: picked?.assets } }
  } catch (e) {
    return { kind: 'error', reason: errMsg(e) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 跑一次检查（主进程侧起服后延迟调用一次；调用方 await 到落定后取结果下发子进程）。
 * 开关短路：`CLW_DISABLE_UPDATE_CHECK=1` 直接返回且**不置结果**（保持未完成态——
 * 关掉检查的环境里端点不会凭空给出「已查无新版」）。
 */
export async function runUpdateCheckOnce(opts?: {
  /** 覆盖当前版本（测试用；缺省 resolveAppVersion） */
  currentVersion?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<void> {
  if (process.env[UPDATE_CHECK_DISABLE_ENV] === '1') return

  const current = opts?.currentVersion ?? resolveAppVersion()
  const outcome = await resolveLatestRelease(opts?.fetchImpl ?? fetch, opts?.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS)
  setCheckState('done')
  if (outcome.kind === 'error') {
    // 静默口径（§3.3）：只留一行 info（非 warn）——详见文件头与 embed.ts 的差异说明
    log.info('update', `更新检查未完成（${outcome.reason}）——静默跳过，不重试`)
    return
  }
  if (outcome.kind === 'none' || current === '0.0.0') return
  if (compareSemver(current, outcome.release.tag) >= 0) return
  const version = outcome.release.tag.replace(/^v/, '')
  setCheckResult({
    version,
    url: `https://github.com/Jevanzhu/CLWriting/releases/tag/${encodeURIComponent(outcome.release.tag)}`,
    // 资产面与版本同一响应内解析——`asset` 为 null 即前端只给「去下载」链接
    asset: pickPortableAsset(outcome.release.assets, version),
    checksumsUrl: pickChecksumsUrl(outcome.release.assets),
  })
}

/** 更新结果（null = 未完成或已查无新版；端点 `update` 字段直用） */
export function getUpdateCheckResult(): UpdateCheckResult | null {
  return getCheckResult()
}

/** main → child 下发检查结果的消息类型（协议形状两侧共用本单源：`update-controller` 发、
 *  `server-utility` 收）。只在检查真跑完后下发——收到即「已检查」，result null 即无新版。 */
export const UPDATE_RESULT_MESSAGE_TYPE = 'update-check-result'

/** 下发消息载荷（`{ type, result }`；result 形状校验见 `parsePushedUpdateCheckResult`） */
export interface UpdateResultMessage {
  type: typeof UPDATE_RESULT_MESSAGE_TYPE
  result: unknown
}

/**
 * 下发载荷 → 结果（形状抽查后收下；不合形一律 null）。
 * 契约由本方主进程构造（非外部输入），此处只防「字段漂移 / 半截对象」流进端点响应：
 * version/url 非空串、asset 为 null 或缺 name/url 的字符串对象、checksumsUrl 为 null 或串。
 */
export function parsePushedUpdateCheckResult(raw: unknown): UpdateCheckResult | null {
  if (raw === null) return null
  if (typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const version = r['version']
  const url = r['url']
  if (typeof version !== 'string' || version === '' || typeof url !== 'string' || url === '') return null
  const checksumsUrl = r['checksumsUrl'] ?? null
  if (checksumsUrl !== null && typeof checksumsUrl !== 'string') return null
  const asset = r['asset'] ?? null
  if (asset === null) return { version, url, asset: null, checksumsUrl }
  if (typeof asset !== 'object') return null
  const a = asset as Record<string, unknown>
  if (typeof a['name'] !== 'string' || a['name'] === '' || typeof a['url'] !== 'string' || a['url'] === '') return null
  return {
    version,
    url,
    asset: {
      name: a['name'],
      url: a['url'],
      size: typeof a['size'] === 'number' ? a['size'] : null,
      sha256: typeof a['sha256'] === 'string' ? a['sha256'] : null,
    },
    checksumsUrl,
  }
}

/** 落主进程下发的检查结果（子进程侧生产写入唯一路径；收到即「已检查」——内部自跑已随
 *  迁主进程移除，端点三态语义不变）。 */
export function applyUpdateCheckResult(result: UpdateCheckResult | null): void {
  setCheckState('done')
  setCheckResult(result)
}

/** 测试钩子：复位为未完成态（模块内存态跨用例隔离用） */
export function __resetUpdateCheckForTest(): void {
  setCheckState('idle')
  setCheckResult(null)
}

/** 测试钩子：直接置于「已查到某版本」态（端点三态形状用例用，不打网） */
export function __setUpdateCheckResultForTest(next: UpdateCheckResult | null): void {
  setCheckState('done')
  setCheckResult(next)
}

/** 检查是否已跑过（端点 update 三态判定「未完成」与测试判别用）。
 *  生产路由不直接调它——端点读 getUpdateCheckResult 的 null 即「未完成/查无新版」
 *  合并态；本函数只被测试用作非空基断言（= 检查真跑过而非被开关短路）。 */
export function getUpdateCheckState(): 'idle' | 'done' {
  return getCheckState()
}
