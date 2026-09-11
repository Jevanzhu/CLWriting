/**
 * R0912-1（2026-09-11 修复批）回归：checkBodyParts / checkSimile 计数前剥对白引号 span。
 *
 * 同文件禁词（R29-1①）/意象（R51-E-N5）/开头环境（R29-4）均经 stripQuotedSpans
 * （quotes.ts 单源），唯身体部位与比喻两项吃原文——对白里角色说「我的眼睛…」
 * 「像…一样」被计入叙述密度刷屏；两项同属短篇 strict 升红族（runner 短篇机检 4 项），
 * 对白密集章误报驱动打回重写白烧真调用。修复：stripQuotedSpans 对齐家族约定。
 *
 * 每组样本附「改前口径自证」断言：对原文裸计数确超阈（修复前必报黄），修复后对白
 * 剥除不再报——防回归时样本悄悄退化成「怎么改都不报」的无效断言。
 */
import { describe, it, expect } from 'vitest'
import { checkBodyParts, checkSimile, SIMILE_RE } from '../../src/check/count.js'

describe('R0912-1: checkBodyParts 剥对白', () => {
  it('对白内「眼睛」不计入叙述密度（对白密集章不刷屏）', () => {
    const body = [
      '「我的眼睛好干。」她说。',
      '「你的眼睛真亮。」他答。',
      '「我的眼睛进沙子了。」',
      '「别揉眼睛。」',
      '「你的眼睛红了。」',
      '「我的眼睛没事。」',
    ].join('\n')
    // 改前口径自证：原文裸计数 6 次「眼睛」> 阈 5（修复前必报黄）
    expect((body.match(/眼睛/g) ?? []).length).toBeGreaterThan(5)
    // 改后：剥对白 → 叙述面 0 次 → 不报
    expect(checkBodyParts(body).items).toEqual([])
  })

  it('对白内肢体动作「伸手」不计入手部动作语境计数', () => {
    const body = [
      '「别伸手。」',
      '「他伸手过来了。」',
      '「我伸手去接。」',
      '「谁伸手拉的？」',
      '「你伸手摸摸看。」',
      '「又伸手要钱。」',
    ].join('\n')
    // 改前口径自证：HAND_ACTION_RE 对原文裸匹配 6 处 > 阈 5（修复前必报 手×6）
    expect((body.match(/伸手/g) ?? []).length).toBeGreaterThan(5)
    expect(checkBodyParts(body).items).toEqual([])
  })

  it('叙述行真实堆砌仍报，且对白不计入次数（防矫枉过正）', () => {
    const body = [
      '她的眼睛像秋水。', // ── 叙述 7 次「眼睛」
      '他的眼睛布满血丝。',
      '孩子的眼睛睁得很大。',
      '老人的眼睛浑浊了。',
      '她的眼睛低垂着。',
      '他的眼睛闪过一丝惊讶。',
      '那双眼睛在暗里发亮。',
      '「你的眼睛真亮。」他说。', // ── 对白 2 次不计
      '「我的眼睛没事。」',
    ].join('\n')
    // 改前口径自证：裸计数 9 次（叙述 7 + 对白 2）> 阈 6（修复前必报 眼睛×9）
    expect((body.match(/眼睛/g) ?? []).length).toBe(9)
    // 改后：对白剥除 → 只计叙述 7 次 > 6 照报，次数不含对白
    const r = checkBodyParts(body, 6)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ checkId: 'body-parts', level: 'yellow' })
    expect(r.items[0]!.message).toContain('眼睛×7')
    expect(r.items[0]!.message).not.toContain('×9')
  })
})

describe('R0912-1: checkSimile 剥对白', () => {
  it('对白内「像…一样」不计入叙述比喻密度', () => {
    const body = [
      '「这雪像盐一样撒下来。」她说。',
      '「你的手像冰一样凉。」',
      '「他跑起来像风一样快。」',
      '「那云像山一样堆着。」',
      '「这夜像墨一样黑。」',
      '「雷声像鼓一样响。」',
      '「灯火像星一样远。」',
      '「雾像纱一样罩着。」',
      '「河水像镜一样平。」',
      '「心像钟一样沉着。」',
      '「话像刀一样扎人。」',
    ].join('\n')
    // 改前口径自证：SIMILE_RE 对原文裸匹配 11 处 > 阈 10（修复前必报黄）
    expect((body.match(SIMILE_RE) ?? []).length).toBeGreaterThan(10)
    // 改后：剥对白 → 叙述面 0 处 → 不报
    expect(checkSimile(body, 10).items).toEqual([])
  })

  it('叙述行真实明喻仍报，且对白不计入次数（防矫枉过正）', () => {
    const body = [
      '月光像水一样漫过窗台。', // ── 叙述 11 处明喻
      '她的声音清脆得像铃。',
      '他的手像枯枝一样僵硬。',
      '夜色像墨一样浓。',
      '心跳像鼓一样擂响。',
      '回忆像潮水一样涌来。',
      '灯焰像豆一样摇。',
      '谎言像雪一样白。',
      '队伍像蛇一样蜿蜒。',
      '汗珠像雨一样落。',
      '记忆像锈一样咬住他。',
      '「日子像流水一样过去了。」他说。', // ── 对白 3 处不计
      '「他的话像刀一样扎人。」',
      '「那云像山一样堆着。」',
    ].join('\n')
    // 改前口径自证：裸匹配 14 处（叙述 11 + 对白 3）> 阈 10（修复前必报 14 次）
    expect((body.match(SIMILE_RE) ?? []).length).toBe(14)
    // 改后：对白剥除 → 只计叙述 11 处 > 10 照报，次数不含对白
    const r = checkSimile(body, 10)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({ checkId: 'simile-density', level: 'yellow' })
    expect(r.items[0]!.message).toContain('11 次')
    expect(r.items[0]!.message).not.toContain('14 次')
  })
})
