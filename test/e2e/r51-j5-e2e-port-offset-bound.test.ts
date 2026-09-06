/**
 * R51-J-5（五十一轮）：e2ePort 偏移上界运行时断言回归。
 * MAX_PORT_OFFSET 原先只在 E2E_PORT_BASE 的 env 校验里被引用（注释性守卫）——
 * 调用方传超表偏移会静默派生出与偏移表无关的端口（独立 server 相互抢占、e2e
 * 假红难排查）。修后 fail-fast 抛人话错误指路偏移表；本文件钉住「缺省派生不变
 * + 越界必抛 + 基址平移口径保留」三面。env 依赖模块加载期求值 → 逐用例
 * resetModules 重载读新 env。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

type Ports = typeof import('../../test/e2e/e2e-ports.js')

const prevBase = process.env['CLW_E2E_PORT_BASE']

async function loadPorts(): Promise<Ports> {
  vi.resetModules()
  return await import('../../test/e2e/e2e-ports.js')
}

describe('R51-J-5: e2ePort 偏移上界运行时断言', () => {
  afterAll(() => {
    if (prevBase === undefined) delete process.env['CLW_E2E_PORT_BASE']
    else process.env['CLW_E2E_PORT_BASE'] = prevBase
  })

  it('合法偏移照常派生：缺省基址 18999，偏移表两端（0/16）与历史硬编码逐字节一致', async () => {
    delete process.env['CLW_E2E_PORT_BASE']
    const { E2E_PORT_BASE, e2ePort } = await loadPorts()
    expect(E2E_PORT_BASE).toBe(18999)
    expect(e2ePort(0)).toBe(18999) // global-setup 主 server
    expect(e2ePort(4)).toBe(19003) // usage-card
    expect(e2ePort(16)).toBe(19015) // release-smoke = MAX_PORT_OFFSET 上界恰合法
  })

  it('越界/非法偏移 fail-fast：负数、超表、非整数均抛人话错误并指路偏移表', async () => {
    const { MAX_PORT_OFFSET, e2ePort } = await loadPorts()
    for (const bad of [-1, MAX_PORT_OFFSET + 1, 1.5, Number.NaN]) {
      expect(() => e2ePort(bad)).toThrowError(/e2ePort 偏移越界/)
      try {
        e2ePort(bad)
      } catch (e) {
        const msg = String((e as Error).message)
        expect(msg).toContain(String(MAX_PORT_OFFSET)) // 报出合法上界
        expect(msg).toContain('偏移表') // 指路登记处
      }
    }
  })

  it('基址平移不改偏移间隔；越界 env（≥65520）回落缺省（R33D-35 口径保留）', async () => {
    process.env['CLW_E2E_PORT_BASE'] = '28999'
    const shifted = await loadPorts()
    expect(shifted.E2E_PORT_BASE).toBe(28999)
    expect(shifted.e2ePort(0)).toBe(28999)
    expect(shifted.e2ePort(16)).toBe(29015) // 间隔随基址整体平移

    process.env['CLW_E2E_PORT_BASE'] = '65530'
    const overflow = await loadPorts()
    expect(overflow.E2E_PORT_BASE).toBe(18999) // 越上界回落缺省
  })
})
