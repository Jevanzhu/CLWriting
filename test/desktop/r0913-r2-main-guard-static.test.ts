/**
 * 重评二轮-P2-1（2026-09-13 全库源码重评二轮 GLM-5.3）：main.ts 底部生命周期守卫
 * 必须同时消费 Electron 单实例锁与文件锁双标志——跨提权双开时第二实例
 * gotSingleInstanceLock=true 而 appInstanceGuard.acquired=false（Electron 锁按提权
 * 上下文隔离，文件锁防线要堵的正是该形态），单看前者会放行生命周期全注册（瞬态
 * 起 server child/开窗/写 workdir.json），语义层竞态重开。
 *
 * 静态源码断言而非进程级行为断言：main.test.ts 的 Electron 假件与 will-quit 注册
 * 交互曾致 vitest worker OOM（R0913-win P3-13 批如实记档），本断言零 Electron 依赖
 * （只读源文件文本），与 app-instance-guard 的行为测（r0913-app-instance-guard）
 * 分层互补：那边锁文件锁语义，这边钉 main.ts 接线面。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_TS = join(import.meta.dirname, '../../src/desktop/main.ts')

describe('重评二轮-P2-1: main.ts 底部守卫双标志消费（静态接线面）', () => {
  const src = readFileSync(MAIN_TS, 'utf8')

  it('守卫条件 = gotSingleInstanceLock && appInstanceGuard.acquired（缺一即竞态重开）', () => {
    expect(src).toContain('if (gotSingleInstanceLock && appInstanceGuard.acquired) {')
  })

  it('守卫体内起 bootstrap（whenReady 注册）——标志语义不空转', () => {
    // 双标志门内必须仍是生命周期注册体（防未来重构把门改成空壳/挪位后断言悬空）
    const at = src.indexOf('if (gotSingleInstanceLock && appInstanceGuard.acquired) {')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, at + 800)
    expect(body).toContain('whenReady')
  })
})
