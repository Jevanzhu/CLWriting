import { apiJson } from './client'

/** 书库级偏好（.clwriting/prefs.json）：工作区布局 + 可覆盖编辑器偏好。 */
export interface BookPrefs {
  pageWidth?: number
  autosaveInterval?: number
  leftWidth?: number
  leftOpen?: boolean
  rightOpen?: boolean
  leftPanel?: string
  activeDocId?: string | null
  treeExpanded?: string[]
  [k: string]: unknown
}

export async function getBookPrefs(name: string): Promise<BookPrefs> {
  const r = await apiJson<{ prefs: BookPrefs }>(
    `/api/books/${encodeURIComponent(name)}/prefs`,
  )
  return r.prefs
}

export async function putBookPrefs(name: string, prefs: BookPrefs): Promise<void> {
  await apiJson<{ ok: true }>(`/api/books/${encodeURIComponent(name)}/prefs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs }),
  })
}

// ── 全局编辑器偏好（.clwriting/global.json）──

/** 全局编辑器偏好：跨书共享的外观设置（对齐 Obsidian vault 级配置）。 */
export interface GlobalPrefs {
  theme?: 'light' | 'dark'
  proseSize?: number
  proseLh?: number
  proseGap?: number
  uiFontCn?: string
  uiFontEn?: string
  proseFontCn?: string
  proseFontEn?: string
  pageWidth?: number
  autosaveInterval?: number
  [k: string]: unknown
}

export async function getGlobalPrefs(): Promise<GlobalPrefs> {
  const r = await apiJson<{ prefs: GlobalPrefs }>(`/api/library/prefs`)
  return r.prefs
}

export async function putGlobalPrefs(prefs: GlobalPrefs): Promise<void> {
  await apiJson<{ ok: true }>(`/api/library/prefs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs }),
  })
}
