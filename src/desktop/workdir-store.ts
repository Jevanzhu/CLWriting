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
import { existsSync } from 'node:fs'

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
  const seen = new Set<string>()
  const recent = recentRaw
    .filter(isRecentItem)
    .filter((r) => {
      if (seen.has(r.path)) return false
      seen.add(r.path)
      return true
    })
    .slice(0, MAX_RECENT)
  return { current, recent }
}

/**
 * 切换 current：把 newCurrent 设为当前，旧 current（若与新不同）推入 recent 头部。
 * recent 去重（按 path）、剔除等于新 current 的项、截断 MAX_RECENT。
 * 同值切换是 no-op（不把自己塞进 recent）。
 */
export function setCurrent(store: WorkDirStore, newCurrent: string): WorkDirStore {
  const oldCurrent = store.current && store.current !== newCurrent ? store.current : null
  const candidates: RecentItem[] = [
    ...(oldCurrent ? [{ path: oldCurrent, label: basename(oldCurrent) }] : []),
    ...store.recent,
  ]
  const seen = new Set<string>()
  const recent = candidates
    .filter((r) => r.path !== newCurrent)
    .filter((r) => {
      if (seen.has(r.path)) return false
      seen.add(r.path)
      return true
    })
    .slice(0, MAX_RECENT)
  return { current: newCurrent, recent }
}

/**
 * 过滤掉 recent 中已失效（目录不存在）的项 —— 启动时清理。
 * current 失效不在本函数处理（由调用方决定是否弹选择器重选）。
 */
export function filterValidRecent(store: WorkDirStore): WorkDirStore {
  return { current: store.current, recent: store.recent.filter((r) => existsSync(r.path)) }
}

/** 序列化为 workdir.json 文本（pretty + 尾换行）。 */
export function serializeStore(store: WorkDirStore): string {
  return JSON.stringify(store, null, 2) + '\n'
}
