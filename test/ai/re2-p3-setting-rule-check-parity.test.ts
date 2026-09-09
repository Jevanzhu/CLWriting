/**
 * 重评2-P3-1（2026-09-09 全量重评 GLM-5.3，AI 域 P3-②）：check 域口径防漂移对拍。
 *
 * 背景：src/ai/rules/setting-rule.ts:147-174 的守卫族（DIALOGUE_GUIDE_RE /
 * ATTRIBUTION_RE / SPEECH_ATTRIBUTION_RE）与 parseRosterNamesLocal 注释自记
 * 「逐字移植 check/count.ts」（R48-3，只读参照、不改 check 侧）——双实现无编译期
 * 约束，R48-3 修过同型漂移，属复发风险。本文件不改任何生产代码，把 setting-rule
 * 移植物与 check/count.ts 对应物经**两端公共入口**做行为一致性对拍：
 * - AI 侧   ：settingConsistencyRule.check（违规名 = message 首个「」片段）
 * - check 侧：checkNewNames（候选名 = message 首个「」片段）
 * 同一 (roster, body) 输入两端必须报出**同一组名字**（对白守卫族 + 名册精确判重
 * 的合成输出）；任何一端词表/正则/解析口径单独漂移即对拍破裂。
 *
 * 已知「本就应不同」的差异，刻意不纳入对拍面（防误报）：
 * ① span 抽取窗——AI 侧 QUOTED_NAME_RE 只认 2-4 字候选窗（专名语义），check 侧
 *    QUOTED_SPAN_RE 取全 span 再过滤——嵌套引号等形态两端裁剪不同，属候选窗口径
 *    差异而非守卫漂移；本文件语料只用干净的「」单层 span，不触该面。
 * ② 名册 front matter——AI 侧 loadSettingData 剥 fm（X-P3a），check 侧
 *    parseRosterNames 吃原文；语料名册不含 fm。
 * ③ 剥标点字符集——AI 侧 OUTSIDE_PUNCT_RE 含 LENIENT ASCII 直引号、check 侧
 *    punctRe 不含；语料不含 ASCII 引号故不触。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { settingConsistencyRule } from '../../src/ai/rules/setting-rule.js'
import { checkNewNames } from '../../src/check/count.js'

const dirs: string[] = []

function makeBook(roster: string): { bookRoot: string; rosterPath: string } {
  const bookRoot = mkdtempSync(join(tmpdir(), 're2-p3-parity-'))
  dirs.push(bookRoot)
  mkdirSync(join(bookRoot, '设定'), { recursive: true })
  const rosterPath = join(bookRoot, '设定', '名册.md')
  writeFileSync(rosterPath, roster, 'utf-8')
  return { bookRoot, rosterPath }
}

/** message 首个「」片段 = 违规/候选名（两端 message 模板的首引号位均承载名字） */
function nameOf(message: string): string | null {
  return message.match(/「(.*?)」/)?.[1] ?? null
}

/** 两端同输入实跑，返回各自报出的名字集合 */
function runBoth(roster: string, body: string): { ai: Set<string>; check: Set<string> } {
  const { bookRoot, rosterPath } = makeBook(roster)
  const aiNames = settingConsistencyRule
    .check(body, { bookRoot })
    .map((v) => nameOf(v.message))
    .filter((n): n is string => n !== null)
  const checkNames = checkNewNames(body, rosterPath)
    .items.map((i) => nameOf(i.message))
    .filter((n): n is string => n !== null)
  return { ai: new Set(aiNames), check: new Set(checkNames) }
}

/** 对拍主断言：两端名字集合一致 */
function expectParity(roster: string, body: string): { ai: Set<string>; check: Set<string> } {
  const r = runBoth(roster, body)
  expect([...r.ai].sort()).toEqual([...r.check].sort())
  return r
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('重评2-P3-1: setting-rule 移植物 × check/count 对拍（同一输入两端同判）', () => {
  // 守卫族语料：空名册（registered 空），逐行单 span，两端必须同判
  // expect = 该行式的两端共同预期（'report' 非空 / 'exempt' 空）——显式声明，
  // 防按标题关键词猜测的哨兵误分类
  const GUARD_CASES: Array<{ title: string; body: string; expect: 'report' | 'exempt' }> = [
    { title: '直述提及（无守卫命中）→ 两端都报', body: '旁白「云澈」定格在铜镜之中。', expect: 'report' },
    { title: '对白引导词收尾（R29-B12）→ 两端都豁免', body: '他低声道，「快走」二字未落，人已没入夜色。', expect: 'exempt' },
    { title: '整行提示语成分（V-P2-13）→ 两端都豁免', body: '他说了「为何」。', expect: 'exempt' },
    { title: '人名+说话动词归属行（X-P2-9）→ 两端都豁免', body: '林晚答了，「云曦」。', expect: 'exempt' },
    { title: '动词+冒号+引语结构（R73-17）→ 两端都豁免', body: '他挥挥手：「住手」', expect: 'exempt' },
    { title: '动作+对白混排、span 含句读（R76-3）→ 两端都豁免', body: '他忽然冷下脸「住手了！」随之一刀挥落。', expect: 'exempt' },
    { title: '引导词表收窄：叫不豁免（R29-B12 反例）→ 两端都报', body: '名叫「萧策」的老者立在门前。', expect: 'report' },
    { title: '引导词残余面：普通词「道」收尾照豁免（两端同款取舍）→ 两端都豁免', body: '他切了频道，「叶秋」要来了。', expect: 'exempt' },
    { title: '一行双 span → 两端各报两名', body: '旁白「云澈」又闻「林晚」之名。', expect: 'report' },
  ]

  for (const c of GUARD_CASES) {
    it(`守卫族对拍：${c.title}`, () => {
      const r = expectParity('', c.body)
      // 哨兵（防两端同坏的对拍假绿）：非空/空按显式期望核对
      if (c.expect === 'report') {
        expect(r.ai.size).toBeGreaterThan(0)
      } else {
        expect(r.ai.size).toBe(0)
      }
    })
  }

  it('守卫族哨兵：直述例两端各报「云澈」；引导词收窄例两端各报「萧策」', () => {
    const a = expectParity('', '旁白「云澈」定格在铜镜之中。')
    expect(a.ai.has('云澈')).toBe(true)
    const b = expectParity('', '名叫「萧策」的老者立在门前。')
    expect(b.ai.has('萧策')).toBe(true)
  })

  it('名册解析对拍：标题/无序·有序列表/括注/顿号逗号分号冒号斜杠劈分/2-4 字窗/扩展 A 区——两端登记集一致', () => {
    // 名册形态语料：紧凑写法（`###` 后无空格、`-`/`1.` 后无空格）让「前缀剥除」
    // 成为可观测差异（不剥则 token 带杂质、纯汉字判定拒绝）；（主角）验括注剥离；
    // 「叶」单字与「已登记名录」5 字语料验 2-4 窗拒绝（叶不可探针、名录正册可）；
    // 㐀㐁（U+3400/U+3401）验扩展 A 区收录（PURE_HANZI_RE ↔ ROSTER_NAME_RE）。
    const roster = [
      '###名录正册',
      '-云澈、叶凡',
      '1.林晚',
      '*萧策（主角）',
      '苏檀儿；赵铁柱、钱二/孙三：李四：周五',
      '嘀咕噜',
      '㐀㐁',
      '-叶、云二、单字',
    ].join('\n')
    // 探针字母表 = 名册全部 2-4 字 token + 两个名册外诱饵——探针全集覆盖名册
    // 可观测名，故「两端报出集一致」⟺「两端登记集一致」（解析口径对拍）。
    const probes = [
      '云澈', '叶凡', '林晚', '萧策', '苏檀儿', '赵铁柱', '钱二', '孙三', '李四', '周五',
      '嘀咕噜', '㐀㐁', '云二', '单字', '名录正册',
      '独孤城', '上官雁',
    ]
      .map((n) => `旁白「${n}」定格。`)
      .join('\n')
    const r = expectParity(roster, probes)
    // 哨兵：诱饵必被两端各报（对拍非两端同坏的假绿）
    expect(r.ai.has('独孤城')).toBe(true)
    expect(r.ai.has('上官雁')).toBe(true)
    // 哨兵：括注剥离/ATX 剥离/窗口拒绝在两端同向可观测
    expect(r.ai.has('萧策')).toBe(false) // 括注剥离 → 萧策已登记
    expect(r.ai.has('名录正册')).toBe(false) // ATX 剥离 → 已登记
    expect(r.ai.has('独孤城')).toBe(r.check.has('独孤城'))
  })

  it('名册解析哨兵：两端口径若漂移即破裂——单端模拟差异在真实双跑下不可掩盖', () => {
    // 破坏性对照（证明对拍灵敏度）：同一探针体换一个漏掉「有序列表剥除」语义的
    // 等价形态不可构造（生产代码只读），改为验证「未剥前缀形态」下探针按未登记
    // 处理——若某端前缀剥除丢失，该端会漏报/多报，集合对拍即失败。
    const roster = '1.林晚\n'
    const body = '旁白「林晚」定格。'
    const r = expectParity(roster, body)
    expect(r.ai.size).toBe(0) // 两端都剥 `1.` 前缀 → 林晚已登记 → 均不报
    expect(r.check.size).toBe(0)
  })
})
