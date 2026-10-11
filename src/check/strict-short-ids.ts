/**
 * 短篇严格模式「黄项升红」白名单（checkId 集）——自 runner.ts 拆出落叶模块。
 *
 * 拆出理由（结构）：机检代次哈希（checker-generation.ts）须收编本表，但
 * run-tree-issues 有「不引 runner.js（总聚合机检）」的断环断言（模块环守护）——
 * 表落本叶后 runner 与 checker-generation 双侧 import，两侧都不牵总聚合件。
 * 表内容与拆出前逐条一致，不得夹带语义改动（代次面：增删条目 = 检查器规则变更）。
 */

const STRICT_SHORT_CHECK_IDS = new Set([
  'piece-word-short',
  'piece-word-long',
  'body-parts',
  'simile-density',
  // 可配阈值三黄项——阈值改成可配后，写坏/误调（如复读占比配成
  // 0.9）在普通模式只表现为「黄项消失」，严格模式下则必须升红拦闸：严格承诺是「机检
  // 全绿才可过定稿闸」，这三项黄了同样不该绿灯放行。word-count 不在此列（长篇项，
  // 严格模式只作用于短篇书，piece-word-* 已覆盖短篇字数语义）
  'repeat',
  'sentence-length',
  'imagery-overuse',
  'section-count-heading-missing',
  'section-count',
  'opening-env',
  'manifest-no-reversal',
  'manifest-setup-short',
  'manifest-payoff-open',
  'emotion-curve-short',
  'emotion-curve-strength',
  'emotion-curve-no-reversal',
  'emotion-curve-peak-low',
  // unreadable/degraded 族——「检查没跑成」（名册/线索表/
  // 布线文件读不出）与「配置降级」（book.yaml 解析失败按默认配置执行）在严格短篇
  // 下同样升红：严格模式的承诺是「机检全绿才可过定稿闸」，黄项语义（提示性）会让
  // 没跑成的检查绿灯过闸。普通（非严格）模式维持黄项不动。
  'roster-unreadable',
  'piece-list-unreadable',
  'lead-outline-unreadable',
  'lead-updates-unreadable',
  'book-config-degraded',
])

/** 短篇严格模式下由黄升红的 checkId 集合（只读消费面；机检代次哈希同源收编）。 */
export { STRICT_SHORT_CHECK_IDS }
