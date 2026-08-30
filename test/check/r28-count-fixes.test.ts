/**
 * 二十八轮修复批 A 回归（R28-2 / R28-8 / R28-9）——根因-语义-测法：
 * - R28-2 节标题正则未排除更深 # 前缀：R26-43 放宽 `##\s*` 支持紧排后，`### 手记`/
 *   `####` 子标题被 `^##\s*.+` 误命中计入节标题 → 节数虚高 → section-count 假黄 →
 *   短篇 strict 清单提红拦定稿。改 `^##(?!#)`。测：①子标题不计、紧排照计、裸 ## 不计；
 *   ②strict 链路级：含 ### 子标题的 short 稿跑 runAllChecks(strictShort) 不产 section-count 红。
 * - R28-8 DIALOGUE_TAG_RE 动词集窄：只含 说/道/问/喊/叫/答/叹/笑 8 个，窄于
 *   SPEECH_ATTRIBUTION_RE 的 21 个 → 标签占比分子系统性偏低（漏检向黄）。抽 SPEECH_VERBS
 *   单源对齐。测：新动词（骂/嘀咕/喃喃/吼）命中标签占比；构词语素锚定豁免不回潮；
 *   「了后接一」锚定登记不动（仍不计）。
 * - R28-9 围栏开关先证伪后修：评审上报「孤立 ``` 吞掉后续 ##」经 CommonMark 对照证伪
 *   （非围栏态 ``` 行本就是开栏，围栏可无信息串，延伸到文末是 spec 行为）——但发现真实
 *   偏离并最小修复：闭栏须与开栏同字符、长度不小于开栏、其后只允许空白。测：~~~ 栏不被
 *   ``` 提前闭合、围栏内 ```js 内容行不当闭栏、4+ 反引号开栏须同长闭栏、R27-25 常规
 *   ```md 开闭不回归。
 */
import { test, expect } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSectionCount, computeStyleMetrics } from '../../src/check/count.js'
import { runAllChecks } from '../../src/check/runner.js'
import { DEFAULT_CONFIG } from '../../src/format/yaml.js'
import type { ChapterMeta, BookConfig } from '../../src/format/types.js'

// ── R28-2：节标题排除更深 # 前缀 ─────────────────────────────

test('R28-2: ### / #### 子标题不计节，## 节标题恰计', () => {
  // 用例①：### 手记 子标题 + 2 个 ## 节标题 → 恰计 2 节（修复前 3 节假黄）
  const body = [
    '## 开头钩子', '钩子正文。', '',
    '### 手记', '子标题下的正文，不属于新节。', '',
    '## 余韵', '余韵正文。',
  ].join('\n')
  // 期望 2 → 恰好守恒无黄；期望 5 → 文案报「正文 2 节」（不是 3）
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
  expect(checkSectionCount(body, 5).items.find((it) => it.checkId === 'section-count')?.message)
    .toContain('正文 2 节')
})

test('R28-2: #### 更深子标题同样不计（R26-43 紧排语义不变）', () => {
  const body = [
    '##钩子', '紧排标题照计。', '',
    '#### 深一层', '更深子标题不算新节。', '',
    '##余韵', '紧排第二节。',
  ].join('\n')
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
  const r5 = checkSectionCount(body, 5)
  expect(r5.items.find((it) => it.checkId === 'section-count')?.message).toContain('正文 2 节')
})

test('R28-2: 裸 ## 行不计为节标题', () => {
  // 裸 ##（行内无内容）不构成标题——置于文末避免与后随标题跨行合并（`\s*` 含换行
  // 是 R26-43 既有语义，R28-2 只加 (?!#) 不动它）
  expect(checkSectionCount('## 一\nx\n## 二\nx\n##', 2).items).toHaveLength(0)
})

test('R28-9 配套正负对照: 4 节真实缺失仍按 4 报（剥子标题不掩盖真实缺失）', () => {
  // 4 个真 ## + 1 个 ### 子标题 → 报 4 节而非 5（对照 r27-batch-b R27-25 用例口径）
  const body = [
    '## 一', '正文。', '',
    '## 二', '正文。', '',
    '## 三', '### 子标题', '正文。', '',
    '## 四', '正文。',
  ].join('\n')
  expect(checkSectionCount(body, 5).items.find((it) => it.checkId === 'section-count')?.message)
    .toContain('正文 4 节')
})

// ── R28-2：短篇 strict 链路级——### 子标题不再提红拦定稿 ─────

function shortConfig(): BookConfig {
  // word_min/max 收窄避免字数黄项噪声，隔离节数守恒单变量
  return { ...DEFAULT_CONFIG, kind: 'short', short: { word_min: 0, word_max: 999999 } }
}

const ch: ChapterMeta = { 章号: 1, 标题: '雪夜', 钩子类型: '悬念钩', 钩子强弱: '中', 情绪定位: '铺垫' }

// 五段齐整 + 两处 ### 子标题（正文避免环境词/身体部位/比喻，隔离其余 strict 项）
const fiveSections = [
  '## 开头钩子', '他推开门，血溅了一地。', '',
  '## 铺垫', '### 手记', '她把信折了三折，压回枕下。', '',
  '## 升级', '### 旧账', '刀锋贴上喉咙，他没有退。', '',
  '## 反转', '原来印章是假的。', '',
  '## 余韵', '灯灭了。',
].join('\n')

test('R28-2: 短篇 strict 链路——含 ### 子标题的五段稿不产 section-count 红项', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r28-strict-'))
  try {
    const r = runAllChecks({
      bookRoot: tmp,
      config: shortConfig(),
      chapter: ch,
      body: fiveSections,
      fileName: '001-雪夜.md',
      strictShort: true,
    })
    // 修复前：### 手记/### 旧账 计入 → 7 节假黄 → strict 提红拦定稿
    const secItems = r.sections
      .flatMap((s) => s.items)
      .filter((it) => it.checkId === 'section-count' || it.checkId === 'section-count-heading-missing')
    expect(secItems).toHaveLength(0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('R28-2: strict 链路正负对照——真实 6 节仍提红（闸未被拆）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'r28-strict-'))
  try {
    // 五段之外多一个真 ## 节 → 6≠5 黄 → strict 提红，证明链路闸仍在
    const six = fiveSections + '\n\n## 尾声\n又一段。'
    const r = runAllChecks({
      bookRoot: tmp,
      config: shortConfig(),
      chapter: ch,
      body: six,
      fileName: '001-雪夜.md',
      strictShort: true,
    })
    const red = r.sections
      .flatMap((s) => s.items)
      .find((it) => it.checkId === 'section-count' && it.level === 'red')
    expect(red).toBeDefined()
    expect(red!.message).toContain('短篇严格模式')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// ── R28-9：围栏开闭同类同长配对（最小修复）────────────────────

test('R28-9: ~~~ 开的栏不被 ``` 提前闭合（CommonMark 同类配对）', () => {
  const body = [
    '~~~', '## 内容甲', '```', '## 内容乙', '~~~', // ``` 不闭 ~~~ 栏，至 ~~~ 才闭合
    '## 章一', '章一正文。', '',
    '## 章二', '章二正文。',
  ].join('\n')
  // 栏内两个 ## 不计 → 恰计 2；修复前 ``` 误闭 → 内容乙 泄出计 3 节
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
  expect(checkSectionCount(body, 3).items.find((it) => it.checkId === 'section-count')?.message)
    .toContain('正文 2 节')
})

test('R28-9: 围栏内带信息串的 ```js 是内容不是闭栏', () => {
  const body = [
    '```', '## 示例甲', '``` js', '## 示例乙', '```', // 闭栏行不得带信息串：```js 为内容
    '## 章一', '章一正文。', '',
    '## 章二', '章二正文。',
  ].join('\n')
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
})

test('R28-9: 4 反引号开栏须同长闭栏，3 反引号行是内容', () => {
  const body = [
    '````', '## 示例甲', '```', '## 示例乙', '````',
    '## 章一', '章一正文。', '',
    '## 章二', '章二正文。',
  ].join('\n')
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
})

// ── R28-8：对话标签动词集对齐（SPEECH_VERBS 单源）──────────────

function tagRatio(line: string): number {
  return computeStyleMetrics(line, { maxDialogueTagRatio: 0.3 }).dialogueTagRatio
}

test('R28-8: 新动词（骂/嘀咕/喃喃/吼）命中标签占比', () => {
  // 修复前 8 动词集不含 骂/嘀咕/喃喃/吼 → 占比 0（漏检向黄）。
  // 注意用裸动词收尾：骂道/吼道 在修复前可借动词「道」命中，测不出扩展
  expect(tagRatio('「滚开。」他骂。')).toBe(1)
  expect(tagRatio('「走吧。」她嘀咕。')).toBe(1)
  expect(tagRatio('「嗯。」他喃喃。')).toBe(1)
  expect(tagRatio('「住手！」老周吼。')).toBe(1)
})

test('R28-8: 锚定豁免不回潮，「了后接一」登记不动仍不计', () => {
  // R26-11 反例不回归：构词语素（喝出）不算标签
  expect(tagRatio('「嗯。」汤里喝出了咸味。')).toBe(0)
  // 「他骂了一声，」——了 后接数词不满足双侧锚定（R28-8 登记不动，维持不计）
  expect(tagRatio('「去。」他骂了一声，转身走了。')).toBe(0)
  // 既有动词语义不变
  expect(tagRatio('「走吧。」林晚喊道。')).toBe(1)
})
