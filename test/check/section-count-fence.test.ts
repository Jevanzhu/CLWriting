/**
 * 节数守恒的标题/围栏口径：checkSectionCount 计数边界（含 strict 链路级）。
 *
 * 档源（4 档并 1，按被测行为合并；断言逐条保留、去重 0 条）：
 * - r28-count-fixes.test.ts 的 R28-2 / R28-9 组（同文件 R28-8 对话标签动词组属
 *   DIALOGUE_TAG_RE 家族，另拆 dialogue-tag-verbs.test.ts）
 * - r37-count-heading-crlf.test.ts（R37-8 标题正则 `\s*` 跨行吞换行）
 * - r27-batch-b.test.ts 的 R27-25 组（同文件其余组属 format 解析守卫家族，
 *   另拆 format-parse-guards.test.ts）
 * - r33-check-fixes.test.ts 的 R33-1 组
 * - r34d-section-count-copy.test.ts（R34D-12 节数守恒文案按实际 expected 插值）
 *
 * 演进脉络：R26-43 紧排 `##\s*` → R27-25 围栏内 ## 不计 → R28-2 `^##(?!#)` 更深
 * 子标题排除 → R28-9 围栏开闭同类同长配对（CommonMark 对照证伪评审上报面后最小修复）
 * → R33-1 围栏正则 CRLF 容忍（win 主平台 R27-25 语义整体反转）→ R37-8 `\s*` 收窄
 * `[ \t\u3000]*` + `\S` 门卫（裸 ## + 后继正文行的跨行吞并形态）。
 */

import { test, expect } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempTracked } from '../helpers/temp-dir.js'
import { checkSectionCount } from '../../src/check/count.js'
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
  // 4 个真 ## + 1 个 ### 子标题 → 报 4 节而非 5
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
  const tmp = mkdtempTracked(join(tmpdir(), 'section-fence-strict-'))
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
  const tmp = mkdtempTracked(join(tmpdir(), 'section-fence-strict-'))
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

// ── R37-8：标题正则 `\s*` 跨行吞换行 ──────────────────────────
// 根因：`/^##(?!#)\s*.+$/gm` 的 `\s` 含 `\n`（m 标志只约束 ^/$，不约束字符类）——
// 裸 `##`（或 `## \t ` 纯空白收尾）后随换行被跨行吞并、下一行正文顶上 `.+`，
// 「裸 ## 行不计」（R26-43/R28-2 语义）在「裸 ## + 后继正文行」形态整体失效：
// 节数虚高 → section-count 假绿漏拦；反向（吞掉后真标题少计）假拦定稿。
// 修复：`\s*` 收窄为 `[ \t\u3000]*`（行内空白含全角空格）+ `\S` 门卫。

test('R37-8: 裸 ## 后跟正文行不计节标题（LF）——恰 2 节不虚高', () => {
  // 文末裸 ## + 后继正文行：修复前 `\s*` 吞 \n、`.+` 顶上「正文尾巴」→ 3 节假绿
  const body = '## 一\nx\n## 二\nx\n##\n正文尾巴'
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
  expect(checkSectionCount(body, 3).items.find((it) => it.checkId === 'section-count')?.message)
    .toContain('正文 2 节')
})

test('R37-8: 裸 ## 后跟正文行不计（CRLF 同口径）', () => {
  const body = '## 一\r\nx\r\n## 二\r\nx\r\n##\r\n正文尾巴'
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
})

test('R37-8: ## 纯空白收尾行（## \\t ）后跟正文行不计，正文不并入标题', () => {
  // `## \t ` 行内只剩空白：修复前 `\s*` 吞完空白 + \n 后 `.+` 顶上下一行正文
  const body = '## 一\nx\n## 二\nx\n## \t \n正文尾巴'
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
})

test('R37-8: \\r\\n 行尾的正常标题照计，五段 CRLF 稿守恒无黄', () => {
  const body = [
    '## 开头钩子', '他推开门。', '',
    '## 铺垫', '她把信折了三折。', '',
    '## 升级', '刀锋贴上喉咙。', '',
    '## 反转', '原来印章是假的。', '',
    '## 余韵', '灯灭了。',
  ].join('\r\n')
  expect(checkSectionCount(body, 5).items).toHaveLength(0)
})

test('R37-8: 标题行尾空白（## 标题 \\t ）照计 1 节', () => {
  const body = '## 标题 \t \n正文'
  // 恰 1 个标题 → 走单标题文案分支（不误判成 2 节、也不漏成 0）
  const r = checkSectionCount(body, 5)
  expect(r.items.find((it) => it.checkId === 'section-count-heading-missing')?.message)
    .toContain('仅检测到 1 个')
})

test('R37-8: CRLF 标题行尾空白形态同计（\\r 前的空白不吞行）', () => {
  const body = '## 一 \t\r\nx\r\n## 二 \t\r\nx'
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
})

// ── R27-25 / R33-1：围栏剥除 + CRLF 容忍 ──────────────────────

test('R27-25: checkSectionCount 不计代码围栏内 ## 标题', () => {
  const body = [
    '## 开头钩子', '钩子正文。', '',
    '## 铺垫', '铺垫正文。', '',
    '```md', '## 示例结构一', '## 示例结构二', '```', '',
    '## 升级', '升级正文。', '',
    '## 反转', '反转正文。', '',
    '## 余韵', '余韵正文。',
  ].join('\n')
  const r = checkSectionCount(body, 5)
  // 修复前：围栏内 2 个 ## 计入 → 7 节黄项；修复后 5===5 无黄
  expect(r.items.find((it) => it.checkId === 'section-count')).toBeUndefined()

  // 对照：真实 4 节（围栏内标题不算数）仍按 4 报黄——剥围栏不掩盖真实缺失
  const body4 = [
    '## 开头钩子', '钩子正文。', '',
    '## 铺垫', '铺垫正文。', '',
    '```md', '## 示例结构一', '```', '',
    '## 升级', '升级正文。', '',
    '## 余韵', '余韵正文。',
  ].join('\n')
  const r4 = checkSectionCount(body4, 5)
  expect(r4.items.find((it) => it.checkId === 'section-count')?.message).toContain('正文 4 节')
})

test('R33-1: CRLF 围栏内 ## 不计节（修复前整体反转），与 LF 同口径', () => {
  const lf = ['## 第一节', '正文。', '', '```md', '## 示例（围栏内）', '```', '', '## 第二节', '正文。'].join('\n')
  const crlf = lf.replaceAll('\n', '\r\n')
  // 围栏内 ## 示例 不计 → 恰 2 节守恒无黄；期望 3 → 报「正文 2 节」
  expect(checkSectionCount(lf, 2).items).toHaveLength(0)
  expect(checkSectionCount(crlf, 2).items).toHaveLength(0)
  expect(checkSectionCount(crlf, 3).items.find((it) => it.checkId === 'section-count')?.message).toContain('正文 2 节')
})

test('R33-1: CRLF 带信息串开栏 ```js\\r 与 \\r 闭栏行照常识别', () => {
  // 5 个真节 + 围栏内 1 个 ##：围栏内不计 → 恰 5 节守恒无黄（修复前围栏内 ## 计入 → 6 节假黄）
  const body = [
    '## 开头钩子', '钩子。', '', '```js', '## 代码内注释示例', 'const a = 1;', '```', '',
    '## 铺垫', '铺垫。', '', '## 升级', '升级。', '', '## 反转', '反转。', '', '## 余韵', '余韵。',
  ].join('\r\n')
  expect(checkSectionCount(body, 5).items).toHaveLength(0)
})

test('R37-8: 既有语义不回归——紧排 ##标题 照计、### 子标题仍排除、围栏内不计', () => {
  // 紧排（R26-43）+ 更深 # 排除（R28-2）+ 围栏剥除（R27-25/R33-1）三口径锁定
  const body = [
    '##钩子', '紧排照计。', '',
    '### 手记', '子标题不算节。', '',
    '```md', '## 围栏示例', '```', '',
    '##余韵', '第二节。',
  ].join('\n')
  expect(checkSectionCount(body, 2).items).toHaveLength(0)
})

// ── R34D-12（并入档；原 r34d-section-count-copy.test.ts）：节数守恒文案按实际
// expected 插值，不再硬编码「五段」。
//
// 修复背景：section_count 可配置（runner 传 short.section_count），但文案硬编码
// 「五段结构」并枚举 5 个节名——配置 ≠5 的 strict 短篇把黄提红后 formatRedForRewrite
// 喂给自愈重写，重写目标被误导成五段。修后：期望值统一插值 expected；五段节名枚举
// 仅缺省 5 段时保留（≠5 去枚举按期望节数描述）。

test('R34D-12: section_count=3 节数不符文案含期望值 3、不含「五段」', () => {
  const body = '## 一\nx\n## 二\nx\n## 三\nx\n## 四\nx' // 4 节 ≠ 3
  const r = checkSectionCount(body, 3)
  expect(r.items).toHaveLength(1)
  const msg = r.items[0]!.message
  expect(msg).toContain('正文 4 节')
  expect(msg).toContain('3')
  expect(msg).not.toContain('五段')
})

test('R34D-12: section_count=3 无标题文案按 3 插值、不枚举五段节名', () => {
  const r = checkSectionCount('段一\n\n段二', 3)
  expect(r.items[0]!.checkId).toBe('section-count-heading-missing')
  const msg = r.items[0]!.message
  expect(msg).toContain('3')
  expect(msg).not.toContain('五段')
  expect(msg).not.toContain('## 开头钩子')
  expect(msg).toContain('不按自然段计节') // 既有断言口径保持
})

test('R34D-12: section_count=3 单标题分支同样插值', () => {
  const r = checkSectionCount('## 开头\n只有一段标题的正文', 3)
  expect(r.items[0]!.checkId).toBe('section-count-heading-missing')
  const msg = r.items[0]!.message
  expect(msg).toContain('仅检测到 1 个') // RB-KN-P2-7 既有口径保持
  expect(msg).toContain('3')
  expect(msg).not.toContain('五段')
})

test('R34D-12: 缺省 5 段文案保持既有节名指引（零回归）', () => {
  const r = checkSectionCount('段一\n\n段二', 5)
  const msg = r.items[0]!.message
  expect(msg).toContain('五段结构')
  expect(msg).toContain('## 开头钩子 / ## 铺垫 / ## 升级 / ## 反转 / ## 余韵')
  expect(msg).toContain('不按自然段计节')
})

test('R34D-12: 节数不符文案统一插值（缺省 5 时仍报「期望 5 节」）', () => {
  const r = checkSectionCount('## 一\nx\n## 二\nx', 5)
  expect(r.items[0]!.message).toBe('正文 2 节，期望 5 节（节数守恒）')
})
