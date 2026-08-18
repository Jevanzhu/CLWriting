/**
 * provider-format 纯函数单测（阶段 14 第二步 P6/P9 前端校验与格式化）。
 * parseCapacity/formatCapacity 往返、validateModels（唯一 id + 容量拼写）、
 * apiKeyFailure（必填/控制字符/请求头误贴/引号剥离）、dto↔draft 互转。
 */
import { describe, expect, it } from 'vitest'
import {
  parseCapacity,
  formatCapacity,
  validateModels,
  apiKeyFailure,
  modelDraftToDto,
  dtoToModelDrafts,
} from '../../../src/studio/web-next/src/shared/provider-format'

describe('parseCapacity（K/M 后缀解析）', () => {
  it('裸数字 / K / M 后缀 → 对应 token 数', () => {
    expect(parseCapacity('128000')).toBe(128000)
    expect(parseCapacity('128K')).toBe(128 * 1024)
    expect(parseCapacity('128k')).toBe(128 * 1024)
    expect(parseCapacity('1M')).toBe(1024 * 1024)
    expect(parseCapacity('1.5M')).toBe(1.5 * 1024 * 1024)
    expect(parseCapacity(' 128K ')).toBe(128 * 1024)
  })
  it('空 / 0 → undefined（= 继承默认）；非法拼写 → null', () => {
    expect(parseCapacity('')).toBeUndefined()
    expect(parseCapacity('0')).toBeUndefined()
    expect(parseCapacity('abc')).toBeNull()
    expect(parseCapacity('12KB')).toBeNull()
    expect(parseCapacity('-5')).toBeNull()
  })
})

describe('formatCapacity（token 数 → 展示串，与 parse 往返闭合）', () => {
  it('整 M / 整 K 精简；不可整除 K 的保持整数', () => {
    expect(formatCapacity(1024 * 1024)).toBe('1M')
    expect(formatCapacity(128 * 1024)).toBe('128K')
    expect(formatCapacity(128000)).toBe('125K') // 128000 恰为 125*1024
    expect(formatCapacity(123457)).toBe('123457') // 不整除 → 原数
  })
  it('parse(format(x)) === x（可整除 K/M 的取值往返无损）', () => {
    for (const x of [1024 * 1024, 128 * 1024, 64 * 1024]) {
      expect(parseCapacity(formatCapacity(x))).toBe(x)
    }
  })
})

describe('validateModels（模型行校验）', () => {
  it('合法行（含可选 name / 容量）→ null', () => {
    expect(
      validateModels([
        { id: 'gpt-5', name: 'GPT-5', contextWindowText: '400K', maxTokensText: '128K' },
        { id: 'kimi-k2', contextWindowText: '', maxTokensText: '' },
      ]),
    ).toBeNull()
  })
  it('id 空 / 重复 → 指到具体行与字段', () => {
    const dup = validateModels([
      { id: 'a', contextWindowText: '', maxTokensText: '' },
      { id: 'a', contextWindowText: '', maxTokensText: '' },
    ])
    expect(dup).toMatchObject({ index: 1, field: 'id' })
    const blank = validateModels([{ id: '  ', contextWindowText: '', maxTokensText: '' }])
    expect(blank).toMatchObject({ index: 0, field: 'id' })
  })
  it('容量拼写非法 → null 解析定位到该字段', () => {
    const r = validateModels([{ id: 'm', contextWindowText: '12KB', maxTokensText: '' }])
    expect(r).toMatchObject({ index: 0, field: 'contextWindow' })
    const r2 = validateModels([{ id: 'm', contextWindowText: '', maxTokensText: 'big' }])
    expect(r2).toMatchObject({ index: 0, field: 'maxTokens' })
  })
  it('空行数组 → null（不配模型行合法）', () => {
    expect(validateModels([])).toBeNull()
  })
})

describe('apiKeyFailure（P6 Key 前端校验）', () => {
  it('正常 key → null；新增空 → 必填提示', () => {
    expect(apiKeyFailure('sk-abc123')).toBeNull()
    expect(apiKeyFailure('')).toBe('API Key 必填')
    expect(apiKeyFailure('   ')).toBe('API Key 必填')
  })
  it('控制字符 → 提示', () => {
    expect(apiKeyFailure('sk-abc\u0000def')).toContain('控制字符')
  })
  it('误贴请求头（KEY=VALUE 形）→ 引导只填值', () => {
    expect(apiKeyFailure('Authorization=Bearer sk-abc')).toContain('请求头')
    expect(apiKeyFailure('OPENAI_API_KEY=sk-abc')).toContain('请求头')
  })
  it('成对引号先剥离再判（复制带引号不算非法）', () => {
    expect(apiKeyFailure('"sk-abc123"')).toBeNull()
  })
})

describe('dto ↔ 草稿互转（P9 回填/提交）', () => {
  it('modelDraftToDto：空文本容量不落键；合法容量转 token 数', () => {
    const dto = modelDraftToDto([
      { id: 'a', name: 'A', contextWindowText: '128K', maxTokensText: '' },
      { id: 'b', contextWindowText: '', maxTokensText: '4K' },
    ])
    expect(dto[0]).toMatchObject({ id: 'a', name: 'A', contextWindow: 128 * 1024 })
    expect('maxTokens' in (dto[0] as object)).toBe(false)
    expect(dto[1]).toMatchObject({ id: 'b', maxTokens: 4 * 1024 })
  })
  it('dtoToModelDrafts ↔ modelDraftToDto 往返（已填字段无损）', () => {
    const src = [
      { id: 'a', name: 'A', contextWindow: 128 * 1024, maxTokens: 4096 },
      { id: 'b' },
    ]
    const back = modelDraftToDto(dtoToModelDrafts(src))
    expect(back).toEqual(src)
  })
})