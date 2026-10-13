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

/** 题材卡类目名（卡目录；一张一类题材，目录名与 rel 一级段恒等） */
export const GENRE_CATEGORY = '题材'

/**
 * 题材卡名（32 张；rel 由类目 + 卡名派生）。
 *
 * 卡名即题材名，别名声明在各卡 front matter 的 `aliases`（命中判据不在本档——
 * 本档只声明「有哪些卡」，判据数据随卡文件走，改题材名不必回来改这里）。
 */
const GENRE_CARD_NAMES: readonly string[] = [
  '东方仙侠',
  '传统玄幻',
  '历史古代',
  '历史脑洞',
  '双男主',
  '古言脑洞',
  '古风世情',
  '女频悬疑',
  '女频种田',
  '宫斗宅斗',
  '年代',
  '快穿',
  '悬疑灵异',
  '悬疑脑洞',
  '战神赘婿',
  '抗战谍战',
  '星光璀璨',
  '民国言情',
  '游戏体育',
  '玄幻脑洞',
  '玄幻言情',
  '现言脑洞',
  '科幻末世',
  '职场婚恋',
  '西方奇幻',
  '豪门总裁',
  '都市修真',
  '都市日常',
  '都市种田',
  '都市脑洞',
  '都市高武',
  '青春甜宠',
]

/**
 * 题材卡（写稿面按书题材命中下发，非全量注入）。
 *
 * `faces: ['draft']` 是「本卡可被写稿面消费」的事实陈述——命中是条件式的
 * （`book.genre ∈ 卡 aliases`，≤2 张；判据与召回见 `knowledge/genre.ts`），
 * 与「通用质量清单按帽内序被对话面取用」同族：faces 声明消费面，不声明必下发。
 */
export const GENRE_CATALOG: readonly CatalogEntry[] = GENRE_CARD_NAMES.map((name) => ({
  rel: `${GENRE_CATEGORY}/${name}.md`,
  category: GENRE_CATEGORY,
  purpose: 'judgment' as const,
  faces: ['draft'] as const,
  note: '写稿面按书题材命中召回（book.genre ∈ 卡 aliases，至多 2 张）',
}))

/** 去味判断篇（判断面语料；改稿链尚未接运行时注入，故 `faces: []`） */
export const DESLOP_FILE_AI_TASTE = '去味/去AI味判断速查.md'
export const DESLOP_FILE_STYLE_FORMAT = '去味/文风与格式速查.md'

/**
 * 去味判断篇（两篇，判断面——判定面在代码：词表与正则见 `src/check/ai-patterns.ts`，
 * 格式机检见 `src/check/body-format.ts`；两侧互指注释在位）。
 *
 * `faces: []`：改稿链（self-heal/rewrite）当前只在 system prompt 带词表约束，
 * 尚未接运行时语料注入——两篇先以判断面正本与作者参照在位，接线归后续批
 * （`faces` 是实际消费面的事实陈述，不虚报未接线的面）。
 */
export const DESLOP_CATALOG: readonly CatalogEntry[] = [
  {
    rel: DESLOP_FILE_AI_TASTE,
    category: '去味',
    purpose: 'judgment',
    faces: [],
    note: '去 AI 味的判断面；判定面（词表/正则）在 src/check/ai-patterns.ts，改稿链尚未接运行时注入',
  },
  {
    rel: DESLOP_FILE_STYLE_FORMAT,
    category: '去味',
    purpose: 'judgment',
    faces: [],
    note: '文风与格式的判断面；判定面（格式机检）在 src/check/body-format.ts，改稿链尚未接运行时注入',
  },
]

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
  { rel: LONG_FILE_SUSPENSE, category: '长篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: LONG_FILE_RHYTHM, category: '长篇', purpose: 'judgment', faces: ['draft', 'review'] },
  { rel: LONG_FILE_EMOTION, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_CORE, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_OPENING, category: '长篇', purpose: 'judgment', faces: ['draft'] },
  { rel: LONG_FILE_OUTLINE, category: '长篇', purpose: 'judgment', faces: ['draft', 'review'] },
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
 * 署名，不播种进书库、三面均不消费；题材卡按书题材命中下发（不进对话面候选）。
 */
export const BUNDLED_CATALOG: readonly CatalogEntry[] = [
  ...GENERAL_CATALOG,
  ...LONG_CATALOG,
  ...SHORT_CATALOG,
  ...GENRE_CATALOG,
  ...DESLOP_CATALOG,
  {
    rel: LICENSE_FILE_MIT,
    category: '许可',
    purpose: 'license',
    faces: [],
    note: 'MIT 署名件：随包留存即满足署名，不播种进书库',
  },
]
