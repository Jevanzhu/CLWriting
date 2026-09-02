/**
 * R37-8（三十七轮批 B）回归：节数守恒标题正则 `\s*` 跨行吞换行。
 *
 * 根因：`/^##(?!#)\s*.+$/gm` 的 `\s` 含 `\n`（m 标志只约束 ^/$，不约束字符类）——
 * 裸 `##`（或 `## \t ` 纯空白收尾）后随换行被跨行吞并、下一行正文顶上 `.+`，
 * 「裸 ## 行不计」（R26-43/R28-2 语义）在「裸 ## + 后继正文行」形态整体失效：
 * 节数虚高 → section-count 假绿漏拦；反向（吞掉后真标题少计）假拦定稿。
 * 修复：`\s*` 收窄为 `[ \t\u3000]*`（行内空白含全角空格）+ `\S` 门卫（须有可见
 * 标题文字，纯空白行不再借位命中）。同族先例：R33-1（围栏 CRLF）、R36-1（leads CRLF）。
 */
import { test, expect } from 'vitest'
import { checkSectionCount } from '../../src/check/count.js'

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
