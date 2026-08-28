/**
 * M1 格式层内存模型 —— 所有 md ↔ 内存 ↔ 缓存映射的类型基础。
 *
 * 设计依据：
 * - #3 账本格式 spec（六类 front matter + 履历；伏笔已独立为设定伏笔系统）
 * - #4 缓存表 DDL spec（中英 key 映射）
 * - #5 文风样章库 spec（样章 front matter）
 * - #6 境界枚举 spec（境界体系嵌套结构）
 * - #7 章节元数据 spec（章 front matter）
 *
 * 约定：内存模型用**中文 key**（对齐作者域 markdown）；映射到缓存时转英文列（sync.ts）。
 */

// ── 账本（#3 第 3-6 节）──────────────────────────

/** 账本六类（伏笔已独立为设定伏笔系统，见 设定/伏笔/） */
export type LeadType =
  | '悬念'
  | '感情线'
  | '布局线'
  | '设定线'
  | '成长线'
  | '关系线'

/** 账本三态（#3 第 5 节，磁盘中文 ↔ 机器语义） */
export type LeadStatus = '进行中' | '已收尾' | '已放弃'

/** 履历行（#3 第 4 节）：- 第N章 动词：章内证据 */
export interface LeadEntry {
  章号: number
  动词: string // 按类型取（#3 第 5 节动词表）
  证据: string // 章内证据，须在该章正文 grep 命中
  回填?: boolean // 显式回填例外（#3 第 4 节），章号机检放行
}

/** 账本条目内存模型（#3 第 3-6 节，六类统一 + 各类特化字段可选） */
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
  父布局线?: string // 布局线（#3 第 6.2 节，局中局）
  欠方?: string // 关系线（#3 第 6.3 节）
  债主?: string // 关系线

  // 容错：未知字段原样保留（#3 第 8 节；R64-17 十二轮：数组型按 string[] 原样承载）
  _raw?: Record<string, string | string[]>
  /** 履历段前的人工说明正文（如人物/设定简介），回写时保留 */
  _bodyBeforeHistory?: string
  /** 履历段之后的人工正文（备注/关联线索等，dd-P2：回写时保留——此前被静默删除） */
  _bodyAfterHistory?: string
  /** 源 md 的 front matter 字段顺序（回写保序用，#3 第 8 节"不重排已有字段顺序"） */
  _fmOrder?: string[]
  /** 源 md 路径（重建时回填，非 front matter 字段） */
  _path?: string
}

// ── 章节元数据（#7 第 2 节）──────────────────────

/** 钩子类型（#7 第 3 节，追读力 5 类） */
export type HookType = '危机钩' | '悬念钩' | '渴望钩' | '情绪钩' | '选择钩'

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

/** 伏笔回收条目（单章内闭合，弃坑 = 阻断） */
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
 * 范围限单章、写完即归档；复用账本格式骨架降级，无跨章长程线。
 * 落点：大纲/章纲/<章号>-<标题>.md。
 */
export interface PieceList {
  反转线索表: ReversalLead
  情绪曲线?: EmotionCurvePoint[]
  伏笔回收: PayoffEntry[]
  _path?: string // R73-16b（二十一轮）：死字段 _raw 删除（R65-39 已登记从不填充，未知段保形走文本级补丁路径）
}

/** 钩子强弱 */
export type HookLevel = '强' | '中' | '弱'

/** 情绪定位（#7 第 3 节） */
export type Emotion = '压抑' | '铺垫' | '小爽' | '大爽' | '转折'

/** 章节场景类型（节奏页场景分布，#7.4） */
export type SceneType = '战斗' | '对话' | '抒情' | '叙事铺陈' | '爽点高潮'

/** 章节元数据（#7 第 2 节，正文 front matter） */
export interface ChapterMeta {
  章号: number
  标题: string
  钩子类型: HookType
  钩子强弱: HookLevel
  情绪定位: Emotion
  场景?: SceneType // 可选（#7.4 节奏页场景分布）
  时间锚点?: string // 可选（#7 第 2 节）
  字数目标?: number // 可选（块4：规划字数，章纲录入；定稿章可保留规划值）
  // 以下为通用可选字段（长短篇均可用，非"短篇专属"）
  目标情绪?: string // 读者体验目标（惊悚/温暖/心酸…）
  核心反转?: string // 本章核心反转点（有反转的章才填）
  _raw?: Record<string, string>
  _path?: string
  _wordCount?: number // 机检算的派生（#7 第 2 节，不入 front matter）
  /** W-P2-4：readChapterDir 传 includeBody 时带出正文原文（导出单次读用；默认缺省不驻留内存） */
  _body?: string
  /** R73-16（二十一轮 B-3）：必填枚举缺失清单（钩子类型/钩子强弱/情绪定位，缺省 = 全齐）。
   *  readChapter 登记、checkFrontMatter 消费产红项（fm-missing）；缺字段不再静默补默认了事。 */
  _fmMissing?: string[]
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

// ── 文风条目（文风系统重整：统一模型吃掉样章/手法/反例/禁词）──

/** 条目类型（极性不设字段，由类型推导：样章/手法=正，反例/禁词=负） */
export type EntryKind = '样章' | '手法' | '反例' | '禁词'

/** 条目来源（即证据强度：改稿行为 > 作者标注 > 收割 > 题材范文 > 导入） */
export type EntrySource = '作者标注' | '改稿行为' | '收割' | '题材范文' | '导入'

/** 统一文风条目 */
export interface StyleEntry {
  类型: EntryKind
  场景: string // 具体场景 或「通用」
  来源: EntrySource
  说明?: string // 样章=学什么 / 反例=错在哪 / 手法=本身补充 / 禁词=为什么不要
  出处?: string
  标签?: string[] // 金句 / 锚点 / AI味 / …
  正文: string // 样章正文 / 手法描述 / 反例正文 / 禁词
  证据?: EntryEvidence // 来源=改稿行为 时才有；运行期字段，条目文件不落盘（候选箱证据格式 S4 定义）
  _raw?: Record<string, string>
  _path?: string
}

/** 改稿行为来源的原始证据（供作者在候选箱确认时对照看） */
export interface EntryEvidence {
  章号: number
  AI版: string
  作者版: string
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
    /** 题材。书级设定全局托底改可选：未设 = 跟随 global.json defaultGenre → 硬编码 ''。
     *  解析侧把空串归一为 undefined（`genre: ''` 与缺失同义），写侧 undefined 不落行——
     *  这样书文件里只保留作者真正选过的题材，设置页据 raw 值判断「本书是否覆盖」。 */
    genre?: string
    volume_size?: number
    /** 全书/整集目标字数（决策 14）；完成度 = 已写字数 / target_words */
    target_words?: number
    /** 每章默认字数目标（新建章 placeholder；单章可在 fm 覆盖） */
    chapter_target_words?: number
  }
  leads: {
    enabled: string[] // 启用的扩展类（基础三类恒启用、不列）
    thresholds?: Record<string, number> // 各类「悬太久」阈值覆盖
  }
  budget: {
    /** 长篇为每章调用上限；kind: short 时按每篇调用上限解释。
     *  书级设定全局托底改可选：未设 = global.json callsPerChapter → 硬编码 8（运行时
     *  applyGlobalDefaults 合并，见 format/global-defaults.ts）。 */
    calls_per_chapter?: number
    input_per_chapter?: number
    summary_chapter_max?: number
    summary_volume_max?: number
    /** D3（批 5）：单章 token 预算上限（input+output+cache 全口径累计；未设 = 不拦） */
    tokens_per_chapter?: number
    /** D3（批 5）：单章金额预算上限（需配价格表才生效——未配价时静默不生效，
     *  与信息差未配置静默跳过同语义；未设 = 不拦） */
    cost_per_chapter?: number
  }
  /** 文风注入强度。整段可选：书级未设 injection = global.json styleInjection → 硬编码 'light' */
  style?: {
    injection?: 'light' | 'heavy'
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
  /** 自动化偏好。整段可选：书级未设的键 = global.json 对应键 → 硬编码回落（全局托底） */
  auto?: {
    confirm_outline?: boolean
    batch_size?: number
    /** 关系图自动 AI 梳理（缺省 false；global relationAutoMine 托底） */
    relation_auto_mine?: boolean
    /** 自动梳理的章节增量阈值（缺省 3；global relationMineThreshold 托底） */
    relation_mine_threshold?: number
  }
  /** 摘要金字塔（C1 批 2）。缺省 auto=true：定稿即生成章摘要 + 自愈按需补漏。
   *  summary.auto: false = 整体关闭，回到「作者手写约定」现状。 */
  summary?: {
    auto?: boolean
  }
  growth: {
    realm_span_max?: number // 跃迁跨度上限（O1，#6）
  }
  /** 机检扩展词表（#10 项 7/11 数据源接线）。整段可选：未设 = 各检查走默认供给链
   *  （高频意象回落内置种子表 check/imagery-seed.ts；信息差无内置默认、静默不启用）。
   *  书级写了词表即整体替换默认供给（显式覆盖，不合并——可预期）。 */
  checks?: {
    /** 高频意象词表。undefined = 回落内置种子表；显式 [] = 彻底关（与「未设」语义不同，
     *  解析/序列化都必须保真这个显式空数组，round-trip 不得归一为 undefined） */
    imagery_words?: string[]
    /** 信息差关键词。无内置默认（逐书的秘密无通用词表）；未设 = 静默不启用 */
    leak_keywords?: string[]
  }
  /** 快照保留策略（单章版本回滚）；缺省 = 14 天 / 30 个。分层保留桶为内部规则，不暴露 */
  snapshots?: {
    /** 超期删除（天） */
    max_days?: number
    /** 每文档保留上限（个） */
    max_count?: number
  }
  /** RAG 可选插件配置（#37，非密段；api_key 不入此、不入 git） */
  rag?: {
    enabled: boolean
    provider?: string // RAG 服务商 id（应用级 providers.json 引用；设此键时 endpoint/model 不再写）
    endpoint?: string // 旧版内联 embedding 端点（存量兼容，resolver 回落用）
    model?: string // 旧版内联 embedding 模型名（存量兼容）
    candidate_depth?: number // A3（批 7）：召回惰性指纹校验的候选章上限（缺省 20；P4 拍板写死可覆盖）
    embed_timeout_ms?: number // R62-27：embedding 单请求超时毫秒（正整数才收；缺省 embed.ts 内置 30s）
  }
  // R73-16b（二十一轮）：死字段 _raw 删除——Z-16 已如实登记「全库无生产填充」，
  // 未知顶层段的实际保留由 patchBookConfigText 文本补丁路径达成（保形在文本层），
  // 全量重生成（stringifyBookConfig）丢弃未知段是既定取舍；类型面不再保留幻影字段。
}

// ── 解析错误（#3 第 8 节，容错不崩）──────────────

/** 结构化解析错误（不抛异常，返回给调用方走「修复确认」） */
export interface ParseError {
  file: string
  line: number
  message: string
}
