/**
 * learn 候选入库 —— 依据 M7 #38 spec 第 4 节。
 *
 * 作者审核挑选后的候选入库到 #5 样章库/金句库。
 * 复用 #5 格式（writeSample）+ 序号递增。
 *
 * 红线：作者审核才入库（commitCandidates 只处理传入的 picks，不自动入库）。
 */

import { existsSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeSample, parseSampleFileName } from '../format/style.js'
import type { StyleSample, SampleSource } from '../format/types.js'
import type { SampleCandidate, QuoteCandidate } from './index.js'

/**
 * 扫描场景目录求最大序号 +1（#5 样章库序号递增）。
 */
export function nextSampleSeq(sampleDir: string, scene: string): number {
  const sceneDir = join(sampleDir, scene)
  if (!existsSync(sceneDir)) return 1
  let maxSeq = 0
  for (const f of readdirSync(sceneDir)) {
    if (!f.endsWith('.md') || f.startsWith('._')) continue
    const parsed = parseSampleFileName(f)
    if (parsed && parsed.序号 > maxSeq) maxSeq = parsed.序号
  }
  return maxSeq + 1
}

/**
 * 样章候选入库（作者挑选后调用）。
 *
 * @param bookRoot 书仓库根
 * @param picks 作者挑选的样章候选
 * @param source 来源（作者原作 / 导入；默认作者原作）
 * @returns 入库的文件路径列表（相对书仓库）
 */
export function commitSamples(
  bookRoot: string,
  picks: SampleCandidate[],
  source: SampleSource = '作者原作',
): string[] {
  const sampleDir = join(bookRoot, '文风', '样章库')
  const written: string[] = []
  // 同场景内序号各自递增
  const sceneSeq = new Map<string, number>()

  for (const pick of picks) {
    const baseSeq = sceneSeq.get(pick.场景) ?? nextSampleSeq(sampleDir, pick.场景)
    sceneSeq.set(pick.场景, baseSeq + 1)

    const fileName = `${pick.场景}-${String(baseSeq).padStart(3, '0')}.md`
    const sceneDir = join(sampleDir, pick.场景)
    mkdirSync(sceneDir, { recursive: true })

    const sample: StyleSample = {
      场景: pick.场景,
      来源: source,
      出处: pick.出处,
      正文: pick.正文,
    }
    writeSample(join(sceneDir, fileName), sample)
    written.push(`文风/样章库/${pick.场景}/${fileName}`)
  }
  return written
}

/**
 * 金句候选入库（追加到 文风/金句库/<场景>.md）。
 *
 * @returns 入库的文件路径列表（相对书仓库）
 */
export function commitQuotes(bookRoot: string, picks: QuoteCandidate[]): string[] {
  const quoteDir = join(bookRoot, '文风', '金句库')
  mkdirSync(quoteDir, { recursive: true })

  const byScene = new Map<string, QuoteCandidate[]>()
  for (const q of picks) {
    const list = byScene.get(q.场景) ?? []
    list.push(q)
    byScene.set(q.场景, list)
  }

  const written: string[] = []
  for (const [scene, quotes] of byScene) {
    const filePath = join(quoteDir, `${scene}.md`)
    const newContent = quotes.map((q) => `- ${q.正文}  \n  ——${q.出处}`).join('\n\n')
    // 追加（文件已存在则加换行接上）
    if (existsSync(filePath)) {
      appendFileSync(filePath, '\n\n' + newContent, 'utf-8')
    } else {
      appendFileSync(filePath, newContent, 'utf-8')
    }
    written.push(`文风/金句库/${scene}.md`)
  }
  return written
}
