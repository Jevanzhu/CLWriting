#!/usr/bin/env node
/**
 * eslint 抑制台账「只减不增」上限门。
 *
 * 背景：eslint-suppressions.json 是存量违规台账（键 = 文件 + 规则 + 计数）。批量抑制
 * 本身不是治理——若只允许新增、不要求递减，新违规会持续覆盖存量债，规则门形同虚设。
 * 本门锁计数总和上限：新代码引入违规须先修掉等量存量，禁止把 suppressions 当垃圾桶。
 * 上限 = 当前台账总量；合法重基线（修掉一批存量后）才下调，且须在批记里留理由。
 *
 * 用法：npm run check:suppressions（退出码 1 = 超上限或台账形状坏了）
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT as root } from './repo-root.mjs'

/** 上限 = 台账当前总量。只减不增：下调时同步改此数。 */
export const SUPPRESSION_BASELINE = 315

/** 纯函数供直测：校验台账形状并统计总量，超上限即列入 problems。 */
export function inspectSuppressions(data, baseline = SUPPRESSION_BASELINE) {
  const problems = []
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { total: 0, problems: ['eslint-suppressions.json 形状变化：顶层应为对象'] }
  }
  let total = 0
  for (const [file, rules] of Object.entries(data)) {
    if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
      problems.push(`${file}：规则表形状变化（应为对象）`)
      continue
    }
    for (const [rule, entry] of Object.entries(rules)) {
      const count = entry?.count
      if (!Number.isInteger(count) || count <= 0) {
        problems.push(`${file} → ${rule}：count 非正整数（${String(count)}）`)
        continue
      }
      total += count
    }
  }
  if (total > baseline) {
    problems.push(
      `抑制总量 ${total} 超过上限 ${baseline}（只减不增）——新违规请修代码，或先等量递减存量；` +
        '确需重基线须同步改本文件 SUPPRESSION_BASELINE 并在批记留理由',
    )
  }
  return { total, problems }
}

function checkSuppressions() {
  const path = join(root, 'eslint-suppressions.json')
  let data
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`check:suppressions 失败：eslint-suppressions.json 不可读/不是合法 JSON：${e.message}`)
    process.exit(1)
  }
  const { total, problems } = inspectSuppressions(data)
  if (problems.length > 0) {
    console.error('check:suppressions 失配（抑制台账只减不增）：')
    for (const p of problems) console.error('  - ' + p)
    process.exit(1)
  }
  console.log(`check:suppressions 通过：抑制总量 ${total}/${SUPPRESSION_BASELINE}（只减不增）`)
}

const invoked = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (invoked) checkSuppressions()
