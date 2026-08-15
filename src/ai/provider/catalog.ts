/**
 * 模型参数表目录构建（批次 D1，学 cherry generate-catalog 的 contentVersion 体系）。
 *
 * 唯一真相源 = model-quirks.ts 参数表（含函数维度）。本模块把表**探测成纯数据**：
 * 每系列取代表模型 id，记录全部数据维度 + 函数维度在代表输入下的取值
 * （reasoningEffort×5 档、trimStop×样本）——目录行因此可序列化、可哈希。
 *
 * 三件套闭环：
 * - 源码 = model-quirks.ts（人改这里）
 * - 生成物 = catalog.gen.ts（`npm run generate:catalog` 产出，带 contentVersion 内容哈希）
 * - 双向校验 = test/ai/provider/catalog-sync.test.ts 离线确定性重算比对——
 *   改生成物不改源（手改 .gen）或改源不重新生成，同样失配即红。
 *   cherry 需要两个 CI job 是因其 sync 测试不敢 fetch 上游；我们生成是源的纯函数、
 *   零网络，一个重算测试即覆盖两个方向（不会 flaky）。
 *
 * contentVersion 消费方：A7 表驱动数据入库的 seeder 跳过依据（同内容同版本 → 跳过；
 * 用日期戳则同日重生不成触发，cherry 已踩过——见架构研读 §2.1）。
 */
import { createHash } from 'node:crypto'
import { detectFamily, quirksFor, type FamilyQuirks, type ModelFamily } from './model-quirks.js'
import type { EffortLevel } from './types.js'

/** 全部推理档位（函数维度探测输入） */
const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** trimStop 探测样本（覆盖 null 剥除与裁剪两类行为） */
const TRIM_STOP_SAMPLE: readonly string[] = ['一', '二', '三']

/** 每系列代表模型 id——版本敏感系列（glm/kimi）取双版本，目录行才完整 */
const PROBE_IDS: readonly { model: string; note: string }[] = [
  { model: 'claude-sonnet-5', note: 'Anthropic 原生' },
  { model: 'gpt-5.1', note: 'OpenAI gpt/o 系' },
  { model: 'grok-4', note: 'xAI' },
  { model: 'deepseek-v4', note: 'DeepSeek v4' },
  { model: 'glm-5.2', note: 'GLM 5.2+（effort 支持）' },
  { model: 'glm-4.6', note: 'GLM 4.x（effort 不支持，发则 400）' },
  { model: 'kimi-k3', note: 'Kimi k3（effort 支持）' },
  { model: 'kimi-k2', note: 'Kimi k2.x（采样参数固定）' },
  { model: 'custom-model', note: 'unknown 保守档' },
]

/** 目录行——quirks 表的纯数据投影 */
export interface CatalogRow {
  model: string
  note: string
  family: ModelFamily
  quirks: {
    toolUse: boolean
    toolChoiceMode: FamilyQuirks['toolChoiceMode']
    effortMap?: Partial<Record<EffortLevel, EffortLevel>>
    maxOutputTokens?: number
    maxTokensKey: FamilyQuirks['maxTokensKey']
    thinkingWithEffort: boolean
    emitStreamOptions: boolean
    structuredMode: FamilyQuirks['structuredMode']
    anthropicEffortWire: FamilyQuirks['anthropicEffortWire']
    parallelControl: boolean
    echoReasoning: boolean
    /** 函数维度探测：reasoningEffort 在各档位下的产出（null = 不发） */
    reasoningEffortByLevel: Record<EffortLevel, string | null>
    /** 函数维度探测：trimStop 在样本输入下的产出（null = 不发该参数） */
    trimStopSample: { input: string[]; output: string[] | null }
  }
}

/** 目录体（version 由 contentVersionOf 盖戳，不入体——先算体的哈希再戳） */
export interface ModelCatalog {
  rows: CatalogRow[]
}

/** 从参数表构建目录（纯函数，脚本与同步测试共用） */
export function buildModelCatalog(): ModelCatalog {
  return {
    rows: PROBE_IDS.map(({ model, note }) => {
      const q = quirksFor(model)
      const reasoningEffortByLevel = {} as Record<EffortLevel, string | null>
      for (const lv of EFFORT_LEVELS) reasoningEffortByLevel[lv] = q.reasoningEffort(lv)
      const row: CatalogRow = {
        model,
        note,
        family: detectFamily(model),
        quirks: {
          toolUse: q.toolUse,
          toolChoiceMode: q.toolChoiceMode,
          ...(q.effortMap ? { effortMap: { ...q.effortMap } } : {}),
          ...(q.maxOutputTokens !== undefined ? { maxOutputTokens: q.maxOutputTokens } : {}),
          maxTokensKey: q.maxTokensKey,
          thinkingWithEffort: q.thinkingWithEffort,
          emitStreamOptions: q.emitStreamOptions,
          structuredMode: q.structuredMode,
          anthropicEffortWire: q.anthropicEffortWire,
          parallelControl: q.parallelControl,
          echoReasoning: q.echoReasoning,
          reasoningEffortByLevel,
          trimStopSample: { input: [...TRIM_STOP_SAMPLE], output: q.trimStop([...TRIM_STOP_SAMPLE]) },
        },
      }
      return row
    }),
  }
}

/** 递归按 key 排序的稳定序列化（同内容 ⇒ 同串 ⇒ 同哈希，学 cherry sortKeys） */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** 内容哈希版本 = SHA-256 前 16 位（学 cherry contentVersion；不透明 token，别解析） */
export function contentVersionOf(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex').slice(0, 16)
}
