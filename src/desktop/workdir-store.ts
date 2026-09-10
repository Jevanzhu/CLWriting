/**
 * 工作目录（书库）持久化存储 —— 纯数据变换，零 Electron 依赖（可单测）。
 *
 * Electron 绑定层（app.getPath + 文件读写）在 main.ts 内联调用本模块纯函数，
 * 避免把 'electron' 运行时依赖引入测试。
 *
 * 持久化文件 userData/workdir.json：
 *   { current: "/abs/path" | null, recent: [{ path, label }, ...] }
 *
 * 关联：Dev/Plans/desktop-workdir-方案.md（决策③ 多数库切换）。
 */
import { basename } from 'node:path'
import { stat as statAsync } from 'node:fs/promises'
// R51-A-5（五十一轮）：路径等值判定单源——win（NTFS）与 mac（默认 APFS）卷大小写
// 不敏感，路径经启动器/手工输入/Finder 可 case-only 漂移，字符串全等会把同一书库
// 劈成两条记录（展示面污染）。samePath 已在 darwin/win32 折叠（R51-D-2 单源）。
import { samePath } from '../fs/user-data-path.js'

export interface RecentItem {
  /** 书库绝对路径 */
  path: string
  /** 展示名（目录 basename） */
  label: string
}

export interface WorkDirStore {
  /** 当前书库目录；null = 未选 */
  current: string | null
  /** 最近书库（不含 current），最多 MAX_RECENT 条 */
  recent: RecentItem[]
}

/** 最近书库列表上限（决策③）。 */
export const MAX_RECENT = 5

/** 空存储（首次启动 / 文件损坏）。每次返回新对象避免共享引用。 */
export function emptyStore(): WorkDirStore {
  return { current: null, recent: [] }
}

/** 校验一个值是否为合法 RecentItem。 */
function isRecentItem(v: unknown): v is RecentItem {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o['path'] === 'string' && typeof o['label'] === 'string'
}

/**
 * 解析 workdir.json 原文为 WorkDirStore（容错）。
 * 损坏 / 缺字段 / 类型不符 → 空存储，不抛异常。
 * R51-A-5（五十一轮）：判重改 samePath 等值——win/mac 大小写不敏感卷上 case-only
 * 漂移的同库双条目（如手工改写 workdir.json 或历史版本落盘的异形路径）不再双显；
 * 大小写敏感卷（linux）维持精确全等，合法异名共存不受影响。
 */
export function parseStore(raw: string): WorkDirStore {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return emptyStore()
  }
  if (typeof obj !== 'object' || obj === null) return emptyStore()
  const o = obj as Record<string, unknown>
  const current = typeof o['current'] === 'string' ? (o['current'] as string) : null
  const recentRaw = Array.isArray(o['recent']) ? o['recent'] : []
  const seen: string[] = []
  const recent = recentRaw
    .filter(isRecentItem)
    .filter((r) => {
      // R51-A-5：samePath 等值判重（上限 5 条，线性扫描无规模面）
      if (seen.some((p) => samePath(p, r.path))) return false
      seen.push(r.path)
      return true
    })
    .slice(0, MAX_RECENT)
  return { current, recent }
}

/**
 * 切换 current：把 newCurrent 设为当前，旧 current（若与新不同）推入 recent 头部。
 * recent 去重（按 path）、剔除等于新 current 的项、截断 MAX_RECENT。
 * 同值切换是 no-op（不把自己塞进 recent）。
 * R51-A-5（五十一轮）：三处等值判定（新旧 current 比较 / recent 剔除 / 判重）改
 * samePath——win 大小写漂移下 current 与 recent 同库异形并存、切回时不剔除旧条目
 * 的展示面污染同源收口。注意 current 仍按调用方原样字串落盘（不归一化改写用户数据，
 * 物理身份判定另有 samePhysicalPath 消费面）。
 */
export function setCurrent(store: WorkDirStore, newCurrent: string): WorkDirStore {
  const oldCurrent = store.current && !samePath(store.current, newCurrent) ? store.current : null
  const candidates: RecentItem[] = [
    ...(oldCurrent ? [{ path: oldCurrent, label: basename(oldCurrent) }] : []),
    ...store.recent,
  ]
  const seen: string[] = []
  const recent = candidates
    .filter((r) => !samePath(r.path, newCurrent))
    .filter((r) => {
      // R51-A-5：samePath 等值判重（同 parseStore）
      if (seen.some((p) => samePath(p, r.path))) return false
      seen.push(r.path)
      return true
    })
    .slice(0, MAX_RECENT)
  return { current: newCurrent, recent }
}

/** R1010-P2-1：recent 有效性预探超时哨兵（race reject 载体——stat 真实异常带 errno code，唯超时无）。 */
const RECENT_PROBE_TIMEOUT = Symbol('recent-probe-timeout')

/** 单条预探默认预算（ms）；调用方（main.ts bootstrap）注入 CLW_BOOTSTRAP_PROBE_TIMEOUT_MS 口径。 */
export const RECENT_PROBE_DEFAULT_TIMEOUT_MS = 2_000

/** 预探注入形态（默认 node:fs/promises stat；测试注入挂起/失败形态）。 */
export type StatLike = (p: string) => Promise<{ isDirectory(): boolean }>

/**
 * 过滤掉 recent 中已失效的项 —— 启动时清理一次（current 失效不在本函数处理，由调用方
 * 决定是否弹选择器重选）。
 * R26-93（二十六轮）：目录有效性判定含 isDirectory——existsSync 对「同路径普通文件」
 * 也为 true：书库目录被同名文件顶替（误删后重建/解压残留）时该 recent 项不再可用，
 * 却原样保留 → 点击切换后链路把文件路径当书库目录用。
 * R1010-P2-1（2026-09-10 全量重评 GLM-5.3 修复批）：同步 existsSync+statSync 改
 * 「fs/promises stat + 超时预算」——原实现逐条同步 stat，recent 残留失联网络卷
 * （NAS/SMB 挂载点在而服务器无响应）时启动首读同步冻主进程数十秒（R47-9/R54-A-2/
 * 重审-1 反复修复的同一冻结族，readStore 首读入口漏网——probeDirReachable 防线只护
 * current/cwd）。三态分诊（probeDirReachable 同款口径）：
 *   stat 通过且 isDirectory → 保留；确定性快速失败（ENOENT/EACCES/ENOTDIR 等）→ 剔除
 *   （原语义不变，判定窗口内被删/权限按无效处理，不裸抛破坏容错契约）；
 *   超时（失联卷挂死面）→ 跳过判定保留展示——失联不等于失效，择库守卫另有预探拦截
 *   兜底，R48-73「残留只污展示面不产行为错」取舍口径不变。
 * 逐条独立预算并行探测（recent ≤ MAX_RECENT 条，并行后总预算 = 单条预算，不串行放大
 * 启动延迟）；返回新对象，保序过滤。
 */
export async function filterValidRecentBudgeted(
  store: WorkDirStore,
  opts?: { timeoutMs?: number; stat?: StatLike },
): Promise<WorkDirStore> {
  const timeoutMs = opts?.timeoutMs ?? RECENT_PROBE_DEFAULT_TIMEOUT_MS
  const stat = opts?.stat ?? statAsync
  const verdicts = await Promise.all(
    store.recent.map(async (r) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const s = await Promise.race([
          stat(r.path),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(RECENT_PROBE_TIMEOUT), timeoutMs)
          }),
        ])
        return s.isDirectory()
      } catch (e) {
        return e === RECENT_PROBE_TIMEOUT // 超时保留；确定性失败剔除
      } finally {
        // probeDirReachable 同款卫生：探测结束清掉超时计时器，不空转滞留
        if (timer) clearTimeout(timer)
      }
    }),
  )
  return { current: store.current, recent: store.recent.filter((_, i) => verdicts[i]) }
}

/** 序列化为 workdir.json 文本（pretty + 尾换行）。 */
export function serializeStore(store: WorkDirStore): string {
  return JSON.stringify(store, null, 2) + '\n'
}
