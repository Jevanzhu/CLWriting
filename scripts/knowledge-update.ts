#!/usr/bin/env node
/**
 * 知识层更新·第一步（阶段 23 批 4，D3=a）：语料回归域误报规律 → 知识层草稿。
 *
 * 用法：npm run knowledge:update
 * 扫 test/corpus/checks/*.json 的 expect:"silent" 条目 → 汇总各 checkId →
 * 落 知识层/机检误报-草稿-<今日>.md。**不动 _manifest.json**。
 * 作者审核（删孤例、归纳语境、改文件名去「草稿」）后走 npm run knowledge:commit。
 */
import { fileURLToPath } from 'node:url'
import { summarizeFalsePositives, writeFalsePositiveDraft } from '../src/knowledge/update.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const corpusDir = fileURLToPath(new URL('../test/corpus/checks', import.meta.url))
const date = new Date().toISOString().slice(0, 10)

const summaries = summarizeFalsePositives(corpusDir)
const draft = writeFalsePositiveDraft(root, corpusDir, date)

if (summaries.length === 0) {
  console.log('语料回归域无 expect:"silent" 条目——无可汇总的误报规律，未产草稿。')
  process.exit(0)
}
console.log(`已产草稿：${draft}`)
for (const s of summaries) {
  console.log(`  - ${s.checkId}: 误报 ${s.silent} 条 / 真命中 ${s.fire} 条`)
}
console.log('下一步：人工审核草稿（删孤例、归纳误报语境、文件名去「草稿-<date>-」），然后 npm run knowledge:commit -- <定稿路径>')
