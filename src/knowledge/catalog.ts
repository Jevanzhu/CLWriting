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

/** 内置语料相对路径（镜像 知识层/ 的目录结构；两处同构 = 对账门可按 rel 直接比对） */
export const METHOD_FILE_HOOKS = '追读力/章节钩子速查.md'
export const METHOD_FILE_REVERSAL = '爽点/反转设计速查.md'
export const METHOD_FILE_RHYTHM = '追读力/节奏与升级感速查.md'
export const METHOD_FILE_CHARACTER = '方法论/人物与对话技法速查.md'

/**
 * 通用档篇目（语料重建批落地的 9 篇，改写自 oh-story 上游 v0.8.5）。
 *
 * `faces` 现只声明 `chat`——对话面按 catalog 声明序取篇；写稿面与三审面的选材表
 * 仍指旧 rel（`追读力/`、`爽点/`、`方法论/`），其重声明归后续批，届时本组 `faces` 扩容。
 * 现在不虚报 `draft`/`review`：`faces` 是「各面实际消费」的事实陈述，不是意图登记。
 *
 * **声明序即对话面选篇优先级**（帽内取前 N）；后续批扩容时新篇追加在末尾。
 */
export const GENERAL_CATALOG: readonly CatalogEntry[] = [
  { rel: '通用/情节推演速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/冲突结构速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/人物设计速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/人物关系速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/对话技法速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/情绪弧线速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/写作技法速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/读者与平台速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
  { rel: '通用/质量清单速查.md', category: '通用', purpose: 'judgment', faces: ['chat'] },
]

/**
 * 随包篇目注册表（**顺序 = 对话面选篇优先级**）：
 * - 通用 9 篇（`GENERAL_CATALOG`）：对话面消费；
 * - 四篇旧选材篇：写稿（基础篇 / 信号追加篇）与三审（lens 映射）消费；其对话面角色
 *   已由通用档后继篇接替（人物与对话 → 人物设计 + 对话技法），故不再声明 `chat`；
 * - 质量检查清单速查：判断类知识，已吸收进三审 prompt 基线，不再下发；
 * - 题材路由速查：判断类知识，建书/大纲面未接线，暂不下发；
 * - 许可件：随包留存即满足署名，不播种进书库、三面均不消费。
 */
export const BUNDLED_CATALOG: readonly CatalogEntry[] = [
  ...GENERAL_CATALOG,
  {
    rel: METHOD_FILE_HOOKS,
    category: '追读力',
    purpose: 'judgment',
    faces: ['draft', 'review'],
  },
  {
    rel: METHOD_FILE_REVERSAL,
    category: '爽点',
    purpose: 'judgment',
    faces: ['draft', 'review'],
  },
  {
    rel: METHOD_FILE_RHYTHM,
    category: '追读力',
    purpose: 'judgment',
    faces: ['draft', 'review'],
  },
  {
    rel: METHOD_FILE_CHARACTER,
    category: '方法论',
    purpose: 'judgment',
    faces: ['draft', 'review'],
    note: '对话面角色已由通用档「人物设计速查 + 对话技法速查」接替',
  },
  {
    rel: '方法论/质量检查清单速查.md',
    category: '方法论',
    purpose: 'judgment',
    faces: [],
    note: '已吸收进三审 prompt 基线，不再下发',
  },
  {
    rel: '题材/题材路由速查.md',
    category: '题材',
    purpose: 'judgment',
    faces: [],
    note: '建书/大纲面未接线，暂不下发',
  },
  {
    rel: '许可/oh-story-claudecode-MIT.md',
    category: '许可',
    purpose: 'license',
    faces: [],
    note: 'MIT 署名件：随包留存即满足署名，不播种进书库',
  },
]
