/**
 * 机检计数前剥对白引号 span（stripQuotedSpans 家族在消费点的对齐契约）。
 *
 * 档源（6 档并 1，按被测行为合并；断言逐条保留、去重 2 条——r0911b 的「对白外
 * 照常计数」bodyParts/simile 两例与 r0912-quote-strip 同语义例重合，保留带
 * 「改前口径自证」的后者）：
 * - r0911b-quoted-span.test.ts（R0911b-P2④ / R0911b-F-P3-1）
 * - r0912-quote-strip-body-simile.test.ts（R0912-1）
 * - r51-en5-imagery-strip-dialogue.test.ts（R51-E-N5）
 * - r30-quote-crossline.test.ts（R30-1 跨段吞噬收口）
 * - r29-check-machine-correctness.test.ts 的 R29-4 / 重评-0912-4 P2-5 组
 * - r33-check-fixes.test.ts 的 R33-32 组
 *
 * 行为契约：同文件禁词（R29-1①）/意象（R51-E-N5）/开头环境（R29-4）/身体部位/
 * 比喻/对话提示语堆叠均先 stripQuotedSpans（quotes.ts 单源）再匹配——对白里
 * 「眼睛×6」「像…一样」「不耐烦地说」是角色嘴里的话，不是作者叙述堆砌，对白密集
 * 章虚黄，短篇 strict（runner STRICT_SHORT_CHECK_IDS）升红会误打回重写。
 * 引号片段不跨行（R30-1：QUOTED_SPAN_RE 内部字符类补排换行）——漏写闭引号时旧实现
 * 吞掉后文任意闭引号之前的全部叙述，禁词红闸静默漏报。开头窗口先剥后开（重评-0912-4
 * P2-5）+ 按码点截（R33-32）。SIMILE_RE 正则本体不动——scripts/harvest-corpus.ts
 * 语料收割（R51-J-1）复用本正则直扫原文，剥引号只在各调用点做。
 */
import { describe, it, expect } from 'vitest'
import {
  checkBannedWords,
  checkOpeningNoEnv,
  checkBodyParts,
  checkSimile,
  checkImagery,
  checkStyleMetrics,
  SIMILE_RE,
} from '../../src/check/count.js'
import { stripQuotedSpans, QUOTED_SPAN_RE } from '../../src/check/quotes.js'
import type { IronRules } from '../../src/format/iron-rules.js'

/** 空铁律：只激活堆叠项路径，不叠加其他阈值项的噪声 */
const RULES: IronRules = {}

// ── checkBodyParts 剥对白 ────────────────────────────────────────

describe('checkBodyParts 剥对白', () => {
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

  it('「手」动作语境路径同口径：对白内伸手不计数，对白外照计', () => {
    // 全部动作「手」在引号内 → 不报
    expect(checkBodyParts('「他伸手接住。」「她握住手不放。」「抬手示意。」「抓手要紧。」「挥手作别。」「摊手无奈。」').items).toEqual([])
    // 对白外 6 处动作「手」> 阈 5 → 照报
    const r = checkBodyParts('他伸手接住。她握住手不放。抬手示意。抓手要紧。挥手作别。摊手无奈。')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.message).toContain('手×6')
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

// ── checkSimile 剥对白 ──────────────────────────────────────────

describe('checkSimile 剥对白', () => {
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

// ── 对话提示语堆叠项剥对白（与占比项同族对齐，R0911b-F-P3-1）──────────────

describe('checkStyleMetrics 对话提示语堆叠项剥对白', () => {
  it('对白内容里的「X地说」不计堆叠', () => {
    // 3 处「X地说」全在引号内（角色转述他人说话方式）：剥对白后叙述 0 处 → 不报
    const body = [
      '「他不耐烦地说了什么。」她回忆道。',
      '「母亲焦急地说了好几遍。」',
      '「车夫也催促地说了第三遍。」',
    ].join('\n')
    const r = checkStyleMetrics(body, RULES)
    expect(r.items.filter((i) => i.checkId === 'style-dialogue-tag')).toEqual([])
  })

  it('对白外提示语堆叠照常报黄（修复不弱化检测面）', () => {
    // 叙述面 3 处「X地说」→ 照报；引号内「焦急地说」不计
    const body = '他不耐烦地说着，挥手催促。母亲在一旁焦急地说：「求你再等一天。」门外的车夫也催促地说了第三遍。'
    const r = checkStyleMetrics(body, RULES)
    const tags = r.items.filter((i) => i.checkId === 'style-dialogue-tag')
    expect(tags).toHaveLength(3)
  })
})

// ── checkImagery 剥对白（R51-E-N5）───────────────────────────────

describe('checkImagery 剥对白', () => {
  const WORDS = ['空气', '气氛']

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

// ── checkOpeningNoEnv 剥对白 + 开窗顺序 + 码点口径（R29-4 / 重评-0912-4 P2-5 / R33-32）──

describe('checkOpeningNoEnv 开头窗口剥对白', () => {
  it('开头窗口内对白引号里的环境词不再报黄', () => {
    // 「天气」出现在对白 span 内——角色嘴里说的不算环境描写（叙述面）
    expect(checkOpeningNoEnv('「今天天气真好。」他拔刀出鞘。').items).toHaveLength(0)
    // 对照：叙述面同词照报
    const r = checkOpeningNoEnv('天气晴得刺眼。他拔刀出鞘。')
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.checkId).toBe('opening-env')
  })

  it('窗尾截断的引号 span（有开无闭）全文先剥——对白环境词不再误报', () => {
    // 对白 span 开于码点 288、闭于码点 306（span 共 19 码点）：旧序窗口（前 300 码点）截在
    // span 中段，有开无闭不被识别为 span → 对白里的「天气」参与匹配误报黄项（严格档升红拦定稿闸）。
    // 现全文先剥：span 整体移除，开窗落在去对白后的叙述面上 → 无命中。
    const spanStraddlesWindow = '风平浪静'.repeat(72) + '「今天天气真好，风和日丽，万里无云。」' + '策马扬鞭'.repeat(50)
    expect(checkOpeningNoEnv(spanStraddlesWindow).items).toHaveLength(0)

    // 对照：窗内完整对白被剥除后，叙述面窗口语义不变——环境词在剥后前 300 码点之外不报
    //（对白 7 码点 + 叙述过渡 15 码点 → 「天气」起于剥后码点 303，窗外）
    const envBeyondWindow = '风平浪静'.repeat(72) + '「无关对白。」' + '他翻身上马，驰向远方，看天边。' + '天气骤变，狂风大作。' + '策马扬鞭'.repeat(50)
    expect(checkOpeningNoEnv(envBeyondWindow).items).toHaveLength(0)

    // 正面锚：剥后叙述面窗内环境词照常命中（防线不失效）
    const envInWindow = '天气晴朗。' + '风平浪静'.repeat(80)
    const r = checkOpeningNoEnv(envInWindow)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]!.checkId).toBe('opening-env')
  })

  it('开头零环境窗口按码点截（astral 字符不缩短窗口）', () => {
    // 290 个 astral 码点 + 环境词落在 291-292 码点处（窗口 300 内）：
    // 修复前 UTF-16 slice(0,300) 只覆盖 150 码点 → 环境词落窗外不报；修复后按码点截足 300 → 报黄
    const filler = '𝄞'.repeat(290)
    const body = filler + '夜色渐深，环境词在此，后续正文继续。'
    const items = checkOpeningNoEnv(body, 300, ['夜色']).items
    expect(items.length).toBeGreaterThan(0)
  })
})

// ── 引号 span 不跨行（R30-1：跨段吞噬收口）───────────────────────

describe('引号片段不跨行：漏写闭引号不再吞噬后文叙述', () => {
  it('漏写闭引号的多段文本，第二段叙述的禁词必须被检出（不再跨段吞噬）', () => {
    // 第一段对白漏写闭引号（AI 草稿常见）；第三段的「别问了。」是后文任意闭引号。
    // 旧实现：span = 从首「一路吞到「别问了。」的 」，第二段「仿佛凝固」随叙述一起
    // 被剥除 → 禁词红闸静默漏报（63 字正文剥掉 60 字同型）。
    const body = [
      '「你到底想说什么。她没有回答，', // 第一段：对白漏写闭引号
      '夜风穿堂而过，她的脸色，仿佛凝固。', // 第二段叙述：禁词在此，前后皆标点（边界命中）
      '「别问了。」他转身离开。', // 第三段：后文任意闭引号（旧实现吞到这里）
    ].join('\n')
    const r = checkBannedWords(body, ['仿佛凝固'])
    expect(r.items.some((i) => i.checkId === 'banned-word' && i.level === 'red')).toBe(true)
  })

  it('同一行内成对引号仍正常剥除（对白不算作者叙述用词，不回归误报）', () => {
    // 引号片段在同一行内闭合 → 照旧成 span 剥除，禁词在引号内不报红
    const body = '他压低声音说了句「仿佛凝固」，然后闭嘴。'
    const r = checkBannedWords(body, ['仿佛凝固'])
    expect(r.items.every((i) => i.level !== 'red')).toBe(true)
  })

  it('单行成对引号剥除语义逐字不变（原语层锁定）', () => {
    expect(stripQuotedSpans('前「一」中“二”后')).toBe('前中后')
    expect(stripQuotedSpans('「嵌“套”」余')).toBe('」余')
    expect(QUOTED_SPAN_RE.test('「混搭”')).toBe(true) // 跨体系配对维持（quotes-matrix 契约）
  })

  it('opening 窗口内漏写闭引号，后段叙述的环境词不再被吞（漏报面闭合）', () => {
    const body = [
      '「今天天气真好。她笑了。', // 对白漏写闭引号
      '他们沿着街道走进树林深处。', // 叙述：环境词
      '「走吧。」他说。', // 后文闭引号（旧实现吞到这里）
    ].join('\n')
    const r = checkOpeningNoEnv(body)
    expect(r.items.some((i) => i.checkId === 'opening-env' && i.message.includes('天气'))).toBe(true)
  })

  it('opening 同行成对引号的环境对白照旧豁免（不引入误报）', () => {
    const body = '「今天天气真好。」\n他拔剑直取对方咽喉。'
    const r = checkOpeningNoEnv(body)
    expect(r.items).toHaveLength(0)
  })
})
