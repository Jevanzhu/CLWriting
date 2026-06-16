/**
 * M1 格式层内存模型 —— 所有 md ↔ 内存 ↔ 缓存映射的类型基础。
 *
 * 设计依据：
 * - ③ 账本格式 spec（七类 front matter + 履历）
 * - ④ 缓存表 DDL spec（中英 key 映射）
 * - ⑤ 文风样章库 spec（样章 front matter）
 * - ⑥ 境界枚举 spec（境界体系嵌套结构）
 * - ⑦ 章节元数据 spec（章 front matter）
 *
 * 约定：内存模型用**中文 key**（对齐作者域 markdown）；映射到缓存时转英文列（sync.ts）。
 */

// ── 账本（③ 第 3-6 节）──────────────────────────

/** 账本七类（③ 第 5 节） */
export type LeadType =
  | '伏笔'
  | '悬念'
  | '感情线'
  | '局线'
  | '设定线'
  | '成长线'
  | '关系债'

/** 账本三态（③ 第 5 节，磁盘中文 ↔ 机器语义） */
export type LeadStatus = '进行中' | '已收尾' | '已放弃'

/** 履历行（③ 第 4 节）：- 第N章 动词：章内证据 */
export interface LeadEntry {
  章号: number
  动词: string // 按类型取（③ 第 5 节动词表）
  证据: string // 章内证据，须在该章正文 grep 命中
  回填?: boolean // 显式回填例外（③ 第 4 节），章号机检放行
}

/** 账本条目内存模型（③ 第 3-6 节，七类统一 + 各类特化字段可选） */
export interface Lead {
  // 通用必填（③ 第 3 节）
  编号: string // 主键，类型-三位序号
  标题: string
  类型: LeadType
  状态: LeadStatus
  开启章: number
  履历: LeadEntry[]

  // 特化字段（⑥/③ 第 6 节，仅对应类型出现）
  境界体系?: string // 成长线（⑥ 第 3 节）
  当前境界?: string // 成长线
  父局线?: string // 局线（③ 第 6.2 节，局中局）
  欠方?: string // 关系债（③ 第 6.3 节）
  债主?: string // 关系债

  // 容错：未知字段原样保留（③ 第 8 节）
  _raw?: Record<string, string>
  /** 源 md 路径（重建时回填，非 front matter 字段） */
  _path?: string
}

// ── 章节元数据（⑦ 第 2 节）──────────────────────

/** 钩子类型（⑦ 第 3 节，追读力 5 类） */
export type HookType = '危机钩' | '悬念钩' | '渴望钩' | '情绪钩' | '选择钩'

/** 钩子强弱 */
export type HookLevel = '强' | '中' | '弱'

/** 情绪定位（⑦ 第 3 节） */
export type Emotion = '压抑' | '铺垫' | '小爽' | '大爽' | '转折'

/** 章节元数据（⑦ 第 2 节，正文 front matter） */
export interface ChapterMeta {
  章号: number
  标题: string
  钩子类型: HookType
  钩子强弱: HookLevel
  情绪定位: Emotion
  时间锚点?: string // 可选（⑦ 第 2 节）
  _raw?: Record<string, string>
  _path?: string
  _wordCount?: number // 机检算的派生（⑦ 第 2 节，不入 front matter）
}

// ── 文风样章（⑤ 第 4 节）────────────────────────

/** 样章来源（⑤ 第 6 节） */
export type SampleSource = '作者原作' | '题材范文' | '导入'

/** 文风样章（⑤ 第 4 节） */
export interface StyleSample {
  场景: string
  来源: SampleSource
  出处?: string // 可选
  标签?: string[] // 可选，内联数组
  正文: string // 样章本身（front matter 之后的正文）
  _raw?: Record<string, string>
  _path?: string
}

// ── 境界枚举（⑥ 第 2 节）────────────────────────

/** 境界体系（⑥ 第 2 节） */
export interface RealmSystem {
  名称: string
  序列: string[] // 索引即高低（0 最低）
}

/** 境界体系.md 的结构（⑥ 第 2 节） */
export interface RealmDoc {
  体系: RealmSystem[]
  /** 正文（人话说明，不参与机检） */
  正文?: string
  _path?: string
}

// ── book.yaml（⑨ 第 2 节）───────────────────────

/** book.yaml 配置（⑨ 第 2 节，机器域英文 key） */
export interface BookConfig {
  spec_version: number
  book: {
    title: string
    genre: string
  }
  leads: {
    enabled: string[] // 启用的扩展类（基础三类恒启用、不列）
    thresholds?: Record<string, number> // 各类「悬太久」阈值覆盖
  }
  budget: {
    calls_per_chapter: number
    input_per_chapter?: number
    summary_chapter_max?: number
    summary_volume_max?: number
  }
  style: {
    injection: 'light' | 'heavy'
  }
  auto: {
    confirm_outline: boolean
    batch_size: number
  }
  growth: {
    realm_span_max?: number // 跃迁跨度上限（O1，⑥）
  }
  _raw?: Record<string, unknown> // 容错：未知顶层段保留
}

// ── 解析错误（③ 第 8 节，容错不崩）──────────────

/** 结构化解析错误（不抛异常，返回给调用方走「修复确认」） */
export interface ParseError {
  file: string
  line: number
  message: string
}
