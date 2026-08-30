/**
 * 内置 prompt 资源层（批次 C2 / CS-19 + A6 合流：资源化 + 内容哈希精确匹配迁移）。
 *
 * 模型（借鉴 cherry contentVersion，见 04-调研 §2.1）：
 * - 捆绑源 = resources/prompts/<name>.md，文件体 = 文案 + 恰一个结尾换行；
 *   读取端剥一个尾换行得「规范文本」，哈希 = sha256(规范文本) 前 16 位。
 *   版本用内容哈希而非日期戳——同一天改内容日期不变会导致升级判定静默失效。
 * - versions.json：{ "<file>.md": [哈希...] }（时间序，末位 = 当前）。
 *   内置文案迭代时：改资源文件 → 末位追加新哈希 → 金测夹具同步。
 * - 用户覆盖层（overlay）= <userDataPath>/prompts/<name>.md，存在即优先生效。
 * - 迁移（A6：升级不覆盖用户改动）= migratePromptOverlays：overlay 哈希命中
 *   该文件的任一历史哈希（= 用户从某版内置原样拷贝、未改过）→ 升级为当前内置；
 *   哈希不在历史（= 用户改过）→ 原样保留，绝不覆盖。
 * - 精确匹配（CS-19）= matchBuiltinPrompt：任意 prompt 文本哈希命中历史表 → 定位
 *   到内置名。runner 用它把「旧版内置 systemPrompt」在运行期换成 overlay/当前内置。
 *
 * 纯函数 + 可注入 registry（测试用临时目录造 mini 捆绑源），默认读捆绑资源。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bundledResource } from '../../fs/resources.js'
import { atomicWriteFile } from '../../fs/atomic.js'
import { log } from '../../log/index.js'

/** 哈希 = sha256(规范文本) 前 16 位（内容寻址，与 spill 文件名同族） */
export function promptHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/** 规范化：剥掉恰一个结尾换行（文件体带尾换行入库，内存规范文本不带） */
function canonicalize(raw: string): string {
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw
}

export interface PromptResource {
  name: string
  /** 规范文本（= 运行期使用的 system prompt） */
  text: string
  hash: string
}

/** 可注入的注册表（测试造 mini 捆绑源；默认读捆绑资源） */
export interface PromptRegistry {
  /** 读内置规范文本；缺文件 throw（捆绑资源缺失属打包 bug，显式暴露） */
  readBuiltin(name: string): string
  /** 版本表 { 文件名: 哈希时间序数组 } */
  versions(): Record<string, string[]>
}

const DEFAULT_REGISTRY: PromptRegistry = {
  readBuiltin(name: string): string {
    const raw = readFileSync(bundledResource('prompts', `${name}.md`), 'utf8')
    return canonicalize(raw)
  },
  versions(): Record<string, string[]> {
    return JSON.parse(readFileSync(bundledResource('prompts', 'versions.json'), 'utf8')) as Record<string, string[]>
  },
}

const builtinCache = new Map<string, PromptResource>()

/** 读内置 prompt（默认 registry 缓存；注入的测试 registry 不缓存，防串台）；缺文件 throw */
export function loadBuiltinPrompt(name: string, registry: PromptRegistry = DEFAULT_REGISTRY): PromptResource {
  if (registry !== DEFAULT_REGISTRY) {
    const text = registry.readBuiltin(name)
    return { name, text, hash: promptHash(text) }
  }
  const hit = builtinCache.get(name)
  if (hit) return hit
  const text = registry.readBuiltin(name)
  const res: PromptResource = { name, text, hash: promptHash(text) }
  builtinCache.set(name, res)
  return res
}

/** 内置 prompt 名单（versions.json 键，去 .md） */
export function builtinPromptNames(registry: PromptRegistry = DEFAULT_REGISTRY): string[] {
  return Object.keys(registry.versions()).map((f) => f.replace(/\.md$/, ''))
}

/** 用户覆盖文件路径 */
export function overlayPath(userDataPath: string, name: string): string {
  return join(userDataPath, 'prompts', `${name}.md`)
}

/** R75-A-P3b（批 A）：读 overlay 正文——existsSync 与 readFileSync 之间文件被删/被换成
 *  目录（TOCTOU）时，裸 ENOENT/EISDIR 会直冒 runSpec 无从定位。收编为带上下文的明确
 *  错误（文件名 + 操作）；fail-fast 语义不变（仍抛，不静默回落内置——「读失败」与
 *  「无 overlay」语义不同，静默回落会让用户的覆盖改动无声失效）。 */
function readOverlaySync(fp: string): string {
  try {
    return readFileSync(fp, 'utf8')
  } catch (e) {
    throw new Error(`读取用户覆盖 prompt 失败（${fp}）：${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 解析生效 prompt：overlay 存在优先（用户主权），否则内置 */
export function resolvePrompt(
  name: string,
  userDataPath?: string,
  registry: PromptRegistry = DEFAULT_REGISTRY,
): { text: string; hash: string; source: 'builtin' | 'overlay' } {
  if (userDataPath) {
    const fp = overlayPath(userDataPath, name)
    // R75-A-P3b：读取经收编助手（见其注释），存在性判定与读取之间被删 → 带路径上下文抛错
    if (existsSync(fp)) {
      const text = canonicalize(readOverlaySync(fp))
      return { text, hash: promptHash(text), source: 'overlay' }
    }
  }
  const b = loadBuiltinPrompt(name, registry)
  return { text: b.text, hash: b.hash, source: 'builtin' }
}

export interface MigrateReport {
  /** 哈希命中历史（未改动的内置拷贝）→ 已升级为当前内置 */
  upgraded: string[]
  /** 哈希不在历史（用户改过）→ 原样保留 */
  kept: string[]
}

/**
 * overlay 升级迁移（A6：内置 prompt 升级不覆盖用户改动）。
 * 逐个内置名检查 overlay：哈希 ∈ 该文件历史哈希 → 覆写为当前内置（已当前版则跳过写盘）；
 * 否则不动。无 overlay 的名字不参与。
 */
export function migratePromptOverlays(
  userDataPath: string,
  registry: PromptRegistry = DEFAULT_REGISTRY,
): MigrateReport {
  const report: MigrateReport = { upgraded: [], kept: [] }
  const versions = registry.versions()
  for (const file of Object.keys(versions)) {
    const name = file.replace(/\.md$/, '')
    const fp = overlayPath(userDataPath, name)
    if (!existsSync(fp)) continue
    // R27-132（二十七轮）：单 overlay 读异常（TOCTOU 被删/被目录占位/EACCES）不再中断
    // 整轮升级——读经 R75-A-P3b 收编助手拿带路径上下文的错误，逐文件 try/catch warn
    // 跳过继续，对齐 v2/v3 迁移「单条目失败不拖死同轮其余条目」的容错口径
    let hash: string
    try {
      hash = promptHash(canonicalize(readOverlaySync(fp)))
    } catch (e) {
      log.warn('migrate-prompts', `prompt overlay 读取失败，跳过该文件继续升级：${e instanceof Error ? e.message : String(e)}`)
      continue
    }
    if (!versions[file]!.includes(hash)) {
      report.kept.push(name)
      continue
    }
    const builtin = loadBuiltinPrompt(name, registry)
    if (hash === builtin.hash) continue
    mkdirSync(join(userDataPath, 'prompts'), { recursive: true })
    // 第五轮：走原子写（P1-6A 全仓纪律）——直写半截崩溃后哈希不命中历史表，
    // 损坏的 overlay 会被当「用户改过」永久保留
    atomicWriteFile(fp, builtin.text + '\n')
    report.upgraded.push(name)
  }
  return report
}

/** 哈希精确匹配：文本命中任一内置文件的任一历史哈希 → 返回内置名；否则 null */
export function matchBuiltinPrompt(text: string, registry: PromptRegistry = DEFAULT_REGISTRY): string | null {
  const hash = promptHash(text)
  for (const [file, hashes] of Object.entries(registry.versions())) {
    if (hashes.includes(hash)) return file.replace(/\.md$/, '')
  }
  return null
}

/**
 * runner 入口：systemPrompt 若是某内置 prompt 的（任意历史版本）原文，
 * 换成 overlay/当前内置——旧版内置文本在运行期自动升级，用户 overlay 优先。
 * 非内置文本原样返回（chat 等动态 prompt 零影响）。
 * R69-9（十七轮）：带源版本（resolveBuiltinSystemPromptSourced）额外透出 overlay 命中
 * 的绝对路径——runSpec 据此把 overlay 注入源登记进 promptFiles（铁律①「模型可见⟺已
 * 记录」：overlay 是可变文件，仅入哈希不可重建，与 Y-2 rules 注入段同性质同登记）。
 */
export function resolveBuiltinSystemPromptSourced(
  systemPrompt: string | undefined,
  userDataPath?: string,
  registry: PromptRegistry = DEFAULT_REGISTRY,
): { text: string | undefined; overlayFile?: string } {
  if (systemPrompt === undefined) return { text: undefined }
  const name = matchBuiltinPrompt(systemPrompt, registry)
  if (name === null) return { text: systemPrompt }
  if (userDataPath) {
    const fp = overlayPath(userDataPath, name)
    // R75-A-P3b：同 resolvePrompt——exists→read 间隙被删时收编为带路径上下文的明确错误
    if (existsSync(fp)) {
      return { text: canonicalize(readOverlaySync(fp)), overlayFile: fp }
    }
  }
  return { text: loadBuiltinPrompt(name, registry).text }
}

export function resolveBuiltinSystemPrompt(
  systemPrompt: string | undefined,
  userDataPath?: string,
  registry: PromptRegistry = DEFAULT_REGISTRY,
): string | undefined {
  if (systemPrompt === undefined) return systemPrompt
  const name = matchBuiltinPrompt(systemPrompt, registry)
  if (name === null) return systemPrompt
  return resolvePrompt(name, userDataPath, registry).text
}
