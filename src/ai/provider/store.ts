/**
 * providers.json 读写——应用级（userDataPath），跨书共享（方案 §四①）。
 *
 * 不进书库目录：供应商是「这台机器的作者用什么服务」，不是「这本书的属性」。
 * 书库可能进 git，凭据不能跟着走。
 *
 * 凭据明文存 + 文件权限 0600——不用 Electron safeStorage（Linux 上行为不一致）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProviderConf, ProviderSettings } from './types.js'

const FILE = 'providers.json'

/** 空 settings（首次启动 / 文件缺失时） */
export function emptySettings(): ProviderSettings {
  return { providers: [], currentId: null }
}

/** 读 providers.json；不存在 / 损坏 → 空 settings */
export function loadProviders(userDataPath: string): ProviderSettings {
  const fp = `${userDataPath}/${FILE}`
  if (!existsSync(fp)) return emptySettings()
  try {
    const raw = JSON.parse(readFileSync(fp, 'utf8')) as ProviderSettings
    if (!Array.isArray(raw.providers)) return emptySettings()
    return {
      providers: raw.providers,
      currentId: raw.currentId ?? null,
    }
  } catch {
    return emptySettings()
  }
}

/** 写 providers.json；权限 0600（防其他用户读凭据） */
export function saveProviders(userDataPath: string, s: ProviderSettings): void {
  const fp = `${userDataPath}/${FILE}`
  mkdirSync(dirname(fp), { recursive: true })
  writeFileSync(fp, JSON.stringify(s, null, 2) + '\n', 'utf8')
  try {
    chmodSync(fp, 0o600)
  } catch {
    // Windows / 某些 FS 不支持 chmod；写成功即可
  }
}

/** 当前启用的供应商；未配置 / currentId 指向已删条目 → null */
export function currentProvider(userDataPath: string): ProviderConf | null {
  const s = loadProviders(userDataPath)
  if (!s.currentId) return null
  return s.providers.find((p) => p.id === s.currentId) ?? null
}

/** 新供应商 ID */
export function newProviderId(): string {
  return `prov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
}

/** key 遮蔽：只留前 4 后 4，不足 8 位 → *** */
export function maskKey(key: string): string {
  if (key.length < 8) return '***'
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}
