/**
 * 境界枚举读写 —— 依据 #6 境界枚举 spec。
 *
 * 落点：定稿/设定/境界体系.md（#6 第 2 节）
 * 格式：front matter（体系嵌套数组）+ 正文（人话说明，不参与机检）
 *
 * 成长线机检的数据源（#6 第 4 节）：序列索引即高低，单调/跨度校验读此。
 */

import { readFile, writeFile, parseRealmSystems, stringifyRealmSystems } from './frontmatter.js'
import type { RealmDoc, ParseError } from './types.js'

/** 读取 境界体系.md → RealmDoc（容错） */
export function readRealmDoc(
  filePath: string,
): { ok: true; doc: RealmDoc } | { ok: false; error: ParseError } {
  const r = readFile(filePath)
  if (!r.ok) return r

  const systems = parseRealmSystems(r.fmRaw)
  return {
    ok: true,
    doc: {
      体系: systems,
      ...(r.body.trim() ? { 正文: r.body.trim() } : {}),
      _path: filePath,
    },
  }
}

/** 写入 境界体系.md */
export function writeRealmDoc(filePath: string, doc: RealmDoc): void {
  const fmText = stringifyRealmSystems(doc.体系)
  writeFile(filePath, fmText, doc.正文 ?? '')
}

/**
 * 取某体系序列（成长线机检用，#6 第 4 节）。
 * @returns 序列数组（索引即高低），不存在返回 null
 */
export function getRealmSequence(
  doc: RealmDoc,
  systemName: string,
): string[] | null {
  const sys = doc.体系.find((s) => s.名称 === systemName)
  return sys ? sys.序列 : null
}

/**
 * 查某境界在序列中的索引（#6 第 4 节单调性/跨度机检的基础）。
 * @returns 索引（0 最低），未命中返回 -1
 */
export function realmIndex(sequence: string[], realm: string): number {
  return sequence.indexOf(realm)
}
