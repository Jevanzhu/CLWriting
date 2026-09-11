/**
 * R0912（重评-0911c P3）：log 双词表对账测试——maskKeys（形貌保留，对账面）与
 * redactSecret（全掩，泄漏收敛面）各持一套正则，此前无「同形必同命中」的门，
 * 词表漂移零防线。本测试锁三件事：
 *   1. 重叠域（≥16 位裸 key 及智谱/Gemini 形态）：两函数都必须检出（命中即变更）；
 *   2. 良性文本（含 sk- 同形路径/普通词）：双方都必须零误伤（R0912 词首断言修复面）；
 *   3. 有意分账：maskKeys {8,} 比 redactSecret {16,} 更严（8–15 位短 key 仅前者掩），
 *      该差异是文档化的过掩方向，测试钉住防未来「对齐」时静默放宽。
 */
import { describe, it, expect } from 'vitest'
import { maskKeys } from '../../src/log/index.js'
import { redactSecret } from '../../src/log/redact.js'

/** 重叠域凭据样本：≥16 位裸 key + 无前缀特征的智谱/Gemini 形态 */
const CREDENTIAL_SAMPLES: string[] = [
  'sk-ant-api03-AAAA0123456789abcdefghij',
  'xai-AAAAAAAA0123456789abcdef',
  'sk_AAAAAAAA0123456789abcdef',
  'gsk_AAAAAAAA0123456789abcdef',
  'hf_AAAAAAAA0123456789abcdef',
  'glpat-AAAAAAAA0123456789abcdef',
  'ghp_AAAAAAAA0123456789abcdef',
  `${'0123456789abcdef'.repeat(2)}.${'0123456789abcdef'.repeat(2)}`, // 智谱 32.32 hex
  `AIza${'x'.repeat(35)}`, // Gemini AIza+35
]

/** 良性文本：含 sk- 同形前缀的路径/普通词（R0912 词首断言的修复对象） */
const BENIGN_SAMPLES: string[] = [
  'task-sk-20230801.md 处理完成',
  'mask-sensitive-data 并非 key',
  '回顾 mask-sk_context 的历史命名',
]

describe('R0912：log 双词表对账（maskKeys × redactSecret）', () => {
  it('重叠域凭据：两函数都必须检出（命中即变更文本）', () => {
    for (const s of CREDENTIAL_SAMPLES) {
      expect(maskKeys(s), `maskKeys 漏掩：${s}`).not.toBe(s)
      expect(redactSecret(s), `redactSecret 漏掩：${s}`).not.toBe(s)
    }
  })

  it('良性 sk- 同形文本：双方都必须零误伤', () => {
    for (const s of BENIGN_SAMPLES) {
      expect(maskKeys(s), `maskKeys 误伤：${s}`).toBe(s)
      expect(redactSecret(s), `redactSecret 误伤：${s}`).toBe(s)
    }
  })

  it('有意分账：8–15 位短 key 仅 maskKeys 掩（{8,} vs {16,}，过掩方向钉死）', () => {
    const shortKey = 'sk-12345678'
    expect(maskKeys(shortKey)).not.toBe(shortKey)
    expect(redactSecret(shortKey)).toBe(shortKey)
  })
})
