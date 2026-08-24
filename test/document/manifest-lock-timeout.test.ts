/**
 * N7（五十九轮）回归：清单锁等待超时 ≥5s，对齐 ai-calls 口径。
 *
 * 2s 时双进程争用高峰可同时超时降级裸写 → 后写者吞先写者的清单更新（X-5 要防的
 * 事故复现）。契约测试：超时档 ≥5s（与 AI_CALLS_LOCK_TIMEOUT_MS / busy_timeout 5000 同源）。
 */
import { describe, it, expect } from 'vitest'
import { MANIFEST_LOCK_TIMEOUT_MS } from '../../src/document/manifest.js'
import { AI_CALLS_LOCK_TIMEOUT_MS } from '../../src/ai/calls.js'

describe('N7 清单锁超时档', () => {
  it('MANIFEST_LOCK_TIMEOUT_MS ≥ 5s 且与 ai-calls 口径对齐', () => {
    expect(MANIFEST_LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000)
    expect(MANIFEST_LOCK_TIMEOUT_MS).toBeGreaterThanOrEqual(AI_CALLS_LOCK_TIMEOUT_MS)
  })
})
