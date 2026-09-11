/**
 * R0912（重评-0911b P2③ / 重评-0911c）：task-gate 端口回归——ai→studio 反向依赖
 * 收口为「ai 层端口 + stream.ts 注册」后的三重锚定：
 *   1. 端口单测：注册前 no-op 放行、注册后透传真实闸、重注册覆盖；
 *   2. 注册接线源锚：registerStreamRoutes 必调 registerTaskGateProvider（生产 chat
 *      工具侧闸缺位的静默放行只能靠此锚拦——纯源码 grep 断言，先例 r0911-g-p3-4）；
 *   3. turns.ts 源锚：ai 层不再反向 import studio/server/api/task-gate（分层回归门，
 *      治理测试 dependency-direction 语义的文件级补充）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { acquireTaskGateViaPort, registerTaskGateProvider, resetTaskGateProviderForTest } from '../../src/ai/orchestrate/task-gate-port.js'

const root = fileURLToPath(new URL('../../', import.meta.url))
const readSrc = (rel: string): string => readFileSync(`${root}${rel}`, 'utf8')

describe('R0912：task-gate 端口（依赖倒置）', () => {
  afterEach(() => resetTaskGateProviderForTest())

  it('未注册 → no-op release 放行（纯 ai 层形态不得 409）', () => {
    const release = acquireTaskGateViaPort('某书', 'rewrite')
    expect(release).not.toBeNull()
    expect(() => release!()).not.toThrow()
  })

  it('注册后透传：provider 收到调用、release 原样返回', () => {
    const calls: Array<[string, string]> = []
    const sentinel = (): void => {}
    registerTaskGateProvider((book, action) => {
      calls.push([book, action])
      return sentinel
    })
    const release = acquireTaskGateViaPort('甲书', 'rewrite')
    expect(release).toBe(sentinel)
    expect(calls).toEqual([['甲书', 'rewrite']])
  })

  it('重注册覆盖旧 provider（registerStreamRoutes 幂等注册语义）', () => {
    registerTaskGateProvider(() => null) // 恒忙形态
    expect(acquireTaskGateViaPort('甲书', 'rewrite')).toBeNull()
    registerTaskGateProvider(() => (): void => {}) // 恒闲形态
    expect(acquireTaskGateViaPort('甲书', 'rewrite')).not.toBeNull()
  })

  it('注册接线源锚：registerStreamRoutes 必调 registerTaskGateProvider', () => {
    const src = readSrc('src/studio/server/api/stream.ts')
    expect(src).toContain('registerTaskGateProvider(acquireTaskGate)')
    expect(existsSync(`${root}src/ai/orchestrate/task-gate-port.ts`)).toBe(true)
  })

  it('分层源锚：ai 层零 studio 反向 import（dependency-direction 文件级补充）', () => {
    for (const rel of ['src/ai/orchestrate/chat/turns.ts', 'src/ai/orchestrate/task-gate-port.ts']) {
      expect(readSrc(rel)).not.toMatch(/from\s+['"].*studio\/server/)
    }
  })
})
