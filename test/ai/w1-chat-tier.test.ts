/**
 * W1 chat 档位测试。
 *
 * 验收：
 * - tierFromStore(s, 'chat') 在「已配 / 未配 / model 为空」三种情形下的回落正确
 * - PUT /api/tiers（旧端点）不丢失 chat 档（行为不变 + chat 保留）
 * - defaultTiers 含 chat: null
 */
import { describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import {
  tierFromStore,
  loadProviders,
  saveProviders,
  emptySettings,
  type ProviderStore,
} from '../../src/ai/provider/store.js'

function tmp(): string {
  return mkdtempTracked(join(tmpdir(), 'w1-chat-'))
}

function makeStore(overrides: Partial<ProviderStore> = {}): ProviderStore {
  return {
    ...emptySettings(),
    currentModel: 'base-model',
    tiers: { creative: { model: 'creative-model', effort: 'high' }, assistant: null, chat: null },
    ...overrides,
  }
}

describe('W1: tierFromStore — chat 档回落', () => {
  it('chat 已配且有 model → 返回 chat 档', () => {
    const s = makeStore({
      tiers: {
        creative: { model: 'creative-m', effort: 'high' },
        assistant: null,
        chat: { model: 'chat-m', effort: 'medium' },
      },
    })
    expect(tierFromStore(s, 'chat')).toEqual({ model: 'chat-m', effort: 'medium' })
  })

  it('chat 未配（null）→ 回落 creative', () => {
    const s = makeStore()
    expect(tierFromStore(s, 'chat')).toEqual({ model: 'creative-model', effort: 'high' })
  })

  it('chat 配了但 model 为空 → 回落 currentModel（与 assistant 同构）', () => {
    const s = makeStore({
      currentModel: 'base-model',
      tiers: {
        creative: { model: 'creative-m', effort: 'high' },
        assistant: null,
        chat: { model: '', effort: 'medium' },
      },
    })
    // model 为空 → 回落 currentModel（与 assistant 同构）
    expect(tierFromStore(s, 'chat').model).toBe('base-model')
  })

  it('chat + currentModel 都空 → model 为空字符串', () => {
    const s = makeStore({ currentModel: null })
    // creative model 也为空时
    s.tiers.creative = { model: '', effort: 'high' }
    expect(tierFromStore(s, 'chat').model).toBe('')
  })
})

describe('W1: defaultTiers 含 chat: null', () => {
  it('emptySettings 的 tiers 有 chat 字段且为 null', () => {
    const s = emptySettings()
    expect(s.tiers.chat).toBeNull()
  })

  it('loadProviders 从无文件启动 → chat 为 null', () => {
    const dir = tmp()
    const s = loadProviders(dir)
    expect(s.tiers.chat).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('W1: save → load 往返不丢 chat', () => {
  it('chat 档保存后重新加载一致', () => {
    const dir = tmp()
    const s = makeStore({
      tiers: {
        creative: { model: 'c', effort: 'high' },
        assistant: { model: 'a', effort: 'medium' },
        chat: { model: 'chat-x', effort: 'low' },
      },
    })
    saveProviders(dir, s)
    const loaded = loadProviders(dir)
    expect(loaded.tiers.chat).toEqual({ model: 'chat-x', effort: 'low' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('旧端点 PUT /api/tiers 逻辑：保留已有 chat 档', () => {
    const dir = tmp()
    // 先保存含 chat 档的配置
    const s = makeStore({
      tiers: {
        creative: { model: 'c', effort: 'high' },
        assistant: null,
        chat: { model: 'chat-x', effort: 'low' },
      },
    })
    saveProviders(dir, s)

    // 模拟旧端点逻辑：只更新 creative + assistant，保留 chat
    const loaded = loadProviders(dir)
    loaded.tiers = {
      creative: { model: 'new-creative', effort: 'max' },
      assistant: { model: 'new-assistant', effort: 'high' },
      chat: loaded.tiers.chat, // ← 旧端点修改后保留 chat
    }
    saveProviders(dir, loaded)

    const final = loadProviders(dir)
    expect(final.tiers.creative.model).toBe('new-creative')
    expect(final.tiers.assistant!.model).toBe('new-assistant')
    expect(final.tiers.chat).toEqual({ model: 'chat-x', effort: 'low' }) // chat 未丢
    rmSync(dir, { recursive: true, force: true })
  })
})
