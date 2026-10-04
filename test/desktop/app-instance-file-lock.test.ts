/**
 * R0913-win P3-13（2026-09-13 全库源码重评 win 适配修复批）：应用实例文件锁守卫。
 * 语义锚定：空闲获取成功、同进程重复获取 = 同一实例放行（vi.resetModules 模块重载
 * 形态，与跨进程他实例拒绝的语义分界 = 持有 pid 是否自身）、释放幂等、释放后再获取
 * 放行。跨进程锁底座行为（stale 接管 / EPERM 存活 / DELETE_PENDING 重试）由
 * fs/cross-process-lock 既有测试覆盖，本件不重复。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { acquireAppInstanceGuard, releaseAllGuards, APP_INSTANCE_LOCK_FILE } from '../../src/desktop/app-instance-guard.js'

let dir: string | null = null
const multiDirs: string[] = []
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = null
  }
  for (const d of multiDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('R0913-win P3-13：app-instance-guard', () => {
  it('空闲 userData 上获取成功（持锁），释放幂等且锁文件随释放消失', () => {
    dir = mkdtempTracked(join(tmpdir(), 'r0913-guard-'))
    const g = acquireAppInstanceGuard(dir)
    expect(g.acquired).toBe(true)
    expect(existsSync(join(dir, APP_INSTANCE_LOCK_FILE))).toBe(true)
    g.release()
    g.release() // 幂等
    expect(existsSync(join(dir, APP_INSTANCE_LOCK_FILE))).toBe(false)
  })

  it('同进程重复获取 = 同一实例放行（持有 pid 为自身；模块重载形态），release no-op 不自删锁面', () => {
    dir = mkdtempTracked(join(tmpdir(), 'r0913-guard-'))
    const first = acquireAppInstanceGuard(dir)
    expect(first.acquired).toBe(true)
    const second = acquireAppInstanceGuard(dir)
    expect(second.acquired).toBe(true)
    expect(existsSync(join(dir, APP_INSTANCE_LOCK_FILE))).toBe(true)
    second.release() // 同实例 no-op：不得释放真持有者的锁面
    expect(existsSync(join(dir, APP_INSTANCE_LOCK_FILE))).toBe(true)
    first.release()
    expect(existsSync(join(dir, APP_INSTANCE_LOCK_FILE))).toBe(false)
  })

  it('释放后再次获取放行（重启场景：上一实例已退）', () => {
    dir = mkdtempTracked(join(tmpdir(), 'r0913-guard-'))
    const first = acquireAppInstanceGuard(dir)
    expect(first.acquired).toBe(true)
    first.release()
    const third = acquireAppInstanceGuard(dir)
    expect(third.acquired).toBe(true)
    third.release()
  })

  // 多库多窗 §六 残余项修复：异库双守卫共存（main 的「key 与实际库不一致」补挂形态）——
  // 两道锁在各自目录并存；releaseAllGuards（进程退出钩子的同一出口）须逐条释放。
  // 回退即红：单槽存储（activeRelease 覆盖式）下后持锁覆盖先持锁，本用例 A 的锁面
  // 留在盘上不消失。
  it('多库多窗补挂：异目录双守卫并存，releaseAllGuards 逐条释放', () => {
    const dirA = mkdtempTracked(join(tmpdir(), 'r0913-multi-a-'))
    const dirB = mkdtempTracked(join(tmpdir(), 'r0913-multi-b-'))
    multiDirs.push(dirA, dirB)
    const gA = acquireAppInstanceGuard(dirA)
    const gB = acquireAppInstanceGuard(dirB)
    expect(gA.acquired).toBe(true)
    expect(gB.acquired).toBe(true)
    expect(existsSync(join(dirA, APP_INSTANCE_LOCK_FILE))).toBe(true)
    expect(existsSync(join(dirB, APP_INSTANCE_LOCK_FILE))).toBe(true)
    // 单独释放其一不动另一
    gA.release()
    expect(existsSync(join(dirA, APP_INSTANCE_LOCK_FILE))).toBe(false)
    expect(existsSync(join(dirB, APP_INSTANCE_LOCK_FILE))).toBe(true)
    // 退出钩子出口：逐条释放（先再取一道 A，验证多道同清）
    const gA2 = acquireAppInstanceGuard(dirA)
    expect(gA2.acquired).toBe(true)
    releaseAllGuards()
    expect(existsSync(join(dirA, APP_INSTANCE_LOCK_FILE))).toBe(false)
    expect(existsSync(join(dirB, APP_INSTANCE_LOCK_FILE))).toBe(false)
  })
})
