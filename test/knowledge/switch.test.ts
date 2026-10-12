/**
 * 知识层注入开关单源（src/knowledge/switch.ts）面表。
 *
 * 此前开关判据两处重写（写稿 draft-pipeline / 三审 review），对话面「不受开关辖」
 * 是代码里的缺席。本件锚定三面口径：chat 恒 true（作者主动问答，语料是其依据来源），
 * draft/review 遵书级 auto.knowledge_injection、缺省开、显式 false 才关；
 * config 缺省（直调/测试路径）不降级。
 */
import { describe, it, expect } from 'vitest'
import { knowledgeInjectionEnabled } from '../../src/knowledge/switch.js'
import type { BookConfig } from '../../src/format/types.js'

/** 造最小配置壳（只关心 auto.knowledge_injection 面） */
function cfg(knowledgeInjection?: boolean): BookConfig {
  return { auto: knowledgeInjection === undefined ? {} : { knowledge_injection: knowledgeInjection } } as BookConfig
}

describe('knowledgeInjectionEnabled：三面口径', () => {
  it('chat 恒 true——书级显式 false 也不辖对话面（作者主动问答，语料是其依据来源）', () => {
    expect(knowledgeInjectionEnabled(undefined, 'chat')).toBe(true)
    expect(knowledgeInjectionEnabled(cfg(), 'chat')).toBe(true)
    expect(knowledgeInjectionEnabled(cfg(true), 'chat')).toBe(true)
    expect(knowledgeInjectionEnabled(cfg(false), 'chat')).toBe(true)
  })

  it.each(['draft', 'review'] as const)('%s：键未设 → 注入（缺省开，存量书零影响）', (face) => {
    expect(knowledgeInjectionEnabled(cfg(), face)).toBe(true)
    expect(knowledgeInjectionEnabled(cfg(undefined), face)).toBe(true)
  })

  it.each(['draft', 'review'] as const)('%s：显式 true → 注入；显式 false → 关停', (face) => {
    expect(knowledgeInjectionEnabled(cfg(true), face)).toBe(true)
    expect(knowledgeInjectionEnabled(cfg(false), face)).toBe(false)
  })

  it.each(['draft', 'review', 'chat'] as const)('%s：config 缺省（直调/测试路径）不降级', (face) => {
    expect(knowledgeInjectionEnabled(undefined, face)).toBe(true)
  })
})
