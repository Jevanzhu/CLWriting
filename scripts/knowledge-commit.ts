#!/usr/bin/env node
/**
 * 知识层更新·第二步（阶段 23 批 4，D3=a）：定稿文件登记进 _manifest.json。
 *
 * 用法：npm run knowledge:commit -- <知识层/定稿文件.md> [--source-ref test/corpus/checks/xx.json] [--note "备注"]
 * 登记 entry（sha256 实算 / source=语料回归域 / category=方法论 缺省）+ generated_at 更新 +
 * 全量重写 manifest（2 空格缩进 + 尾换行，与现文件往返字节恒等；存量条目不动——恒等红线测试锁死）。
 * 登记后跑对账（validateKnowledgeManifest），失配即退出码 1。
 */
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { commitKnowledgeFile } from '../src/knowledge/update.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const target = argv[0]
if (!target) {
  console.error('用法：npm run knowledge:commit -- <知识层/定稿文件.md> [--source-ref …] [--note "…"]')
  process.exit(1)
}
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  // 重评-P3-23（2026-09-09 全量代码重评）：值缺失或以 `--` 开头 = 吞了下一个 flag 名——
  // `--source-ref --note "x"` 此前把 `--note` 当 sourceRef 静默写进 manifest；按缺参
  // 处理，走同款「用法 + 退出码 1」参数错误出口（在触达 manifest 前退出，零落盘）
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) {
    console.error(`参数错误：${name} 缺少值（不能省略或以 -- 开头）`)
    console.error('用法：npm run knowledge:commit -- <知识层/定稿文件.md> [--source-ref …] [--note "…"]')
    process.exit(1)
  }
  return v
}

const report = commitKnowledgeFile(root, {
  target,
  sourceRef: flag('--source-ref'),
  note: flag('--note'),
})
if (!report.ok) {
  // 0918二轮修复批（G105）：提交层对账两栏化（src/knowledge/update.ts）——「登记已落盘
  // 但 manifest 存预存坏行」不再走本分支（那形态已归 ok:true + issues，见下方新增段）。
  // 本出口自此如实收窄为「登记确未写入」：判重拒绝（已在 manifest）/ 新条目自身形状坏 /
  // manifest 写失败（fm 注入已回滚）。R0912-3 的两态区分语义由下方 ok:true 段承接，
  // 作者可见契约（文案 + 退出码 1）不变。
  console.error('登记失败（manifest 未写入有效状态，对账失配）：')
  for (const issue of report.issues) console.error(`  - ${issue.path}: ${issue.message}`)
  process.exit(1)
}
// 0918二轮修复批（G105）：登记已成功、但 manifest 存存量坏行（非本次引入，issue 只
// 指向旧伤）——R0912-3 口径：如实报「已写入 + 预存坏行、请先修 manifest」并保持退出码
// 1（作者按旧提示重试只会撞「已在 manifest」，故仍以非零码促其先修 manifest）。
if (report.issues.length > 0) {
  console.error('登记已写入 manifest，但读取对账发现预存坏行（非本次登记引入；重试会报「已在 manifest」），请先修 manifest：')
  for (const issue of report.issues) console.error(`  - ${issue.path}: ${issue.message}`)
  process.exit(1)
}
console.log(`已登记：${target}（manifest ${report.manifest?.entries.length} 条，对账通过）`)
