import { test, expect } from 'vitest'
import { matchGenreLeads, sanitizeLeadsEnabled, BASE_LEAD_TYPES, EXTENDED_LEAD_TYPES } from '../../src/install/data.js'

test('BASE_LEAD_TYPES 恒为三类、EXTENDED 四类', () => {
  expect(BASE_LEAD_TYPES).toEqual(['伏笔', '悬念', '感情线'])
  expect(EXTENDED_LEAD_TYPES).toEqual(['局线', '设定线', '成长线', '关系债'])
})

test('matchGenreLeads: 玄幻/仙侠 → 成长线 + 设定线', () => {
  // 结果按 EXTENDED_LEAD_TYPES 顺序（局线/设定线/成长线/关系债）稳定输出
  expect(matchGenreLeads('玄幻')).toEqual(['设定线', '成长线'])
  expect(matchGenreLeads('仙侠修仙')).toEqual(['设定线', '成长线'])
  expect(matchGenreLeads('末世种田')).toEqual(['设定线', '成长线'])
})

test('matchGenreLeads: 悬疑/宫斗 → 局线', () => {
  expect(matchGenreLeads('悬疑推理')).toEqual(['局线'])
  expect(matchGenreLeads('无限流怪谈')).toEqual(['局线'])
  expect(matchGenreLeads('宫斗权谋')).toEqual(['局线'])
})

test('matchGenreLeads: 游戏/竞技 → 成长线', () => {
  expect(matchGenreLeads('游戏竞技')).toEqual(['成长线'])
  expect(matchGenreLeads('电竞体育')).toEqual(['成长线'])
})

test('matchGenreLeads: 言情/宅斗 → 关系债', () => {
  expect(matchGenreLeads('狗血言情')).toEqual(['关系债'])
  expect(matchGenreLeads('宅斗婚恋')).toEqual(['关系债'])
})

test('matchGenreLeads: 多组叠加（玄幻+宫斗混合题材）', () => {
  // 「玄幻宫斗」同时命中成长线+设定线 和 局线 → 按 EXTENDED 顺序
  expect(matchGenreLeads('玄幻宫斗')).toEqual(['局线', '设定线', '成长线'])
})

test('matchGenreLeads: 冷门题材回落空（仅基础三类）', () => {
  expect(matchGenreLeads('都市')).toEqual([])
  expect(matchGenreLeads('都市职场')).toEqual([])
  expect(matchGenreLeads('')).toEqual([])
})

test('matchGenreLeads: 去重（同组重复命中只算一次）', () => {
  // 「修仙玄幻」两个关键词都命中成长线+设定线，不应重复
  const r = matchGenreLeads('修仙玄幻')
  expect(r.filter((x) => x === '成长线')).toHaveLength(1)
  expect(r.filter((x) => x === '设定线')).toHaveLength(1)
})

test('sanitizeLeadsEnabled: 剔除基础类 + 未知类 + 去重', () => {
  expect(sanitizeLeadsEnabled(['成长线', '局线'])).toEqual(['成长线', '局线'])
  // 基础类（伏笔）应被剔除——基础类恒启用不列入 enabled
  expect(sanitizeLeadsEnabled(['伏笔', '成长线'])).toEqual(['成长线'])
  // 未知类剔除
  expect(sanitizeLeadsEnabled(['未知线', '成长线'])).toEqual(['成长线'])
  // 去重
  expect(sanitizeLeadsEnabled(['成长线', '成长线'])).toEqual(['成长线'])
  // 空入空出
  expect(sanitizeLeadsEnabled([])).toEqual([])
})
