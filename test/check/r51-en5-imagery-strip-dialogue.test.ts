/**
 * R51-E-N5（五十一轮）回归：意象检查计数前剥对白引号 span。
 *
 * 禁词（checkBannedWords R29-1①）/开头检查同文件均剥对白，唯 checkImagery 吃原文
 * ——意象词多为叙述套语，对白里角色说出「气氛」「空气」属人物语言非作者叙述套路，
 * 对白密集章逐句累加黄项刷屏。修复：stripQuotedSpans 单源对齐（quotes.ts）。
 */
import { describe, it, expect } from 'vitest'
import { checkImagery } from '../../src/check/count.js'

const WORDS = ['空气', '气氛']

describe('R51-E-N5: checkImagery 剥对白', () => {
  it('对白内命中不计入叙述计数（对白密集章不刷屏）', () => {
    // 全部「空气」都在引号内（角色嘴里的话）：剥对白后叙述 0 次 → 不产黄项
    const body = [
      '「这空气真闷。」他说。',
      '「你闻到空气里的味道了吗？」她问。',
      '「空气突然安静下来。」',
      '「别管空气了。」',
    ].join('\n')
    const r = checkImagery(body, WORDS, 3)
    expect(r.items).toEqual([])
  })

  it('叙述内命中照常累计（修复不弱化检测面）', () => {
    // 叙述 4 次「空气」> 阈 3 → 照报；引号内 2 次不计
    const body = [
      '空气仿佛凝固了。',
      '他推开窗，空气里有尘土味。',
      '山谷的空气冷得像刀。',
      '空气沉默。',
      '「这空气真闷。」他说。',
      '「空气突然安静。」',
    ].join('\n')
    const r = checkImagery(body, WORDS, 3)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ checkId: 'imagery-overuse', level: 'yellow' })
    expect(r.items[0]!.message).toContain('4 次')
  })

  it('纯叙述低频不报（口径不扩大）', () => {
    const r = checkImagery('空气清新。气氛微妙。', WORDS, 3)
    expect(r.items).toEqual([])
  })
})
