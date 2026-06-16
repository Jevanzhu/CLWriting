/**
 * 文风样章库读写 —— 依据 ⑤ 文风样章库 spec。
 *
 * 文件组织（⑤ 第 3 节）：文风/样章库/<场景>/<场景>-<序号>.md
 * 格式：front matter（场景/来源/出处/标签）+ 正文（样章本身）
 *
 * 来源三值（⑤ 第 6 节）：作者原作 / 题材范文 / 导入
 */

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readFile, writeFile, parseFlat, stringifyFlat } from './frontmatter.js'
import type { StyleSample, SampleSource, ParseError } from './types.js'

const KNOWN_FM_KEYS = new Set(['场景', '来源', '出处', '标签'])

/** ⑤ 第 5 节：基础场景集 */
export const BASE_SCENES = ['战斗', '对话', '抒情', '叙事铺陈', '爽点高潮'] as const

/** 读取一个样章 md → StyleSample（容错） */
export function readSample(
  filePath: string,
): { ok: true; sample: StyleSample } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const map = parseFlat(r.fmRaw)
  const 场景 = map.get('场景')
  if (typeof 场景 !== 'string' || !场景) {
    return { ok: false, error: { file: filePath, line: 0, message: '缺少必填字段：场景' } }
  }

  const _raw: Record<string, string> = {}
  for (const [k, v] of map) {
    if (!KNOWN_FM_KEYS.has(k)) _raw[k] = String(v)
  }

  const sample: StyleSample = {
    场景,
    来源: (map.get('来源') as SampleSource) ?? '作者原作',
    ...(map.has('出处') ? { 出处: String(map.get('出处')) } : {}),
    ...(Array.isArray(map.get('标签')) ? { 标签: map.get('标签') as string[] } : {}),
    正文: r.body.trim(),
    ...(Object.keys(_raw).length > 0 ? { _raw } : {}),
    _path: filePath,
  }
  return { ok: true, sample }
}

/** StyleSample → front matter Map */
function sampleToMap(s: StyleSample): Map<string, unknown> {
  const map = new Map<string, unknown>()
  map.set('场景', s.场景)
  map.set('来源', s.来源)
  if (s.出处) map.set('出处', s.出处)
  if (s.标签) map.set('标签', s.标签)
  if (s._raw) {
    for (const [k, v] of Object.entries(s._raw)) {
      if (!map.has(k)) map.set(k, v)
    }
  }
  return map
}

/** 写入样章 md */
export function writeSample(filePath: string, s: StyleSample): void {
  writeFile(filePath, stringifyFlat(sampleToMap(s)), s.正文)
}

/**
 * 按场景取样章（⑤ 第 6 节：同场景优先取"作者原作/导入"，范文兜底）。
 * 返回该场景目录下的全部样章。
 */
export function readSamplesByScene(
  sampleDir: string, // 文风/样章库/
  scene: string,
): { samples: StyleSample[]; errors: ParseError[] } {
  const sceneDir = join(sampleDir, scene)
  const samples: StyleSample[] = []
  const errors: ParseError[] = []
  let files: string[]
  try {
    files = readdirSync(sceneDir).filter((f) => f.endsWith('.md') && !f.startsWith('._'))
  } catch {
    return { samples, errors } // 场景目录不存在，空
  }
  for (const f of files) {
    const fp = join(sceneDir, f)
    if (!statSync(fp).isFile()) continue
    const r = readSample(fp)
    if (r.ok) samples.push(r.sample)
    else errors.push(r.error)
  }
  return { samples, errors }
}

/** 从文件名提取场景与序号（战斗-001.md → {场景:战斗, 序号:1}） */
export function parseSampleFileName(
  fileName: string,
): { 场景: string; 序号: number } | null {
  const base = basename(fileName, '.md')
  const m = base.match(/^(.+)-(\d{3})$/)
  if (!m) return null
  return { 场景: m[1]!, 序号: Number(m[2]!) }
}
