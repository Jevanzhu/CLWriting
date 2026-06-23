/**
 * M1 格式层内存模型 —— 所有 md ↔ 内存 ↔ 缓存映射的类型基础。
 *
 * 设计依据：
 * - #3 账本格式 spec（七类 front matter + 履历）
 * - #4 缓存表 DDL spec（中英 key 映射）
 * - #5 文风样章库 spec（样章 front matter）
 * - #6 境界枚举 spec（境界体系嵌套结构）
 * - #7 章节元数据 spec（章 front matter）
 *
 * 约定：内存模型用**中文 key**（对齐作者域 markdown）；映射到缓存时转英文列（sync.ts）。
 */

// ── 账本（#3 第 3-6 节）──────────────────────────

/** 账本七类（#3 第 5 节） */
export type LeadType =
  | '伏笔'
  | '悬念'
  | '感情线'
  | '局线'
  | '设定线'
  | '成长线'
  | '关系债'

/** 账本三态（#3 第 5 节，磁盘中文 ↔ 机器语义） */
export type LeadStatus = '进行中' | '已收尾' | '已放弃'

/** 履历行（#3 第 4 节）：- 第N章 动词：章内证据 */
export interface LeadEntry {
  章号: number
  动词: string // 按类型取（#3 第 5 节动词表）
  证据: string // 章内证据，须在该章正文 grep 命中
  回填?: boolean // 显式回填例外（#3 第 4 节），章号机检放行
}

/** 账本条目内存模型（#3 第 3-6 节，七类统一 + 各类特化字段可选） */
export interface Lead {
  // 通用必填（#3 第 3 节）
  编号: string // 主键，类型-三位序号
  标题: string
  类型: LeadType
  状态: LeadStatus
  开启章: number
  履历: LeadEntry[]

  // 特化字段（#6/#3 第 6 节，仅对应类型出现）
  境界体系?: string // 成长线（#6 第 3 节）
  当前境界?: string // 成长线
  父局线?: string // 局线（#3 第 6.2 节，局中局）
  欠方?: string // 关系债（#3 第 6.3 节）
  债主?: string // 关系债

  // 容错：未知字段原样保留（#3 第 8 节）
  _raw?: Record<string, string>
  /** 履历段前的人工说明正文（如人物/设定简介），回写时保留 */
  _bodyBeforeHistory?: string
  /** 源 md 的 front matter 字段顺序（回写保序用，#3 第 8 节"不重排已有字段顺序"） */
  _fmOrder?: string[]
  /** 源 md 路径（重建时回填，非 front matter 字段） */
  _path?: string
}

// ── 章节元数据（#7 第 2 节）──────────────────────

/** 钩子类型（#7 第 3 节，追读力 5 类） */
export type HookType = '危机钩' | '悬念钩' | '渴望钩' | '情绪钩' | '选择钩'

// ── 短篇正文元数据（M8 #27，单篇爆破力目标函数）──

/**
 * 短篇正文 front matter（M8 #27 第 6 节，最小字段集）。
 *
 * 短篇目标函数是「单篇情绪爆破」，与长篇 ChapterMeta（钩子/情绪定位追读力向）字段不重合。
 * 落点：篇/<篇号>-<标题>/正文.md（与长篇 定稿/正文/<章号>-<标题>.md 分轨，读写函数分轨对齐）。
 */
export interface PieceMeta {
  篇号: number
  标题: string
  /** 目标情绪（P1 拍板，情绪是短篇目标函数） */
  目标情绪?: string
  /** 核心反转（P1 拍板，一反转撑全篇） */
  核心反转?: string
  _raw?: Record<string, string>
  _path?: string
  /** 机检算的字数派生（不入 front matter） */
  _wordCount?: number
}

// ── 单篇清单（M8 #27，账本降级：反转线索表 + 伏笔回收）──

/** 反转线索表的铺垫点（结构物件三现，吸收点 7.4） */
export interface SetupPoint {
  位置: string
  内容: string
}

/** 反转线索表（核心反转 + ≥3 铺垫点，反转可回溯） */
export interface ReversalLead {
  核心反转: string
  铺垫点: SetupPoint[]
}

/** 伏笔回收条目（单篇内闭合，弃坑 = 阻断） */
export interface PayoffEntry {
  伏笔: string
  回收位置: string
  /** 未回收标记（机检形式检 / 设定收尾审语义核对） */
  未回收?: boolean
}

/** 情绪曲线点（短篇单篇爆破力：每段情绪与强度） */
export interface EmotionCurvePoint {
  段落: string
  情绪: string
  /** 1-10，反转峰值/余韵由机检与三审共同核对 */
  强度: number
  说明?: string
}

/**
 * 单篇清单（M8 #27 第 4 节）。
 * 范围限单篇、写完即归档；复用账本格式骨架降级，无跨篇长程线。
 * 落点：篇/<篇号>-<标题>/清单.md。
 */
export interface PieceList {
  反转线索表: ReversalLead
  情绪曲线?: EmotionCurvePoint[]
  伏笔回收: PayoffEntry[]
  _raw?: Record<string, string>
  _path?: string
}

/** 钩子强弱 */
export type HookLevel = '强' | '中' | '弱'

/** 情绪定位（#7 第 3 节） */
export type Emotion = '压抑' | '铺垫' | '小爽' | '大爽' | '转折'

/** 章节元数据（#7 第 2 节，正文 front matter） */
export interface ChapterMeta {
  章号: number
  标题: string
  钩子类型: HookType
  钩子强弱: HookLevel
  情绪定位: Emotion
  时间锚点?: string // 可选（#7 第 2 节）
  _raw?: Record<string, string>
  _path?: string
  _wordCount?: number // 机检算的派生（#7 第 2 节，不入 front matter）
}

// ── 文风样章（#5 第 4 节）────────────────────────

/** 样章来源（#5 第 6 节） */
export type SampleSource = '作者原作' | '题材范文' | '导入'

/** 文风样章（#5 第 4 节） */
export interface StyleSample {
  场景: string
  来源: SampleSource
  出处?: string // 可选
  标签?: string[] // 可选，内联数组
  技法指令?: string // 可选：注入时提示重点学什么（M1 #5 新增吸收点）
  正文: string // 样章本身（front matter 之后的正文）
  _raw?: Record<string, string>
  _path?: string
}

// ── 境界枚举（#6 第 2 节）────────────────────────

/** 境界体系（#6 第 2 节） */
export interface RealmSystem {
  名称: string
  序列: string[] // 索引即高低（0 最低）
}

/** 境界体系.md 的结构（#6 第 2 节） */
export interface RealmDoc {
  体系: RealmSystem[]
  /** 正文（人话说明，不参与机检） */
  正文?: string
  _path?: string
}

// ── book.yaml（#9 第 2 节）───────────────────────

/** book.yaml 配置（#9 第 2 节，机器域英文 key） */
export interface BookConfig {
  spec_version: number
  /** 双轨标识（M8 #25）：long（缺省，长篇）/ short（短篇集）。缺省 = long，现有仓库零改动 */
  kind?: 'long' | 'short'
  /** AI 宿主（决策 12/22）：cc（缺省，Claude Code）/ codex。首版只 cc */
  host?: 'cc' | 'codex'
  book: {
    title: string
    genre: string
    volume_size?: number
    /** 全书/整集目标字数（决策 14）；完成度 = 已写字数 / target_words */
    target_words?: number
  }
  leads: {
    enabled: string[] // 启用的扩展类（基础三类恒启用、不列）
    thresholds?: Record<string, number> // 各类「悬太久」阈值覆盖
  }
  budget: {
    /** 长篇为每章调用上限；kind: short 时按每篇调用上限解释。 */
    calls_per_chapter: number
    input_per_chapter?: number
    summary_chapter_max?: number
    summary_volume_max?: number
  }
  style: {
    injection: 'light' | 'heavy'
  }
  /** 短篇集专属配置；长篇缺省忽略 */
  short?: {
    /** 短篇平台/栏目画像；用于 health --report 给出集级策划提示 */
    profile?: string
    /** 画像目标情绪池；用于策划视图判断缺口 */
    target_emotions?: string[]
    /** 画像目标反转类型池；用于策划视图判断缺口 */
    target_reversal_types?: string[]
    /** 画像目标结尾味道池；用于策划视图判断缺口 */
    target_ending_flavors?: string[]
    /** 轻量跨篇母题；只做整集提示，不引入长篇账本 */
    series_motifs?: string[]
    strict?: boolean
    /** 短篇总字数下限；缺省 8000 */
    word_min?: number
    /** 短篇总字数上限；缺省 20000 */
    word_max?: number
    /** 单个身体部位词允许出现次数；缺省 5 */
    body_part_threshold?: number
    /** 「像」字比喻密度阈值；缺省 10 */
    simile_threshold?: number
    /** 期望正文结构节数；缺省 5 */
    section_count?: number
    /** 开头零环境检查的前 N 字；缺省 300 */
    opening_env_chars?: number
  }
  auto: {
    confirm_outline: boolean
    batch_size: number
  }
  growth: {
    realm_span_max?: number // 跃迁跨度上限（O1，#6）
  }
  /** RAG 可选插件配置（#37，非密段；api_key 不入此、不入 git） */
  rag?: {
    enabled: boolean
    endpoint?: string // embedding 端点 base_url（非密）
    model?: string // embedding 模型名（非密）
  }
  _raw?: Record<string, unknown> // 容错：未知顶层段保留
}

// ── 解析错误（#3 第 8 节，容错不崩）──────────────

/** 结构化解析错误（不抛异常，返回给调用方走「修复确认」） */
export interface ParseError {
  file: string
  line: number
  message: string
}
