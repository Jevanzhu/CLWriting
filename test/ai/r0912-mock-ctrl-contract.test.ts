/**
 * R0912-3（2026-09-11 修复批）回归：mock 快路 TaskOk.ctrl 与外部 register 契约对齐。
 *
 * 背景：runTask 两条 mock 快路（mockTool / mockText）此前恒返回新建 AbortController，
 * 与真实路径契约（ee-P1-2：TaskOk.ctrl 对外是外部 ctrl = opts.ctrl ?? 新建）脱钩——
 * 调用方传了编排级 ctrl 时，mock 回合拿到的 ctrl 不是同一把。mock 语义下无行为差，
 * 纯契约一致。
 */
import { test, expect } from 'vitest'
import { runTask } from '../../src/ai/runner.js'
import { tempUserData } from '../studio/fixtures.js'

test('R0912-3: mockTool 快路 ctrl 返回 opts.ctrl（外部同一把）', async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const external = new AbortController()
    const out = await runTask<{ input: unknown }>({
      userDataPath: tempUserData(),
      mockTool: 'submit_text',
      ctrl: external,
      run: () => Promise.resolve({ input: null }),
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.ctrl).toBe(external)
  } finally {
    delete process.env['CLWRITING_DRIVER']
  }
})

test('R0912-3: mockText 快路 ctrl 同契约（opts.ctrl 优先）', async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const external = new AbortController()
    const out = await runTask<string>({
      userDataPath: tempUserData(),
      mockText: '## mock 细纲',
      ctrl: external,
      run: () => Promise.resolve('never'),
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.data).toBe('## mock 细纲')
      expect(out.ctrl).toBe(external)
    }
  } finally {
    delete process.env['CLWRITING_DRIVER']
  }
})

test('R0912-3: 未传 ctrl → mock 快路照旧新建（不回 undefined，契约与真实路径缺省臂一致）', async () => {
  process.env['CLWRITING_DRIVER'] = 'mock'
  try {
    const out = await runTask<{ input: unknown }>({
      userDataPath: tempUserData(),
      mockTool: 'submit_text',
      run: () => Promise.resolve({ input: null }),
    })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.ctrl).toBeInstanceOf(AbortController)
  } finally {
    delete process.env['CLWRITING_DRIVER']
  }
})
