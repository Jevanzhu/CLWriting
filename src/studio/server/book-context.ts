/**
 * 书级上下文读取：kind 判定单源。
 * 收敛 api 层 readKind × 4（draft/rewrite/review/outline）+ resolveKind × 2（health/files），
 * 去掉原先削弱类型安全的多余 `as` 断言（readBookConfig 联合返回两分支均带 config，`!ok` 收窄后直接可访问）。
 * 读不到 / 缺失 / 异常时默认 long，不阻断调用方。
 */
import { join } from 'node:path'
import { readBookConfig } from '../../format/yaml.js'

export function readKind(bookRoot: string): 'long' | 'short' {
  try {
    const r = readBookConfig(join(bookRoot, 'book.yaml'))
    if (!r.ok) return 'long'
    return r.config.kind === 'short' ? 'short' : 'long'
  } catch {
    return 'long'
  }
}
