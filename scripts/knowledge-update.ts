#!/usr/bin/env node
/**
 * 知识层更新·第一步（阶段 23 批 4，D3=a）：语料回归域误报规律 → 知识层草稿。
 *
 * 用法：npm run knowledge:update
 * 扫 test/corpus/checks/*.json 的 expect:"silent" 条目 → 汇总各 checkId →
 * 落 知识层/机检误报-草稿-<今日>.md。**不动 _manifest.json**。
 * 作者审核（删孤例、归纳语境、改文件名去「草稿」）后走 npm run knowledge:commit。
 *
 * R27-131（二十七轮）：汇总为空不再落草稿——原实现无条件 writeFalsePositiveDraft
 * 之后才判空打印「未产草稿」，只有说明行的占位草稿照落盘，对外口径与实际产物不一致。
 * 主体收进 runKnowledgeUpdate（root/date 可注入，直测见 test/scripts/r27-knowledge-update-empty.test.ts）
 * + 直跑守卫（check-knowledge.ts 同款：被 import 不触发落盘/输出副作用）。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { summarizeFalsePositives, writeFalsePositiveDraft, type FalsePositiveSummary } from '../src/knowledge/update.js'

export interface KnowledgeUpdateRun {
  summaries: FalsePositiveSummary[]
  /** 草稿相对项目根路径；null = 汇总为空，未落任何文件（R27-131 口径） */
  draftRel: string | null
}

/** 扫语料 → 空汇总跳过草稿写入，非空照常落盘（纯编排，落盘细节在 src/knowledge/update）。 */
export function runKnowledgeUpdate(projectRoot: string, corpusDir: string, date: string): KnowledgeUpdateRun {
  const summaries = summarizeFalsePositives(corpusDir)
  // R27-131：先判空后落盘——空汇总不产占位文件，「未产草稿」口径与磁盘一致
  const draftRel = summaries.length === 0 ? null : writeFalsePositiveDraft(projectRoot, corpusDir, date)
  return { summaries, draftRel }
}

function main(): void {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const corpusDir = fileURLToPath(new URL('../test/corpus/checks', import.meta.url))
  // R62-54：日期取本地时区（东八区）——toISOString 是 UTC，本地 0-8 点产「昨日」文件名
  const _now = new Date()
  const date = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`

  const { summaries, draftRel } = runKnowledgeUpdate(root, corpusDir, date)

  if (draftRel === null) {
    console.log('语料回归域无 expect:"silent" 条目——无可汇总的误报规律，未产草稿。')
    return
  }
  console.log(`已产草稿：${draftRel}`)
  for (const s of summaries) {
    console.log(`  - ${s.checkId}: 误报 ${s.silent} 条 / 真命中 ${s.fire} 条`)
  }
  console.log('下一步：人工审核草稿（删孤例、归纳误报语境、文件名去「草稿-<date>-」），然后 npm run knowledge:commit -- <定稿路径>')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
