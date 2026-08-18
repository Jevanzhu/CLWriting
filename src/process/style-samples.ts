/**
 * 文风样章选取（prepare 备料与 draft-prompt 生产链共用）。
 *
 * 双路：条目库（文风/条目/，S5 统一模型）优先，走 pickSampleEntries 跨场景语义
 * （每场景 1 条保代表 + 主场景补满）；未迁移书走旧样章库（文风/样章库/<场景>/），
 * 同语义手拣。总量由注入档约束（轻 1 段 / 重 3 段，母本第 1.4 节）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSamplesByScene } from '../format/style.js'
import { readEntries, ENTRIES_DIR } from '../format/style-entry.js'
import { pickSampleEntries, sampleEntryText } from '../format/style-inject.js'
import type { StyleSample } from '../format/types.js'

/** 选出至多 maxTotal 段文风样章注入文本；无库/无命中 → 空数组（调用方跳段） */
export function pickStyleSamples(bookRoot: string, scenes: string[], maxTotal: number): string[] {
  if (maxTotal <= 0) return []
  const entriesDir = join(bookRoot, ENTRIES_DIR)
  if (existsSync(entriesDir)) {
    const { entries } = readEntries(entriesDir)
    return pickSampleEntries(entries, scenes, maxTotal).map(sampleEntryText)
  }
  // 旧样章库：第一轮每场景各取 1（保证次场景有代表）；第二轮主场景补满到 maxTotal
  const sampleDir = join(bookRoot, '文风', '样章库')
  const perScene = scenes.map((sc) => readSamplesByScene(sampleDir, sc).samples)
  const picked: StyleSample[] = []
  for (const samples of perScene) {
    if (samples.length > 0) picked.push(samples[0]!)
  }
  for (let i = 1; picked.length < maxTotal && i < (perScene[0]?.length ?? 0); i++) {
    picked.push(perScene[0]![i]!)
  }
  return picked.slice(0, maxTotal).map((s) => {
    if (!s.技法指令) return s.正文
    return `技法指令：${s.技法指令}\n${s.正文}`
  })
}
