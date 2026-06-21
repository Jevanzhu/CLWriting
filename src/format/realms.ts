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

/**
 * 从一句证据里提取境界体系中的精确境界名。
 *
 * 只接受完整枚举值命中，避免把「筑基初期」误判成枚举里的「筑基」。
 * 一句里出现多个境界时取最靠后的一个，适配「炼气一层→炼气二层」这类写法。
 */
export function extractExactRealmFromEvidence(evidence: string, sequence: string[]): string | null {
  const matches: Array<{ realm: string; index: number }> = []
  const realms = [...sequence].sort((a, b) => b.length - a.length)
  for (const realm of realms) {
    let start = 0
    while (start < evidence.length) {
      const index = evidence.indexOf(realm, start)
      if (index === -1) break
      const next = evidence[index + realm.length]
      if (next === undefined || isRealmBoundary(next)) matches.push({ realm, index })
      start = index + Math.max(realm.length, 1)
    }
  }
  if (matches.length === 0) return null
  matches.sort((a, b) => a.index - b.index)
  return matches[matches.length - 1]!.realm
}

function isRealmBoundary(char: string): boolean {
  return /[\s,，.。;；:：!！?？、）)\]】》〉>（(\[【《〈<\-—→]/.test(char)
}
