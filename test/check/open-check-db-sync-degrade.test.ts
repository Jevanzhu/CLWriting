/**
 * 阶段 52 附批（coverage 修账）：同步前奏 openCheckDb 的「硬异常降级」契约直测。
 *
 * 背景：域级阈值门（`src/check/**` functions ≥98，0918 独立重评修复批 G001 立桶）在 CI
 * 抓到该闭包零覆盖——97.97% 对 98%：阶段 52 把机检链调用点切 async 后，同步侧 fail-open
 * 只剩树聚合 sync 驱动可达（run-tree-issues.ts 的 openCheckDb），而既测的「index.db 损坏」
 * 用例走的是 rebuild **报错列表**分支（直接 return，不经 failOpen），故闭包从未被执行。
 *
 * 本套直测两档失败面（注入手法 = mock rebuild 抛硬异常，同 run-check-error-warn.test.ts
 * 的缝内注入先例；openCheckDb 的降级判定与 rebuild 内核无关，桩掉不弱化断言面）：
 * ① fail-open 档（树聚合口径）→ { db: null, rebuildFailed: true } + warn 留痕（只算 verdict，
 *    树红点不因缓存库不可用穿透成 500）；
 * ② envelope 档（单章链口径）→ fail 信封带人话，且不落 warn（信封即留痕面）。
 */
import { test, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../src/cache/rebuild.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/cache/rebuild.js')>()
  return {
    ...actual,
    rebuild: () => {
      throw new Error('boom: 注入的重建硬异常')
    },
  }
})

import { openCheckDb } from '../../src/check/run.js'
import { log } from '../../src/log/index.js'
import { mkdtempTracked } from '../helpers/temp-dir.js'

test('阶段 52 附批: rebuild 抛硬异常 + fail-open 档 → 降级只算 verdict 且 warn 留痕', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'clwriting-opendb-degrade-'))
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const opened = openCheckDb(bookRoot, true, { throttleSourceProbe: false, failMode: 'fail-open' })
    expect(opened.db).toBeNull()
    expect(opened.rebuildFailed).toBe(true)
    expect(opened.fail).toBeUndefined()
    const warned = warnSpy.mock.calls.map((c) => `${String(c[0])} ${String(c[1] ?? '')}`).join('\n')
    expect(warned).toContain('check')
    expect(warned).toContain('树红点聚合降级')
    expect(warned).toContain('boom')
  } finally {
    warnSpy.mockRestore()
  }
})

test('阶段 52 附批: rebuild 抛硬异常 + envelope 档 → fail 信封（不落 warn）', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'clwriting-opendb-envelope-'))
  const warnSpy = vi.spyOn(log, 'warn')
  try {
    const opened = openCheckDb(bookRoot, true, { throttleSourceProbe: false, failMode: 'envelope' })
    expect(opened.db).toBeNull()
    expect(opened.rebuildFailed).toBe(false)
    expect(opened.fail?.error).toContain('缓存库不可用')
    expect(warnSpy).not.toHaveBeenCalled()
  } finally {
    warnSpy.mockRestore()
  }
})

test('阶段 52 附批: 无布线短篇不重建（硬异常不触达——降级面与短篇面互不干扰）', () => {
  const bookRoot = mkdtempTracked(join(tmpdir(), 'clwriting-opendb-nowiring-'))
  const opened = openCheckDb(bookRoot, false, { throttleSourceProbe: false, failMode: 'fail-open' })
  expect(opened).toEqual({ db: null, rebuildFailed: false })
})
