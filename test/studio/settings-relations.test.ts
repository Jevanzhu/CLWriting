import { describe, it, expect } from 'vitest'
import { parseRelations, normalizeRelationType } from '../../src/studio/server/api/settings.js'

describe('角色关系解析 parseRelations（#7.5）', () => {
  it('解析多条「名字(类型)」', () => {
    expect(parseRelations('林远(师徒);赵衡(仇敌)')).toEqual([
      { to: '林远', type: '师徒' },
      { to: '赵衡', type: '仇敌' },
    ])
  })
  it('中文分号也支持', () => {
    expect(parseRelations('林远(师徒)；赵衡(仇敌)')).toHaveLength(2)
  })
  it('中文括号也支持', () => {
    expect(parseRelations('林远（师徒）；赵衡（仇敌）')).toEqual([
      { to: '林远', type: '师徒' },
      { to: '赵衡', type: '仇敌' },
    ])
  })
  it('逗号分隔多条', () => {
    expect(parseRelations('玄苦(师), 苏婉(旧约), 萧琢(敌)')).toEqual([
      { to: '玄苦', type: '师' },
      { to: '苏婉', type: '旧约' },
      { to: '萧琢', type: '敌' },
    ])
  })
  it('中文逗号也支持', () => {
    expect(parseRelations('玄苦（师），苏婉（旧约）')).toHaveLength(2)
  })
  it('空字符串返回空数组', () => {
    expect(parseRelations('')).toEqual([])
  })
  it('无括号的项跳过', () => {
    expect(parseRelations('林远;无效')).toEqual([])
  })
  it('等号格式（新格式）也支持', () => {
    expect(parseRelations('玄苦=师徒; 苏婉=旧时婚约; 萧琢=仇敌')).toEqual([
      { to: '玄苦', type: '师徒' },
      { to: '苏婉', type: '旧时婚约' },
      { to: '萧琢', type: '仇敌' },
    ])
  })
})

describe('关系类型规范化 normalizeRelationType', () => {
  it('简写映射到标准短语', () => {
    expect(normalizeRelationType('师')).toBe('师徒')
    expect(normalizeRelationType('敌')).toBe('仇敌')
    expect(normalizeRelationType('兄弟')).toBe('手足')
    expect(normalizeRelationType('旧约婚约')).toBe('夫妻')
  })
  it('已是标准词保持不变', () => {
    expect(normalizeRelationType('仇敌')).toBe('仇敌')
    expect(normalizeRelationType('师徒')).toBe('师徒')
    expect(normalizeRelationType('同僚')).toBe('同僚')
  })
  it('无匹配保留原文（自定义关系）', () => {
    expect(normalizeRelationType('暗棋')).toBe('暗棋')
    expect(normalizeRelationType('血契')).toBe('血契')
  })
  it('别名也归一', () => {
    expect(normalizeRelationType('师父')).toBe('师徒')
    expect(normalizeRelationType('未婚妻')).toBe('夫妻')
    expect(normalizeRelationType('宿敌')).toBe('仇敌')
    expect(normalizeRelationType('挚友')).toBe('挚友')
  })
})
