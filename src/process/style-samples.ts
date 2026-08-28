/**
 * 文风样章选取（prepare 备料与 draft-prompt 生产链共用）。
 *
 * 双路：条目库（文风/条目/，S5 统一模型）优先，走 pickSampleEntries 跨场景语义
 * （每场景 1 条保代表 + 主场景补满）；未迁移书走旧样章库（文风/样章库/<场景>/），
 * 同语义手拣。总量由注入档约束（轻 1 段 / 重 3 段，母本第 1.4 节）。
 */
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { readSamplesByScene } from '../format/style.js'
import { readEntries, ENTRIES_DIR } from '../format/style-entry.js'
import { pickSampleEntries, sampleEntryText } from '../format/style-inject.js'
import type { StyleSample } from '../format/types.js'

/** 选出至多 maxTotal 段文风样章注入文本；无库/无命中 → 空数组（调用方跳段） */
export function pickStyleSamples(bookRoot: string, scenes: string[], maxTotal: number): string[] {
  return pickStyleSamplesWithSources(bookRoot, scenes, maxTotal).map((s) => s.text)
}

/** Q-5（第十五轮）：同选取，附带源文件（相对书根；旧样章库无 _path 时 undefined）
 *  ——draft 链收集进 promptFiles，「模型可见⟺已记录」文件级溯源 */
export function pickStyleSamplesWithSources(
  bookRoot: string,
  scenes: string[],
  maxTotal: number,
): Array<{ text: string; path: string | undefined }> {
  if (maxTotal <= 0) return []
  const entriesDir = join(bookRoot, ENTRIES_DIR)
  if (existsSync(entriesDir)) {
    const { entries } = readEntries(entriesDir)
    return pickSampleEntries(entries, scenes, maxTotal).map((e) => ({
      text: sampleEntryText(e),
      path: e._path ? relative(bookRoot, e._path) : undefined,
    }))
  }
  // 旧样章库：第一轮每场景各取 1（保证次场景有代表）；第二轮补满到 maxTotal。
  // R72-8（二十轮 C-3）：补满轮由「只扫主场景」改轮转全场景——主场景条目空/不足预算时
  // 原实现拿不满 maxTotal；轮转（场景序=入参序）保持多样性与首轮优先级。
  const sampleDir = join(bookRoot, '文风', '样章库')
  const perScene = scenes.map((sc) => readSamplesByScene(sampleDir, sc).samples)
  const picked: StyleSample[] = []
  for (const samples of perScene) {
    if (samples.length > 0) picked.push(samples[0]!)
  }
  let cursor = 1
  while (picked.length < maxTotal) {
    let advanced = false
    for (const samples of perScene) {
      if (cursor < samples.length) {
        picked.push(samples[cursor]!)
        advanced = true
        if (picked.length >= maxTotal) break
      }
    }
    if (!advanced) break
    cursor++
  }
  return picked.slice(0, maxTotal).map((s) => {
    const text = !s.技法指令 ? s.正文 : `技法指令：${s.技法指令}\n${s.正文}`
    return { text, path: s._path ? relative(bookRoot, s._path) : undefined }
  })
}
