/**
 * 阶段 53 ：更新检查客户端（静默、进程内一次、失败不抛）。
 *
 * 口径六面（设计 §三）：版本源见 `resolveAppVersion`；只提示**正式版**（筛选在
 * pickLatestStable）；启动后延迟一次、进程内一次、不落盘；失败/离线/被墙/限速
 * 一律静默（§3.3）。数据源 = 公开仓匿名 releases 列表（60/h/IP，每次启动至多 1 请求）。
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

/** GitHub releases 列表（公开仓匿名；per_page 上限 100，20 足够覆盖正式版 + 若干 rc） */
export const RELEASES_URL = 'https://api.github.com/repos/Jevanzhu/CLWriting/releases?per_page=20'

/** 单次请求超时（设计 §3.3：5s；超时即静默放弃，不重试） */
export const UPDATE_CHECK_TIMEOUT_MS = 5000

/** 起服后延迟检查的缺省毫秒数（接线用；不与起服抢首屏） */
export const UPDATE_CHECK_DELAY_MS = 5000

/** 测试态开关（设计 §3.3）：置 1 时完全不检查——e2e/单测不打网的硬保证 */
export const UPDATE_CHECK_DISABLE_ENV = 'CLW_DISABLE_UPDATE_CHECK'

export interface UpdateCheckResult {
  /** 新版本号（已去前导 v，供前端拼「vX.Y.Z」文案） */
  version: string
  /** 发布页地址（外链 IPC 白名单前缀内） */
  url: string
}

/** 进程内结果（随 server 生命周期，同 startup-notices sink 语义：不落盘）。
 * 收敛：原手写模块可变态（`let state` / `let result` + 测试钩子直改）
 *  换装 testableConst 工厂——生产写入/读取与测试注入走同一元组，模块面无裸可变量。 */
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

/** 本次检查的结局（区分「取到 tag」「没取到正式版」与「出错」，后者才留 info） */
type FetchOutcome = { kind: 'tag'; tag: string } | { kind: 'none' } | { kind: 'error'; reason: string }

async function fetchOutcome(fetchImpl: typeof fetch, timeoutMs: number): Promise<FetchOutcome> {
  const controller = timeoutMs > 0 ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const resp = await fetchImpl(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      ...(controller ? { signal: controller.signal } : {}),
    })
    if (!resp.ok) {
      // 非 2xx（含 403 限速）响应体不消费则连接不回池（embed.ts C104 同款）——best-effort 取消
      try {
        await resp.body?.cancel()
      } catch {
        // 已断/已尽等形态不阻断失败返回
      }
      return { kind: 'error', reason: `HTTP ${resp.status}` }
    }
    const data = (await resp.json()) as unknown
    if (!Array.isArray(data)) return { kind: 'error', reason: '响应不是数组' }
    const tags = data
      .filter((r): r is { tag_name?: unknown; draft?: unknown } => typeof r === 'object' && r !== null)
      // draft 匿名 list 本不含，防御性保留；prerelease 标记不参与筛选（rc 不标
      // prerelease，靠 tag 串里的 `-` 判别——pickLatestStable 负责）
      .filter((r) => r.draft !== true)
      .map((r) => r.tag_name)
      .filter((t): t is string => typeof t === 'string')
    const tag = pickLatestStable(tags)
    return tag === null ? { kind: 'none' } : { kind: 'tag', tag }
  } catch (e) {
    return { kind: 'error', reason: errMsg(e) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 取最新**正式版** tag（原串，含前导 v；无正式版/失败 → null，不抛）。
 * @param fetchImpl 注入用（缺省全局 fetch；测试传桩）
 * @param timeoutMs 超时毫秒；<=0 关闭超时
 */
export async function fetchLatestStable(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | null> {
  const outcome = await fetchOutcome(fetchImpl, timeoutMs)
  return outcome.kind === 'tag' ? outcome.tag : null
}

/**
 * 跑一次检查（起服后延迟调用一次；fire-and-forget，调用方不 await）。
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
  const outcome = await fetchOutcome(opts?.fetchImpl ?? fetch, opts?.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS)
  setCheckState('done')
  if (outcome.kind === 'error') {
    // 静默口径（§3.3）：只留一行 info（非 warn）——详见文件头与 embed.ts 的差异说明
    log.info('update', `更新检查未完成（${outcome.reason}）——静默跳过，不重试`)
    return
  }
  if (outcome.kind === 'none' || current === '0.0.0') return
  if (compareSemver(current, outcome.tag) >= 0) return
  setCheckResult({
    version: outcome.tag.replace(/^v/, ''),
    url: `https://github.com/Jevanzhu/CLWriting/releases/tag/${encodeURIComponent(outcome.tag)}`,
  })
}

/** 更新结果（null = 未完成或已查无新版；端点 `update` 字段直用） */
export function getUpdateCheckResult(): UpdateCheckResult | null {
  return getCheckResult()
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

/** 检查是否已跑过（端点/前端测试判别未完成态用；生产只读） */
export function getUpdateCheckState(): 'idle' | 'done' {
  return getCheckState()
}
