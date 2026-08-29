/**
 * R74-3（二十二轮）：orchestrationBusyFor 补 spawn 面回归。
 *
 * 此前本闸只查 self-heal/对话/后台收尾，手动写稿（isSpawnRunning，分钟级）在途时
 * outline/analysis/onboard/lead-updates 等生成端点照常放行——覆盖写与写稿并发、
 * 后续章拿到混合态上下文（正是 R67-13 要防的场景；rewrite.ts R70-3 注释自认全库
 * 唯该面单独补查）。__setSpawnRunning 是既有互斥类测试的确定性夹具
 * （orchestrator-mutex-gates.test.ts 同款）。
 */
import { test, expect } from 'vitest'
import { orchestrationBusyFor } from '../../src/studio/server/api/task-gate.js'
import { __setSpawnRunning } from '../../src/ai/orchestrate/spawn-registry.js'

test('R74-3: spawn 在途 → orchestrationBusyFor 返回手动写稿 BUSY 文案（生成端点入口将 409）', () => {
  __setSpawnRunning('R74互斥书', true)
  try {
    const busy = orchestrationBusyFor('R74互斥书')
    expect(busy).not.toBeNull()
    expect(busy).toContain('手动写稿')
    expect(busy).toContain('等它完成后再生成') // 措辞对齐周边三条 return 口径
  } finally {
    __setSpawnRunning('R74互斥书', false)
  }
})

test('R74-3: 全部编排空闲 → null（闸不误伤正常生成入口）', () => {
  expect(orchestrationBusyFor('R74空闲书')).toBeNull()
})
