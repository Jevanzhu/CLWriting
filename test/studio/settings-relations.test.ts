import { describe, it, expect } from 'vitest'
import { parseRelations } from '../../src/studio/server/api/settings.js'

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
  it('空字符串返回空数组', () => {
    expect(parseRelations('')).toEqual([])
  })
  it('无括号的项跳过', () => {
    expect(parseRelations('林远;无效')).toEqual([])
  })
})
