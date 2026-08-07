/**
 * 书级 kind 判定单源（P1-8 架构下沉：从 studio/server/book-context 下沉内核）。
 *
 * 读不到 / 缺失 / 异常时默认 long，不阻断调用方。
 */
import { join } from 'node:path'
import { readBookConfig } from './yaml.js'

export function readKind(bookRoot: string): 'long' | 'short' {
  try {
    const r = readBookConfig(join(bookRoot, 'book.yaml'))
    if (!r.ok) return 'long'
    return r.config.kind === 'short' ? 'short' : 'long'
  } catch {
    return 'long'
  }
}