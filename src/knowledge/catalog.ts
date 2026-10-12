/**
 * 知识层篇目注册表——「知识层有哪些篇」的唯一定义处。
 *
 * 三面装配器（写稿选材 / 三审 lens 映射 / 对话类目选篇）与 CI 门一律从这里取篇目：
 * 篇目常量不再寄居任何一面的装配器里，避免「一处定义、多处反向引用」。
 *
 * 条目按**现行事实**声明（随包语料实态）：
 * - `faces`：该篇实际被哪些注入面消费；空数组 = 不下发，原因记 `note`；
 * - `purpose`：篇目角色（判断类知识 / 许可件 / 目录索引）；
 * - 消费策略（选材优先级 / lens 映射 / 帽值）留在各面装配器，不入本档。
 *
 * `category` = 目录名（目录即分类，运行时不再读 manifest）；与 `rel` 的
 * 一级目录段恒等，两个字段不一致即条目自相矛盾。
 *
 * 分类轴 = 体裁档（通用 / 长篇 / 短篇；一篇只属一档）；注入面不进目录名。
 */

/** 篇目角色：judgment = 判断类知识（供模型参考）；license = 许可/署名件；index = 目录索引 */
export type CorpusPurpose = 'judgment' | 'license' | 'index'

/** 注入面：写稿 / 三审 / 对话 */
export type InjectionFace = 'draft' | 'review' | 'chat'

export interface CatalogEntry {
  /** `<类目>/<篇>.md`，与书级 知识层/ 及随包 resources/knowledge/ 同构 */
  rel: string
  category: string
  purpose: CorpusPurpose
  /** 注入面；空 = 不下发（purpose/note 记原因） */
  faces: readonly InjectionFace[]
  /** 不下发或特殊处置的原因（人话） */
  note?: string
}

// ── 篇目常量（rel 的单源定义；各面策略表与测试从这里取，不重抄字面量）──

/** 通用档 9 篇 */
export const GENERAL_FILE_PLOT = '通用/情节推演速查.md'
export const GENERAL_FILE_CONFLICT = '通用/冲突结构速查.md'
export const GENERAL_FILE_CHARACTER = '通用/人物设计速查.md'
export const GENERAL_FILE_RELATIONS = '通用/人物关系速查.md'
export const GENERAL_FILE_DIALOGUE = '通用/对话技法速查.md'
export const GENERAL_FILE_EMOTION = '通用/情绪弧线速查.md'
export const GENERAL_FILE_CRAFT = '通用/写作技法速查.md'
export const GENERAL_FILE_READERS = '通用/读者与平台速查.md'
export const GENERAL_FILE_QUALITY = '通用/质量清单速查.md'

/** 长篇档 10 篇 */
export const LONG_FILE_HOOKS = '长篇/章节钩子速查.md'
export const LONG_FILE_REVERSAL = '长篇/反转机制速查.md'
export const LONG_FILE_SUSPENSE = '长篇/悬念编排速查.md'
export const LONG_FILE_RHYTHM = '长篇/节奏与升级感速查.md'
export const LONG_FILE_EMOTION = '长篇/情绪引擎速查.md'
export const LONG_FILE_CORE = '长篇/核心梗与卖点速查.md'
export const LONG_FILE_OPENING = '长篇/开篇设计速查.md'
export const LONG_FILE_OUTLINE = '长篇/大纲方法速查.md'
export const LONG_FILE_GENRE = '长篇/题材框架速查.md'
export const LONG_FILE_QUALITY = '长篇/质量清单速查.md'

/** 短篇档 7 篇 */
export const SHORT_FILE_HOOKS = '短篇/章节钩子速查.md'
export const SHORT_FILE_PARAGRAPH = '短篇/段落钩子速查.md'
export const SHORT_FILE_REVERSAL = '短篇/反转机制速查.md'
export const SHORT_FILE_SUSPENSE = '短篇/悬念编排速查.md'
export const SHORT_FILE_EMOTION = '短篇/情绪释放速查.md'
export const SHORT_FILE_GENRE = '短篇/题材公式速查.md'
export const SHORT_FILE_QUALITY = '短篇/质量清单速查.md'

/** 许可件 */
export const LICENSE_FILE_MIT = '许可/oh-story-claudecode-MIT.md'

/** 体裁档专属类目名 → 书档位（类目轴的单源映射，见本档头注「分类轴」） */
const REGISTER_CATEGORY_KIND: Readonly<Record<string, 'long' | 'short'>> = { 长篇: 'long', 短篇: 'short' }

/**
 * 类目名 → 体裁档位：`长篇`/`短篇` 是档位专属类目；其余（`通用` / 书级自建类目）
 * 跨档共用，返回 `undefined`。
 *
 * 消费面 = 作业包 `references` 的按档过滤（作业包可同时声明两档的引用篇，取用时只嵌
 * 本书本档的；见 `src/process/skills.ts`）。映射落在这里而非各调用方：类目轴改名时
 * 各面各写一份就会静默分叉。
 */
export function registerKindOfCategory(category: string): 'long' | 'short' | undefined {
  return REGISTER_CATEGORY_KIND[category]
}

/**
 * 通用档篇目（跨体裁共用的判断类知识）。
 *
 * `faces` 按现行消费面声明：对话面吃全部 9 篇（**声明序即选篇优先级**）；写稿面
 * 按章信号追加「人物 / 对话」两篇；三审编辑视角吃质量清单。不虚报未接线的面
 * （`faces` 是各面实际消费的事实陈述，不是意图登记）。
 */
export const GENERAL_CATALOG: readonly CatalogEntry[] = [
  { rel: GENERAL_FILE_PLOT, category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: GENERAL_FILE_CONFLICT, category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: GENERAL_FILE_CHARACTER, category: '通用', purpose: 'judgment', faces: ['chat', 'draft'] },
  { rel: GENERAL_FILE_RELATIONS, category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: GENERAL_FILE_DIALOGUE, category: '通用', purpose: 'judgment', faces: ['chat', 'draft'] },
  { rel: GENERAL_FILE_EMOTION, category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: GENERAL_FILE_CRAFT, category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: GENERAL_FILE_READERS, category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: GENERAL_FILE_QUALITY, category: '通用', purpose: 'judgment', faces: ['chat', 'review'] },
]

/** 长篇档篇目（连载语境的判断类知识；写稿面按 kind 选材 + 三审视角技法） */
export const LONG_CATALOG: readonly CatalogEntry[] = [
  { rel: LONG_FILE_HOOKS, category: '长篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: LONG_FILE_REVERSAL, category: '长篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: LONG_FILE_SUSPENSE, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_RHYTHM, category: '长篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: LONG_FILE_EMOTION, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_CORE, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_OPENING, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_OUTLINE, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_GENRE, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_QUALITY, category: '长篇', purpose: 'judgment', faces: ['review'] },
]

/**
 * 短篇档篇目（单篇闭口语境的判断类知识）。
 *
 * 反转机制是写稿面基础篇（短篇的核心是反转）；三审在短篇书下另跑
 * 钩子 / 情绪反转 / 设定收尾三视角，各取对口篇。
 */
export const SHORT_CATALOG: readonly CatalogEntry[] = [
  { rel: SHORT_FILE_HOOKS, category: '短篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: SHORT_FILE_PARAGRAPH, category: '短篇', purpose: 'judgment', faces: ['draft'] },
  { rel: SHORT_FILE_REVERSAL, category: '短篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: SHORT_FILE_SUSPENSE, category: '短篇', purpose: 'judgment', faces: ['draft'] },
  { rel: SHORT_FILE_EMOTION, category: '短篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: SHORT_FILE_GENRE, category: '短篇', purpose: 'judgment', faces: ['draft'] },
  { rel: SHORT_FILE_QUALITY, category: '短篇', purpose: 'judgment', faces: ['review'] },
]

/**
 * 随包篇目注册表（**顺序 = 对话面选篇优先级**）。
 *
 * 通用档在前（对话面按通用 → 体裁专属取帽内前 N）；许可件随包留存即满足 MIT
 * 署名，不播种进书库、三面均不消费。
 */
export const BUNDLED_CATALOG: readonly CatalogEntry[] = [
  ...GENERAL_CATALOG,
  ...LONG_CATALOG,
  ...SHORT_CATALOG,
  {
    rel: LICENSE_FILE_MIT,
    category: '许可',
    purpose: 'license',
    faces: [],
    note: 'MIT 署名件：随包留存即满足署名，不播种进书库',
  },
]
