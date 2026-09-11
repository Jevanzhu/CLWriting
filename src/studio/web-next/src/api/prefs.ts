import { apiJson } from './client'

/** 书库级偏好（.clwriting/prefs.json）：工作区布局 + 可覆盖编辑器偏好。 */
export interface BookPrefs {
  pageWidth?: number
  autosaveInterval?: number
  leftWidth?: number
  leftOpen?: boolean
  rightOpen?: boolean
  leftPanel?: string
  activeDocId?: string | null
  treeExpanded?: string[]
  [k: string]: unknown
}

export async function getBookPrefs(name: string): Promise<BookPrefs> {
  const r = await apiJson<{ prefs: BookPrefs }>(
    `/api/books/${encodeURIComponent(name)}/prefs`,
  )
  // R61-F-2：200 空信封（缺 prefs 字段，信封异常/旧网关代理截断）兜底为空偏好——
  // 原直返 r.prefs 会把 undefined 交给消费侧：workspace.loadBookPrefs 的
  // Object.keys(prefs) 抛 TypeError，且该 rejection 在 setBook 的 void loadBookPrefs
  // 浮空无人接（prefsLoaded 永不置位）。对齐全局侧 stores/prefs init 同款口径
  //（R51-H-2 同族：缺字段按「空偏好」降级，走迁移/默认布局既有链，不抛不挂）。
  return r.prefs ?? {}
}

/**
 * R48-82（四十八轮）备案：书级 prefs 写入不带 expectedRevision（服务端 R36-24 守卫
 * 契约已在，config/global 两级客户端均已接线）——刻意轻量取舍：书级 prefs 全为低价值
 * 布局态（面板宽/开合/活动文档），双窗并发时后写者胜可接受，409 冲突链反而打扰；
 * 若后续 prefs 承载高价值数据需加锁，另立批次接线（服务端零改动）。
 */
export async function putBookPrefs(name: string, prefs: BookPrefs): Promise<void> {
  await apiJson<{ ok: true }>(`/api/books/${encodeURIComponent(name)}/prefs`, {
    method: 'PUT',
    json: { prefs },
  })
}

// ── 全局编辑器偏好（.clwriting/global.json）──

/** 全局编辑器偏好：跨书共享的外观设置（对齐 Obsidian vault 级配置）。 */
export interface GlobalPrefs {
  theme?: 'light' | 'dark'
  proseSize?: number
  proseLh?: number
  uiFontCn?: string
  uiFontEn?: string
  proseFontCn?: string
  proseFontEn?: string
  pageWidth?: number
  autosaveInterval?: number
  shelfView?: 'grid' | 'list'
  chatEnabled?: boolean
  compact?: boolean
  /** 版本保留全局默认（所有书统一，无书级覆盖；生效链 global.json → 硬编码 14 天 / 30 个） */
  snapMaxDays?: number
  snapMaxCount?: number
  // ── 书级设定 · 全局托底（书级写作默认。生效链 book.yaml 对应键 → 此处 → 硬编码回落，服务端合并同链）──
  // 设计动机同 snapMax*：新建书/未单独设定的书不再落到各处硬编码，而是统一由这里托底。
  /** 题材默认（'' = 未设；书级 book.genre，空串同未设） */
  defaultGenre?: string
  /** 每卷章数默认（int ≥5；书级 book.volume_size，仅长篇使用） */
  defaultVolumeSize?: number
  /** 目标字数默认（posInt；书级 book.target_words；展示/生效层面 0 = 未设） */
  defaultTargetWords?: number
  /** 每章字数默认（posInt；书级 book.chapter_target_words；0 = 未设） */
  defaultChapterTargetWords?: number
  /** 短篇严格模式默认（书级 short.strict，仅作用于短篇书） */
  defaultShortStrict?: boolean
  /** 文风注入强度默认（'light' | 'heavy'；2026-08-19 起唯一生效源：全局，已取消书级覆盖） */
  styleInjection?: 'light' | 'heavy'
  /** 自动确认细纲默认（书级 auto.confirm_outline） */
  autoConfirmOutline?: boolean
  /** 批量写作章数默认（int 1-20；书级 auto.batch_size） */
  autoBatchSize?: number
  /** 单章调用上限默认（int 1-50；书级 budget.calls_per_chapter） */
  callsPerChapter?: number
  /** 关系图自动梳理默认（书级 auto.relation_auto_mine） */
  relationAutoMine?: boolean
  /** 关系图章节增量阈值默认（int 1-20；书级 auto.relation_mine_threshold） */
  relationMineThreshold?: number
  /** 知识检索启用默认（书级 rag.enabled） */
  ragEnabled?: boolean
  /** 知识检索提供方默认（'' = 未设；书级 rag.provider，引用应用级 RAG 提供方 id） */
  ragProvider?: string
  // ── R52-E-2：机检阈值全局托底五键（undefined = 未设，走引擎默认；书级 checks.* 未设才托底）──
  /** 复读占比阈值（0-1 小数；书级 checks.repeat_threshold） */
  checkRepeatThreshold?: number
  /** 复读最小连续字数（正整数；书级 checks.repeat_chars_threshold） */
  checkRepeatCharsThreshold?: number
  /** 超长句判定长度（正整数；书级 checks.max_sentence_len） */
  checkMaxSentenceLen?: number
  /** 高频意象报黄次数阈值（正整数；书级 checks.imagery_threshold） */
  checkImageryThreshold?: number
  /** 字数容差百分比（正数；书级 checks.word_count_tolerance） */
  checkWordCountTolerance?: number
  [k: string]: unknown
}

export async function getGlobalPrefs(): Promise<{ prefs: GlobalPrefs; revision: number }> {
  const r = await apiJson<{ prefs: GlobalPrefs; revision: number }>(`/api/library/prefs`)
  return { prefs: r.prefs, revision: r.revision }
}

/** GG-P2-7：expectedRevision 可选——服务端乐观并发守卫（不传 = 直通，向后兼容）；
 *  成功回传自增后的 revision 供调用方同步，后续写不因陈旧号 409。 */
export async function putGlobalPrefs(
  prefs: GlobalPrefs,
  expectedRevision?: number,
): Promise<{ ok: true; revision: number }> {
  return apiJson<{ ok: true; revision: number }>(`/api/library/prefs`, {
    method: 'PUT',
    json: { prefs, expectedRevision },
  })
}
