/**
 * 书级知识层播种与升级(统一批)。
 *
 * 建书时把随包知识层篇 `resources/knowledge/<rel>` 播种到 `<bookRoot>/知识层/<rel>`
 * (作者可编辑起点);应用升级时刷新「未被作者改动过」的种子篇,作者改过的原样保留
 * (升级不覆盖用户改动——同 ai/prompts/resource.ts overlay 迁移的语义与判据)。
 *
 * 判据「作者改没改」= 书级文件字节哈希是否命中该 rel 的**历史哈希表**
 * (`resources/knowledge/versions.json`,随包语料每次改动追加末位)。命中 = 仍是某版
 * 原样拷贝(未改)→ 升级为当前随包;**不命中 = 作者改过 → 永不覆盖**。
 * 无 versions 表条目/读失败 → 保守不覆盖(宁可留旧,不可毁作者改动)。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { bundledResource } from '../fs/resources.js'
import { hashBytes, hashFile } from '../fs/hash.js'
import { log, errMsg } from '../log/index.js'
import { BOOK_KNOWLEDGE_DIR, BUNDLED_KNOWLEDGE_SUBDIR, listBundledKnowledgeEntries } from './corpus.js'

/** 随包语料历史哈希表文件名(值形态同 prompts/versions.json:<rel> → [哈希…,末位当前]) */
export const KNOWLEDGE_VERSIONS_FILE = 'versions.json'

/** 不播种的类目:许可件随包留存即满足 MIT 署名(三面均不消费,不铺进书库制造噪音) */
const SEED_SKIP_CATEGORY = '许可'

/** 读随包语料历史哈希表;<rel> → 历史哈希数组(无表/读失败 → {})。 */
export function readKnowledgeVersions(): Record<string, string[]> {
  const fp = bundledResource(BUNDLED_KNOWLEDGE_SUBDIR, KNOWLEDGE_VERSIONS_FILE)
  if (!existsSync(fp)) return {}
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as unknown
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: Record<string, string[]> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v) && v.every((x): x is string => typeof x === 'string')) out[k] = v
    }
    return out
  } catch (e) {
    log.warn('knowledge-seed', `随包语料 versions 读取失败(升级走保守不覆盖):${errMsg(e)}`)
    return {}
  }
}

/**
 * 随包知识层语料 rel 清单(播种面 = 随包语料减去不播种类目)。
 *
 * **不另抄一份目录扫描**:直接复用 corpus.ts 的随包扫描(listBundledKnowledgeEntries)
 * ——此前本函数与那里各持一份逐行同构的遍历 + 各一份「非语料项跳过」名单
 * (同名三项、顺序不同),任一处新增跳过项都会让「对话面注入的篇」与「播种的篇」
 * 静默分叉。判据单源后,播种面恒 ⊆ 三面读取面。
 */
export function listBundledSeedRels(): string[] {
  return listBundledKnowledgeEntries()
    .filter((e) => e.category !== SEED_SKIP_CATEGORY)
    .map((e) => e.rel)
    .sort()
}

export interface SeedReport {
  /** 本次新播种(书级原本无此 rel) */
  seeded: string[]
  /** 未改动被升级到当前随包版 */
  upgraded: string[]
  /** 作者改过/无历史表 → 原样保留 */
  kept: string[]
}

/**
 * 播种 + 升级书级知识层。幂等:书级已有该 rel 且哈希命中历史表 = 判升级,否则保留/新播。
 * 单篇失败不拖死整轮(逐篇 try/catch,对齐 overlay 迁移容错口径)。
 */
export function seedBookKnowledge(bookRoot: string, opts?: { seedOnly?: boolean }): SeedReport {
  const report: SeedReport = { seeded: [], upgraded: [], kept: [] }
  const rels = listBundledSeedRels()
  if (rels.length === 0) return report
  const versions = readKnowledgeVersions()
  const targetRoot = join(bookRoot, BOOK_KNOWLEDGE_DIR)

  for (const rel of rels) {
    try {
      const src = bundledResource(BUNDLED_KNOWLEDGE_SUBDIR, ...rel.split('/'))
      const dst = join(targetRoot, ...rel.split('/'))
      const bundledBytes = readFileSync(src)
      if (!existsSync(dst)) {
        mkdirSync(join(dst, '..'), { recursive: true })
        atomicWriteFile(dst, bundledBytes)
        report.seeded.push(rel)
        continue
      }
      // 已存在:seedOnly 时不动;否则按历史哈希判升级
      if (opts?.seedOnly) {
        report.kept.push(rel)
        continue
      }
      const currentHash = hashBytes(bundledBytes)
      const bookHash = hashFile(dst)
      if (bookHash === currentHash) {
        report.kept.push(rel) // 已是当前版
        continue
      }
      const history = versions[rel]
      if (history && history.includes(bookHash)) {
        atomicWriteFile(dst, bundledBytes) // 未改动的旧版拷贝 → 升级
        report.upgraded.push(rel)
      } else {
        report.kept.push(rel) // 作者改过 / 无历史表 → 永不覆盖
      }
    } catch (e) {
      log.warn('knowledge-seed', `知识层播种/升级失败跳过该篇:${rel}(${errMsg(e)})`)
    }
  }
  return report
}

/** 建书初始化:播种随包知识层(seedOnly——建书只铺起点,升级由启动迁移负责)。 */
export function seedKnowledgeOnBookCreate(bookRoot: string): void {
  try {
    const r = seedBookKnowledge(bookRoot, { seedOnly: true })
    if (r.seeded.length > 0) log.warn('knowledge-seed', `已播种书级知识层 ${r.seeded.length} 篇:${bookRoot}`)
  } catch (e) {
    // 播种失败不阻断建书(知识层是增强面;随包兜底仍生效)
    log.warn('knowledge-seed', `建书知识层播种失败(不阻断建书):${errMsg(e)}`)
  }
}

/** 逐书升级(启动链):刷新未改动的种子篇,作者改动保留。 */
export function migrateBookKnowledge(bookRoots: readonly string[]): void {
  for (const root of bookRoots) {
    try {
      const r = seedBookKnowledge(root)
      if (r.upgraded.length > 0) log.warn('knowledge-seed', `升级未改动的知识层副本 ${r.upgraded.length} 篇:${root}`)
    } catch (e) {
      log.warn('knowledge-seed', `知识层升级失败跳过该书:${root}(${errMsg(e)})`)
    }
  }
}
