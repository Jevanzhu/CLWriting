/**
 * 书级知识层播种、升级与退役(统一批)。
 *
 * 建书时把随包知识层篇 `resources/knowledge/<rel>` 播种到 `<bookRoot>/知识层/<rel>`
 * (作者可编辑起点);应用升级时刷新「未被作者改动过」的种子篇,作者改过的原样保留
 * (升级不覆盖用户改动——同 ai/prompts/resource.ts overlay 迁移的语义与判据)。
 *
 * 判据「作者改没改」= 书级文件字节哈希是否命中该 rel 的**历史哈希表**
 * (`resources/knowledge/versions.json`,随包语料每次改动追加末位)。命中 = 仍是某版
 * 原样拷贝(未改)→ 升级为当前随包;**不命中 = 作者改过 → 永不覆盖**。
 * 无 versions 表条目/读失败 → 保守不覆盖(宁可留旧,不可毁作者改动)。
 *
 * 退役步用同一判据的反面:已从随包下架的 rel(登记在 versions.json 的退役段)若书级
 * 副本未改动 → 删除(否则书根新旧并存);作者改过的照样永久保留。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFile } from '../fs/atomic.js'
import { bundledResource } from '../fs/resources.js'
import { hashBytes, hashFile } from '../fs/hash.js'
import { log, errMsg } from '../log/index.js'
import { BOOK_KNOWLEDGE_DIR, BUNDLED_KNOWLEDGE_SUBDIR, listBundledKnowledgeEntries } from './corpus.js'

/** 随包语料历史哈希表文件名(值形态同 prompts/versions.json:<rel> → [哈希…,末位当前]) */
export const KNOWLEDGE_VERSIONS_FILE = 'versions.json'

/** 退役段键名:值形态 = rel → [历史哈希…],与主段同构;独立段使「已下架篇」的
 *  未改动判定可与现役篇共存(主段只收随包现役 rel)。 */
export const KNOWLEDGE_RETIRED_SECTION = '__retired__'

/** 不播种的类目:许可件随包留存即满足 MIT 署名(三面均不消费,不铺进书库制造噪音) */
const SEED_SKIP_CATEGORY = '许可'

/** 读随包 versions.json 原始对象(无表/形状坏/读失败 → {})。 */
function readVersionsRaw(): Record<string, unknown> {
  const fp = bundledResource(BUNDLED_KNOWLEDGE_SUBDIR, KNOWLEDGE_VERSIONS_FILE)
  if (!existsSync(fp)) return {}
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as unknown
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch (e) {
    log.warn('knowledge-seed', `随包语料 versions 读取失败(升级走保守不覆盖):${errMsg(e)}`)
    return {}
  }
}

/** 同形态段过滤:rel → 历史哈希数组(非 string[] 值一律跳过)。 */
function pickHashTable(obj: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.every((x): x is string => typeof x === 'string')) out[k] = v
  }
  return out
}

/** 读随包语料历史哈希表;<rel> → 历史哈希数组(无表/读失败 → {})。 */
export function readKnowledgeVersions(): Record<string, string[]> {
  return pickHashTable(readVersionsRaw())
}

/**
 * 读随包语料**退役段**;<rel> → 历史哈希数组。
 *
 * 退役段登记「已从随包下架」的 rel 及其历史哈希:书级副本哈希命中该表 = 仍是某版
 * 原样拷贝(未改动)→ 可安全删除;不命中 = 作者改过或书级自发新件 → 永久保留。
 * 段缺失/为空 → {} = 本轮不删任何件(机制在位、数据随批落)。
 */
export function readRetiredKnowledgeRels(): Record<string, string[]> {
  const seg = readVersionsRaw()[KNOWLEDGE_RETIRED_SECTION]
  return seg !== null && typeof seg === 'object' ? pickHashTable(seg as Record<string, unknown>) : {}
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
  /** 已从随包下架且书级副本未改动 → 退役删除 */
  retired: string[]
}

/**
 * 旧件退役:遍历**退役段**登记的 rel(非全量扫描——未登记进退役段的书级件一律不动),
 * 书级存在且哈希命中退役段历史表(未改动的原样拷贝)→ 删除;哈希不命中(作者改过,
 * 或书级自发新件/同名仍在随包)→ 保留,归入 kept。
 *
 * 退役段为空 = 本轮不删任何件(机制在位、数据随批落);单篇失败不拖死整轮。
 */
function retireBookKnowledge(
  bookRoot: string,
  liveRels: ReadonlySet<string>,
  report: SeedReport,
): void {
  const retired = readRetiredKnowledgeRels()
  for (const [rel, history] of Object.entries(retired)) {
    if (liveRels.has(rel)) continue // 仍在随包播种面:交播种/升级步处置
    const dst = join(bookRoot, BOOK_KNOWLEDGE_DIR, ...rel.split('/'))
    if (!existsSync(dst)) continue
    try {
      if (!history.includes(hashFile(dst))) {
        report.kept.push(rel) // 作者改过 → 作者自有内容,永不删
        continue
      }
      rmSync(dst)
      report.retired.push(rel)
    } catch (e) {
      log.warn('knowledge-seed', `知识层退役失败跳过该篇:${rel}(${errMsg(e)})`)
    }
  }
}

/**
 * 播种 + 升级 + 退役书级知识层。幂等:书级已有该 rel 且哈希命中历史表 = 判升级,否则保留/新播。
 * 单篇失败不拖死整轮(逐篇 try/catch,对齐 overlay 迁移容错口径)。
 */
export function seedBookKnowledge(bookRoot: string, opts?: { seedOnly?: boolean }): SeedReport {
  const report: SeedReport = { seeded: [], upgraded: [], kept: [], retired: [] }
  const rels = listBundledSeedRels()
  const versions = readKnowledgeVersions()
  const targetRoot = join(bookRoot, BOOK_KNOWLEDGE_DIR)

  // 退役先于播种:建书(seedOnly)不退役——新书根无历史件;升级链才做(旧件于后继就位后清理)
  if (!opts?.seedOnly) retireBookKnowledge(bookRoot, new Set(rels), report)

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

/** 逐书升级(启动链):刷新未改动的种子篇,退役已下架的未改动旧件,作者改动保留。 */
export function migrateBookKnowledge(bookRoots: readonly string[]): void {
  for (const root of bookRoots) {
    try {
      const r = seedBookKnowledge(root)
      if (r.upgraded.length > 0) log.warn('knowledge-seed', `升级未改动的知识层副本 ${r.upgraded.length} 篇:${root}`)
      if (r.retired.length > 0) log.warn('knowledge-seed', `退役未改动的知识层旧件 ${r.retired.length} 篇:${root}`)
    } catch (e) {
      log.warn('knowledge-seed', `知识层升级失败跳过该书:${root}(${errMsg(e)})`)
    }
  }
}
