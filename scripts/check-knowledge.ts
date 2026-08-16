#!/usr/bin/env node
/**
 * 知识层 manifest 对账门（P2-29）——「CI 只相信正式知识层」落成门禁。
 *
 * 背景：src/knowledge/manifest.ts 的 validateKnowledgeManifest 已完整实现（target 路径
 * 安全 + sha256 与磁盘对账 + 重复检测 + 元数据校验），但全仓零调用方——注释宣称的
 * 「CI 只相信正式知识层」名存实亡（cc 评审 P2-29）。本脚本接线该校验为 CI 门：
 * 知识层/_manifest.json 与实际文件任一失配（改名漏登记 / 改内容漏更新 / 路径越界）即红。
 *
 * 用法：npm run check:knowledge（退出码 1 = 失配，并列出问题）
 */
import { validateKnowledgeManifest } from '../src/knowledge/manifest.js'
import { fileURLToPath } from 'node:url'

// 仓库根（工作区路径可能含 ^ 等特殊字符，fileURLToPath 解码，与 check-packaging 同口径）
const root = fileURLToPath(new URL('..', import.meta.url))

const report = validateKnowledgeManifest(root)
if (!report.ok) {
  console.error('check:knowledge 失配（知识层 manifest 与磁盘不一致，修复后再提交）：')
  for (const issue of report.issues) console.error(`  - ${issue.path}: ${issue.message}`)
  process.exit(1)
}
const count = report.manifest?.entries?.length ?? 0
console.log(`check:knowledge 通过：知识层 ${count} 条 manifest 条目与磁盘一致。`)
