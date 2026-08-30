/**
 * 境界枚举读写 —— 依据 #6 境界枚举 spec。
 *
 * 落点：设定/境界体系.md（#6 第 2 节）
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
 *
 * R26-40（二十六轮）：命中点**前**边界同样锚定——前邻字符不得是汉字（行首/边界符
 * 除外），除非紧邻汉字是跃迁连接语素（至/到/入/成/达/于/晋/升/进/凝/结/破/跌/落/
 * 退/返/踏/迈）。防「伪金丹/九转金丹」把「金丹」当命中（伪/转非连接语素 → 拒绝；
 * 若「伪金丹」本身在序列中，其整词命中不受影响且按最靠后优先正确胜出）。连接语素
 * 白名单保住常规跃迁证据「突破至筑基」「跌落至炼气」（前邻「至」）。从严方向安全：
 * 误拒只回落 growth-evidence-no-realm 黄项（漏检向黄），误收则产出错境界目标，
 * 假红/漏红双向污染单调性/跨度判定。
 */
const REALM_LEAD_CONNECTIVES = new Set([
  '至', '到', '入', '成', '达', '于', '晋', '升', '进', '凝', '结', '破', '跌', '落', '退', '返', '踏', '迈',
])

/** 汉字判定（基本区 + 扩展 A 区，字面区间与 check/count.ts 的 HANZI 同源；format 域
 *  不反向 import check——check→format 单向依赖，不可成环） */
function isHanziChar(ch: string): boolean {
  return /[一-鿿㐀-䶿]/.test(ch)
}

export function extractExactRealmFromEvidence(evidence: string, sequence: string[]): string | null {
  const matches: Array<{ realm: string; index: number }> = []
  const realms = [...sequence].sort((a, b) => b.length - a.length)
  for (const realm of realms) {
    let start = 0
    while (start < evidence.length) {
      const index = evidence.indexOf(realm, start)
      if (index === -1) break
      const next = evidence[index + realm.length]
      const prev = index > 0 ? evidence[index - 1]! : undefined
      // R26-40：前邻汉字须是跃迁连接语素（伪金丹/九转金丹 的 伪/转 → 拒绝）
      const prevOk =
        prev === undefined || !isHanziChar(prev) || REALM_LEAD_CONNECTIVES.has(prev)
      if ((next === undefined || isRealmBoundary(next)) && prevOk) matches.push({ realm, index })
      start = index + Math.max(realm.length, 1)
    }
  }
  if (matches.length === 0) return null
  matches.sort((a, b) => a.index - b.index)
  return matches[matches.length - 1]!.realm
}

function isRealmBoundary(char: string): boolean {
  // R27-22（二十七轮）：补直角/弯引号——正文以「筑基」『金丹』“元婴” 引述境界时，
  // 境界词的后邻是闭合引号，原字符集不含 → 证据提取整类失败（引述恰是设定敏感处）
  return /[\s,，.。;；:：!！?？、）)\]】》〉>（(\[【《〈<\-—→「」『』“”‘’]/.test(char)
}
