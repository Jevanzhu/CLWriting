/**
 * R55-C-2（五十五轮）回归：calibrate-tokens 采样过滤谓词——剔除 task==='chat' 样本。
 *
 * 修复前：脚本全量采样 `WHERE type='llm/call'` 无 task 过滤，而 chat 轮 promptMeta.chars
 * 自 Q-11 起只记当轮末条消息（turns.ts lastMessageFingerprint），多轮 chat 真实输入含
 * system prompt + 整段历史 → chars 低估数个量级 → TOKEN_COEFFICIENTS 拟合 coeff 虚高。
 *
 * 过滤字段实查口径：runner.ts trace 在无 task 时不落 llm/call（事件 data.task 恒存在，
 * 取值 'chat'/'self-heal'/'spawn-write'/'rewrite'/...）；多轮任务中唯 chat 的 chars 是
 * 末条指纹口径（spec/finish 等任务 promptText 传全量 prompt），按 task==='chat' 精准
 * 剔除、不做历史事件迁移（缺 task 的老事件按其余字段判，不过滤）。
 */
import { describe, expect, it } from 'vitest'
import { isCalibratableCallRow } from '../../src/ai/token-calibration.js'

const wellFormed = {
  task: 'self-heal',
  model: 'fake-model',
  usage: { input: 1200, cacheRead: 0, cacheWrite: 0 },
  promptMeta: { chars: 1100 },
}

describe('R55-C-2: isCalibratableCallRow 过滤谓词', () => {
  it('task==="chat" 样本被剔除（chars 只记当轮末条消息，拟合失真源）', () => {
    expect(isCalibratableCallRow({ ...wellFormed, task: 'chat' })).toBe(false)
  })

  it('其他多轮/单轮任务样本保留（chars 为全量 prompt 口径）', () => {
    expect(isCalibratableCallRow(wellFormed)).toBe(true)
    expect(isCalibratableCallRow({ ...wellFormed, task: 'spec' })).toBe(true)
    expect(isCalibratableCallRow({ ...wellFormed, task: 'spawn-write' })).toBe(true)
    expect(isCalibratableCallRow({ ...wellFormed, task: 'rewrite' })).toBe(true)
  })

  it('历史事件缺 task 字段 → 按其余字段判定（不迁移历史事件，不过滤）', () => {
    expect(
      isCalibratableCallRow({ model: wellFormed.model, usage: wellFormed.usage, promptMeta: wellFormed.promptMeta }),
    ).toBe(true)
  })

  it('记账残缺行剔除（缺 model / usage.input / promptMeta.chars 任一）', () => {
    expect(isCalibratableCallRow({ ...wellFormed, model: undefined })).toBe(false)
    expect(isCalibratableCallRow({ ...wellFormed, usage: undefined })).toBe(false)
    expect(isCalibratableCallRow({ ...wellFormed, usage: { input: 0 } })).toBe(false)
    expect(isCalibratableCallRow({ ...wellFormed, promptMeta: undefined })).toBe(false)
    expect(isCalibratableCallRow({ ...wellFormed, promptMeta: { chars: 0 } })).toBe(false)
  })
})
