import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getGlobalPrefs, putGlobalPrefs, type GlobalPrefs } from '../api/prefs'
import { ApiError } from '../api/client'
import { PROSE_FONT_FALLBACK } from '../composables/useSystemFonts'
import { useUiStore } from './ui'
import type { ThemeId } from '../types/theme'

/**
 * 全局编辑器偏好 store（主题 + 排版 + 字体 + 书架视图 + 版本保留全局默认）。
 *
 * 存储：userData/global.json（APP 级，跨书库共享；对齐 Obsidian 全局配置）。
 * 替代旧 localStorage（LevelDB 黑盒，不可编辑不可备份）。
 *
 * 书级覆盖：pageWidth / autosaveInterval 可被 .clwriting/prefs.json 覆盖。
 * effectivePageWidth = 书级 > 全局；apply() 用有效值。
 * 书级覆盖的持久化由 workspace store 统一写入 prefs.json（避免双写冲突）。
 *
 * 版本保留全局默认（snapDays/snapCount → 持久化为 global.json 的 snapMaxDays/snapMaxCount）：
 * 生效链 book.yaml snapshots → 此处 → 硬编码 14 天 / 30 个（服务端 prune 同链）。
 * 书级覆盖存 book.yaml 的 snapshots 段（「本书」页写），不进本 store。
 *
 * 书级设定全局托底（13 键，同 snapMax* 模式）：题材/每卷章数/目标字数/每章字数/短篇严格/
 * 文风注入/自动确认细纲/批量章数/单章上限/自动梳理/增量阈值/启用检索/检索提供方。
 * 生效链 book.yaml 对应键 → 此处 → 硬编码回落（ref 初值即回落，服务端合并同链）；
 * 书级覆盖存 book.yaml（「本书」页各领域的「本书使用独立设定」组开关写），不进本 store。
 *
 * 初始化：main.ts 在 mount 前 await init() → API 读取 → apply CSS 变量。
 * 首次为空时从旧 localStorage 自动迁移。
 */
const DEFAULTS = {
  theme: 'light' as ThemeId,
  proseSize: 17,
  proseLh: 1.85,
  pageWidth: 1020,
  autosaveInterval: 30,
  shelfView: 'grid' as 'grid' | 'list',
  chatEnabled: false,
  compact: false,
  snapDays: 14,
  snapCount: 30,
  // ── 书级设定全局托底（书级未设时的展示/生效回落；与服务端合并链末端一致）──
  defaultGenre: '',
  defaultVolumeSize: 50,
  defaultTargetWords: 0,
  defaultChapterTargetWords: 0,
  defaultShortStrict: false,
  styleInjection: 'light' as 'light' | 'heavy',
  autoConfirmOutline: false,
  autoBatchSize: 8,
  callsPerChapter: 8,
  relationAutoMine: false,
  relationMineThreshold: 3,
  ragEnabled: false,
  ragProvider: '',
}

/** 旧 localStorage 键（仅迁移用，迁移后停用） */
const OLD_LS = {
  theme: 'clw-theme',
  size: 'clw.proseSize',
  lh: 'clw.proseLh',
  uiFontCn: 'clw.uiFontCn',
  uiFontEn: 'clw.uiFontEn',
  proseFontCn: 'clw.proseFontCn',
  proseFontEn: 'clw.proseFontEn',
  pageWidth: 'clw.pageWidth',
  autosaveInterval: 'clw.autosaveInterval',
  shelfView: 'clw-shelf-view',
}

/** 拼字体族：英文字体优先（英文片段），中文字体兜底（中文），最后系统 fallback。
 *  含空格的字体名自动加引号。 */
function buildFontFamily(en: string, cn: string, fallback: string): string {
  const parts: string[] = []
  if (en) parts.push(en.includes(' ') ? `"${en}"` : en)
  if (cn) parts.push(cn.includes(' ') ? `"${cn}"` : cn)
  parts.push(fallback)
  return parts.join(', ')
}

export const usePrefsStore = defineStore('prefs', () => {
  // ── 全局偏好（global.json）──
  const theme = ref<ThemeId>(DEFAULTS.theme)
  const proseSize = ref(DEFAULTS.proseSize)
  const proseLh = ref(DEFAULTS.proseLh)
  const uiFontCn = ref('')
  const uiFontEn = ref('')
  /** UI 字号档（外观设置；-1 小 / 0 标准 / 1 大 / 2 特大）——整条字号刻度随
   *  --font-size-step 平移，平台基准（win +1px）之上叠加。两平台通用。 */
  const uiFontSizeStep = ref(0)
  const proseFontCn = ref('')
  const proseFontEn = ref('')
  const pageWidth = ref(DEFAULTS.pageWidth)
  const autosaveInterval = ref(DEFAULTS.autosaveInterval)
  const shelfView = ref<'grid' | 'list'>(DEFAULTS.shelfView)
  /** 对话助手开关（默认关闭） */
  const chatEnabled = ref(DEFAULTS.chatEnabled)
  /** 紧凑模式：收窄侧栏间距 / 减小列表行高（默认关闭） */
  const compact = ref(DEFAULTS.compact)
  /** 版本保留全局默认（天数/数量；持久化为 snapMaxDays/snapMaxCount，未单独设定的书使用） */
  const snapDays = ref(DEFAULTS.snapDays)
  const snapCount = ref(DEFAULTS.snapCount)

  // ── 书级设定全局托底（书级 book.yaml 未设时的展示/生效值；持久化为 global.json 13 键）──
  // ref 初值即硬编码回落：前端消费者直接读 ref，书级未设时自然落到这里（服务端合并链末端一致），
  // 无需再写一遍魔法数字。书级覆盖由「本书」页各领域的「本书使用独立设定」组开关写 book.yaml，不进本 store。
  /** 题材默认（'' = 未设；书级 book.genre） */
  const defaultGenre = ref(DEFAULTS.defaultGenre)
  /** 每卷章数默认（仅长篇使用；书级 book.volume_size） */
  const defaultVolumeSize = ref(DEFAULTS.defaultVolumeSize)
  /** 目标字数默认（0 = 未设；书级 book.target_words） */
  const defaultTargetWords = ref(DEFAULTS.defaultTargetWords)
  /** 每章字数默认（0 = 未设；书级 book.chapter_target_words） */
  const defaultChapterTargetWords = ref(DEFAULTS.defaultChapterTargetWords)
  /** 短篇严格模式默认（仅短篇书生效；书级 short.strict） */
  const defaultShortStrict = ref(DEFAULTS.defaultShortStrict)
  /** 文风注入强度默认（2026-08-19 起唯一生效源：全局，已取消书级覆盖） */
  const styleInjection = ref(DEFAULTS.styleInjection)
  /** 自动确认细纲默认（书级 auto.confirm_outline） */
  const autoConfirmOutline = ref(DEFAULTS.autoConfirmOutline)
  /** 批量写作章数默认（书级 auto.batch_size；注意 ref 名与 JSON 键 autoBatchSize 不同，避免与语义混淆） */
  const aiBatchSize = ref(DEFAULTS.autoBatchSize)
  /** 单章调用上限默认（书级 budget.calls_per_chapter） */
  const callsPerChapter = ref(DEFAULTS.callsPerChapter)
  /** 关系图自动梳理默认（书级 auto.relation_auto_mine） */
  const relationAutoMine = ref(DEFAULTS.relationAutoMine)
  /** 关系图章节增量阈值默认（书级 auto.relation_mine_threshold） */
  const relationMineThreshold = ref(DEFAULTS.relationMineThreshold)
  /** 知识检索启用默认（书级 rag.enabled） */
  const ragEnabled = ref(DEFAULTS.ragEnabled)
  /** 知识检索提供方默认（'' = 未设；书级 rag.provider，引用应用级 RAG 提供方 id） */
  const ragProvider = ref(DEFAULTS.ragProvider)

  // ── 书级覆盖（prefs.json；null = 用全局）──
  const bookPageWidth = ref<number | null>(null)
  const bookAutosaveInterval = ref<number | null>(null)

  // ── 有效值（书级 > 全局）──
  const effectivePageWidth = computed(() => bookPageWidth.value ?? pageWidth.value)
  const effectiveAutosaveInterval = computed(() => bookAutosaveInterval.value ?? autosaveInterval.value)

  let persistTimer: ReturnType<typeof setTimeout> | null = null
  /** R32-27：在途写回句柄（单飞排队判据；finally 复位） */
  let putInFlight: Promise<void> | null = null
  /** R35-8：最近一次成功落盘的服务端快照（PUT 的入参快照）——409 恢复时判定
   *  「本窗已改未落盘字段」的基线（当前 refs ≠ 此快照的字段即本窗脏字段）。 */
  let lastPersisted: GlobalPrefs | null = null

  /** 并发修订号（GG-P2-7）：PUT /api/library/prefs 的 expectedRevision 依据。
   *  GET/写成功响应回传时同步（照 provider store P4 的维护方式），非响应式——仅供写路径用。
   *  R32-26（三十二轮）：配对未知态标记——init 失败（API 不可达）时 revision=0 是「未知」
   *  而非「服务端确为 0」，原样参与 PUT 会让首保存必 409（误报「已在其他窗口被修改」）。 */
  let revision = 0
  let revisionKnown = false

  /** 异步初始化：从 global.json 加载（替代 localStorage）。
   *  首次为空时从旧 localStorage 自动迁移。main.ts 在 mount 前调一次。 */
  async function init(): Promise<void> {
    let prefs: GlobalPrefs = {}
    let apiOk = false
    try {
      const r = await getGlobalPrefs()
      prefs = r.prefs
      revision = r.revision
      revisionKnown = true
      apiOk = true
    } catch {
      /* API 不可达用默认——revision 维持未知态（R32-26：写回前重 GET 对齐） */
    }

    // 迁移：API 可达且 prefs 为空（真·首次）时才从旧 localStorage 读取。
    // R72-11（二十轮 F-3）：API 不可达不再误判「首次」——旧 localStorage 残值会覆盖
    // 展示态（服务端配置实际存在，重连后展示跳变）。迁移成功后清理旧键（对齐
    // workspace 侧已修口径），防旧残值在后续 API 不可达时再度触发伪迁移。
    if (apiOk && Object.keys(prefs).length === 0 && migrateFromLocalStorage()) {
      prefs = buildCache()
      lastPersisted = prefs // R35-8：迁移写内容即基线（迁移 PUT 失败时脏字段判定仍成立）
      clearLegacyLocalStorage()
      // GG-P2-7：迁移写会 bump 服务端 revision——同步回存，否则首个用户保存带陈旧号 409
      void putGlobalPrefs(prefs).then((r) => { revision = r.revision; revisionKnown = true }).catch(() => {})
    } else {
      applyPrefs(prefs)
      lastPersisted = buildCache() // R35-8：初始服务端态即基线
    }

    applyTheme()
    applyCompact()
    apply()
  }

  /** 从旧 localStorage 迁移到 ref（仅首次 cache 为空时调）。返回是否有迁移数据。 */
  function migrateFromLocalStorage(): boolean {
    let has = false
    try {
      const t = localStorage.getItem(OLD_LS.theme)
      if (t === 'dark' || t === 'light') { theme.value = t; has = true }
      const num = (k: string): number | null => {
        const v = Number(localStorage.getItem(k))
        return Number.isFinite(v) && v > 0 ? v : null
      }
      const str = (k: string): string => localStorage.getItem(k) ?? ''
      for (const [k, ref, kind] of [
        [OLD_LS.size, proseSize, 'num'], [OLD_LS.lh, proseLh, 'num'],
        [OLD_LS.pageWidth, pageWidth, 'num'],
        [OLD_LS.autosaveInterval, autosaveInterval, 'num'],
        [OLD_LS.uiFontCn, uiFontCn, 'str'], [OLD_LS.uiFontEn, uiFontEn, 'str'],
        [OLD_LS.proseFontCn, proseFontCn, 'str'], [OLD_LS.proseFontEn, proseFontEn, 'str'],
      ] as const) {
        if (kind === 'num') {
          const v = num(k)
          if (v !== null) { (ref as typeof proseSize).value = v; has = true }
        } else {
          const v = str(k)
          if (v) { (ref as typeof uiFontCn).value = v; has = true }
        }
      }
      const sv = localStorage.getItem(OLD_LS.shelfView)
      if (sv === 'grid' || sv === 'list') { shelfView.value = sv; has = true }
    } catch { /* localStorage 损坏降级 */ }
    return has
  }

  /** R72-11（二十轮 F-3）：迁移完成后清理旧 localStorage 键——旧值残留会让后续
   *  「API 不可达」场景反复误判出伪迁移数据源 */
  function clearLegacyLocalStorage(): void {
    try {
      for (const key of Object.values(OLD_LS)) localStorage.removeItem(key)
    } catch { /* localStorage 不可用降级 */ }
  }

  /** 将 API 读到的 prefs 应用到各 ref */
  function applyPrefs(p: GlobalPrefs): void {
    if (p.theme === 'dark' || p.theme === 'light') theme.value = p.theme
    if (typeof p.proseSize === 'number' && p.proseSize > 0) proseSize.value = p.proseSize
    if (typeof p.proseLh === 'number' && p.proseLh > 0) proseLh.value = p.proseLh
    if (typeof p.uiFontCn === 'string') uiFontCn.value = p.uiFontCn
    if (typeof p.uiFontEn === 'string') uiFontEn.value = p.uiFontEn
    if (typeof p.uiFontSizeStep === 'number' && p.uiFontSizeStep >= -1 && p.uiFontSizeStep <= 2) {
      uiFontSizeStep.value = p.uiFontSizeStep
    }
    if (typeof p.proseFontCn === 'string') proseFontCn.value = p.proseFontCn
    if (typeof p.proseFontEn === 'string') proseFontEn.value = p.proseFontEn
    if (typeof p.pageWidth === 'number' && p.pageWidth > 0) pageWidth.value = p.pageWidth
    if (typeof p.autosaveInterval === 'number' && p.autosaveInterval > 0) autosaveInterval.value = p.autosaveInterval
    if (p.shelfView === 'grid' || p.shelfView === 'list') shelfView.value = p.shelfView
    if (typeof p.chatEnabled === 'boolean') chatEnabled.value = p.chatEnabled
    if (typeof p.compact === 'boolean') compact.value = p.compact
    if (typeof p.snapMaxDays === 'number' && p.snapMaxDays > 0) snapDays.value = p.snapMaxDays
    if (typeof p.snapMaxCount === 'number' && p.snapMaxCount > 0) snapCount.value = p.snapMaxCount
    // 书级设定全局托底 13 键：逐键类型/范围守卫（global.json 手改脏值不进 UI，保持回落）
    if (typeof p.defaultGenre === 'string') defaultGenre.value = p.defaultGenre.trim()
    if (typeof p.defaultVolumeSize === 'number' && p.defaultVolumeSize >= 5) defaultVolumeSize.value = Math.round(p.defaultVolumeSize)
    // 目标字数/每章字数：JSON 层只存正整数（0 = 未设由 ref 初值表达），非法值回保持现值
    if (typeof p.defaultTargetWords === 'number' && p.defaultTargetWords > 0) defaultTargetWords.value = Math.round(p.defaultTargetWords)
    if (typeof p.defaultChapterTargetWords === 'number' && p.defaultChapterTargetWords > 0) defaultChapterTargetWords.value = Math.round(p.defaultChapterTargetWords)
    if (typeof p.defaultShortStrict === 'boolean') defaultShortStrict.value = p.defaultShortStrict
    if (p.styleInjection === 'light' || p.styleInjection === 'heavy') styleInjection.value = p.styleInjection
    if (typeof p.autoConfirmOutline === 'boolean') autoConfirmOutline.value = p.autoConfirmOutline
    if (typeof p.autoBatchSize === 'number' && p.autoBatchSize >= 1) aiBatchSize.value = Math.round(p.autoBatchSize)
    if (typeof p.callsPerChapter === 'number' && p.callsPerChapter >= 1) callsPerChapter.value = Math.round(p.callsPerChapter)
    if (typeof p.relationAutoMine === 'boolean') relationAutoMine.value = p.relationAutoMine
    if (typeof p.relationMineThreshold === 'number' && p.relationMineThreshold >= 1) relationMineThreshold.value = Math.round(p.relationMineThreshold)
    if (typeof p.ragEnabled === 'boolean') ragEnabled.value = p.ragEnabled
    if (typeof p.ragProvider === 'string') ragProvider.value = p.ragProvider.trim()
  }

  /** 从当前全局 ref 构建 GlobalPrefs 对象（不含书级覆盖） */
  function buildCache(): GlobalPrefs {
    return {
      theme: theme.value,
      proseSize: proseSize.value,
      proseLh: proseLh.value,
      uiFontCn: uiFontCn.value,
      uiFontEn: uiFontEn.value,
      uiFontSizeStep: uiFontSizeStep.value,
      proseFontCn: proseFontCn.value,
      proseFontEn: proseFontEn.value,
      pageWidth: pageWidth.value,
      autosaveInterval: autosaveInterval.value,
      shelfView: shelfView.value,
      chatEnabled: chatEnabled.value,
      compact: compact.value,
      snapMaxDays: snapDays.value,
      snapMaxCount: snapCount.value,
      // 书级设定全局托底 13 键全量带上（global.json 整文件重写，漏键 = 丢配置）
      defaultGenre: defaultGenre.value,
      defaultVolumeSize: defaultVolumeSize.value,
      defaultTargetWords: defaultTargetWords.value,
      defaultChapterTargetWords: defaultChapterTargetWords.value,
      defaultShortStrict: defaultShortStrict.value,
      styleInjection: styleInjection.value,
      autoConfirmOutline: autoConfirmOutline.value,
      autoBatchSize: aiBatchSize.value,
      callsPerChapter: callsPerChapter.value,
      relationAutoMine: relationAutoMine.value,
      relationMineThreshold: relationMineThreshold.value,
      ragEnabled: ragEnabled.value,
      ragProvider: ragProvider.value,
    }
  }

  /** debounce 写回 global.json（500ms）。
   *  R32-27（三十二轮）：快照移入定时器回调（此前防抖注册即捕快照，PUT 晚 500ms 发出，
   *  与在途 PUT 交叠时旧快照后到可丢改动）+ 在途单飞（在途时重走防抖排队，完成后以
   *  届时最新快照发出）。 */
  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      if (putInFlight) {
        schedulePersist() // 在途挂起排队：完成后重拍 500ms，快照届时重取
        return
      }
      // R33D-24（三十三轮）：占位提前到 GET 之前——!revisionKnown 分支的 await 在
      // putInFlight 赋值前，两次防抖回落进「500ms + GET 时延」窗口时第二个定时器
      // 判空仍为 null → 双重 PUT 同 expectedRevision → 必 409 伪告警丢一笔。先占位
      // 再补 GET，单飞不变式贯穿 revisionKnown 两种取值。
      putInFlight = Promise.resolve()
      void (async () => {
        try {
          // R32-26：revision 未知态（init 失败离线）首次 PUT 前重 GET 对齐——不再以 0
          // 自伤 409；GET 不可达时照旧发 PUT，走既有 409/静默口径自愈
          if (!revisionKnown) {
            try {
              revision = (await getGlobalPrefs()).revision
              revisionKnown = true
            } catch { /* 网络不可达：照旧 PUT */ }
          }
          await doPersistPut()
        } finally {
          putInFlight = null
        }
      })()
    }, 500)
  }

  /** R33D-24：实际 PUT 段抽直（占位逻辑外提）；409 恢复见 recoverFromConflict（R35-8 改写
   *  R33-73 的「整体采纳远端」口径）。 */
  async function doPersistPut(): Promise<void> {
    // 快照先于 PUT：await 窗口内的新 setter 不属于本次落盘内容，成功后按快照记基线
    const cache = buildCache()
    try {
      // GG-P2-7：带 expectedRevision 乐观并发——两面板同时保存时后写收 409 而非静默覆盖先写
      const r = await putGlobalPrefs(cache, revision)
      revision = r.revision
      revisionKnown = true
      lastPersisted = cache
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) return /* 其他错误静默（离线等，与原口径一致） */
      await recoverFromConflict(cache)
    }
  }

  /** 本窗脏字段键集：当前值与最近成功落盘快照不一致的键（R35-8 脏字段判定源）。 */
  function dirtyKeysOf(local: GlobalPrefs): string[] {
    if (!lastPersisted) return Object.keys(local)
    const out: string[] = []
    for (const k of Object.keys(local)) {
      if (local[k] !== lastPersisted[k]) out.push(k)
    }
    return out
  }

  /** R35-8：409 恢复——远端值垫底 + 本窗未落盘修改重放（原 R33-73 口径 applyPrefs 整体
   *  采纳远端，本窗未落盘的修改被静默丢弃）。重试 PUT 经 await 并入调用方的 putInFlight
   *  单飞：恢复窗口内的新保存排队到重试完成后发出，不再带陈旧 revision 再吃 409。 */
  async function recoverFromConflict(localCache: GlobalPrefs): Promise<void> {
    let remote: Awaited<ReturnType<typeof getGlobalPrefs>>
    try {
      remote = await getGlobalPrefs()
    } catch {
      return /* 网络不可达保持现值，等下次 schedulePersist */
    }
    revision = remote.revision
    revisionKnown = true
    // 远端值垫底，本窗脏字段重放本地值（合并经 applyPrefs 的逐键类型/范围守卫落 refs）
    const merged: GlobalPrefs = { ...remote.prefs }
    for (const k of dirtyKeysOf(localCache)) merged[k] = localCache[k]
    applyPrefs(merged)
    // R37-27（三十七轮批E）：合并结果只写 refs 不落样式——非本窗脏的字段采纳远端新值后，
    // 排版 CSS 变量/主题 dataset/紧凑 class 仍停留在冲突前旧值，「已保留本窗修改并合并
    // 最新值」的提示弹出但样式不生效。对齐 init() 的恢复链：applyPrefs 后接三连 apply
    applyTheme()
    applyCompact()
    apply()
    const retryCache = buildCache()
    try {
      const r = await putGlobalPrefs(retryCache, revision)
      revision = r.revision
      revisionKnown = true
      lastPersisted = retryCache
      // R40-41（四十轮）：三态告知之「成功」——合并 + 重试落盘都成功才按现行口径提示
      useUiStore().toast('全局偏好已在其他窗口被修改，已保留本窗修改并合并最新值', 'warning')
    } catch {
      /* R40-41：三态告知之「已刷新+重试失败」——refs 已合并保留（本窗脏修改仍在，
       * lastPersisted 未推进 → 下次 schedulePersist 自动重试），但不得再按成功口径
       * 提示「已合并」误导作者（原实现 catch 静默 + 无条件成功 toast）。第三态
       * （GET 失败）维持上方静默：本窗值未动、无成功假象，等下次保存自动再走恢复链。 */
      useUiStore().toast('全局偏好已在其他窗口被修改，已合并最新值，但重试保存失败——本窗修改已保留，将随下次改动自动重试', 'error')
    }
  }

  // ── apply（直写 :root CSS 变量）──

  function apply(): void {
    const r = document.documentElement
    r.style.setProperty('--prose-size', `${proseSize.value}px`)
    r.style.setProperty('--prose-lh', String(proseLh.value))
    r.style.setProperty('--page-width', `${effectivePageWidth.value}px`)
    // J5：UI 字号档（外观「字号」设置，两平台通用）——在平台基准上叠用户选择
    // （win 基准 +1px 见 tokens 平台块；内联值覆盖 CSS，故此处始终写平台合计值）
    const baseStep = window.clwritingDesktop?.platform === 'win32' ? 1 : 0
    r.style.setProperty('--font-size-step', `${baseStep + uiFontSizeStep.value}px`)
    if (uiFontCn.value || uiFontEn.value) {
      r.style.setProperty('--font-ui', buildFontFamily(uiFontEn.value, uiFontCn.value, 'system-ui, sans-serif'))
    } else {
      r.style.removeProperty('--font-ui')
    }
    if (proseFontCn.value || proseFontEn.value) {
      // J5：基座回退带宋体（win 无霞鹜/思源时保持衬线观感，与 tokens.css 默认栈一致；
      // 串值单源于 useSystemFonts 的 PROSE_FONT_FALLBACK）
      r.style.setProperty('--prose-font', buildFontFamily(proseFontEn.value, proseFontCn.value, PROSE_FONT_FALLBACK))
    } else {
      r.style.removeProperty('--prose-font')
    }
  }

  // ── 窗控 overlay 色（win）──
  // WCO 能力上限 = 实色 + 主题跟随（'transparent' 不被 Chromium 接受、按钮底色也不跟
  // nativeTheme，2026-08-31 实测）。色值 = 两档 --background-secondary（= 顶栏底）；
  // 遮罩压暗期间用被 rgba(0,0,0,.45) 压暗后的等效色（实测 light 246→135、dark 38→21），
  // 否则暗页面顶着一列亮窗控（作者反馈「窗控突兀」）。
  let overlayDimmed = false
  /** View Transition 圆形扩散进行中——applyTheme 暂不改窗控色，由 useTheme 在扩散
   *  前沿扫过窗控区的时刻经 syncOverlayDelayed 切换（否则特效 400ms 内窗控先跳色）。 */
  let overlaySweep = false

  function syncOverlayNow(): void {
    // 测试环境（node，无 window）与其他非桌面上下文直接短路
    if (typeof window === 'undefined') return
    const d = window.clwritingDesktop
    if (d?.platform !== 'win32') return
    const dark = theme.value === 'dark'
    void d.setTitleBarOverlay(
      overlayDimmed
        ? { color: dark ? '#151515' : '#878787', symbolColor: dark ? '#c8c8c8' : '#666666', dark }
        : { color: dark ? '#262626' : '#f6f6f6', symbolColor: dark ? '#c8c8c8' : '#666666', dark },
    )
  }

  /** 主题切换圆形扩散扫过窗控区的时刻由 useTheme 计算并延迟调用（ms）。 */
  function syncOverlayDelayed(delayMs: number): void {
    setTimeout(() => syncOverlayNow(), Math.max(0, Math.round(delayMs)))
  }
  function beginOverlaySweep(): void {
    overlaySweep = true
  }
  function endOverlaySweep(): void {
    overlaySweep = false
  }

  /**
   * 弹窗遮罩联动窗控色（win）：全屏遮罩压暗页面时，系统绘制的窗控条不会被压暗——
   * 暗页面顶着一列亮块即作者反馈的「窗控突兀」。开启期间窗控色用压暗等效色，关闭还原。
   */
  function setOverlayDimmed(open: boolean): void {
    overlayDimmed = open
    syncOverlayNow()
  }

  function applyTheme(): void {
    document.documentElement.dataset.theme = theme.value
    // 窗控色：非特效路径即时同步；圆形扩散路径由 useTheme 延迟到扫过窗控的时刻
    // （overlaySweep 挂起中，防止特效开始就跳色导致的不同步）
    if (!overlaySweep) syncOverlayNow()
  }

  /** 紧凑模式：给 <html> 挂 .compact，全局 CSS 用该选择器收窄间距 */
  function applyCompact(): void {
    document.documentElement.classList.toggle('compact', compact.value)
  }

  // ── setter ──

  function setThemeValue(id: ThemeId): void {
    theme.value = id
    applyTheme()
    schedulePersist()
  }
  function setSize(v: number): void {
    proseSize.value = v
    apply()
    schedulePersist()
  }
  function setLh(v: number): void {
    proseLh.value = v
    apply()
    schedulePersist()
  }
  function setUiFontCn(v: string): void {
    uiFontCn.value = v
    apply()
    schedulePersist()
  }
  /** UI 字号档（-1 小 / 0 标准 / 1 大 / 2 特大）：整条字号刻度随 --font-size-step 平移 */
  function setUiFontSizeStep(v: number): void {
    uiFontSizeStep.value = Math.min(2, Math.max(-1, Math.round(v)))
    apply()
    schedulePersist()
  }
  function setUiFontEn(v: string): void {
    uiFontEn.value = v
    apply()
    schedulePersist()
  }
  function setProseFontCn(v: string): void {
    proseFontCn.value = v
    apply()
    schedulePersist()
  }
  function setProseFontEn(v: string): void {
    proseFontEn.value = v
    apply()
    schedulePersist()
  }
  /** 纸张宽度：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖） */
  function setPageWidth(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookPageWidth.value = v
      apply()
      // R71-29（七十一轮）：书级持久化由 workspace watch 写 prefs.json 承担——书级键
      // 不在 buildCache 内，再 schedulePersist 是纯冗余 PUT global.json（服务端无条件
      // bump revision → 双窗伪 409）
      return
    }
    pageWidth.value = v
    bookPageWidth.value = null
    apply()
    schedulePersist()
  }
  /** 自动保存间隔：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖） */
  function setAutosaveInterval(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookAutosaveInterval.value = v
      // R71-29：同 setPageWidth——书级持久化归 workspace watch，跳过全局 PUT
      return
    }
    autosaveInterval.value = v
    bookAutosaveInterval.value = null
    schedulePersist()
  }
  function setShelfView(v: 'grid' | 'list'): void {
    shelfView.value = v
    schedulePersist()
  }
  function setChatEnabled(v: boolean): void {
    chatEnabled.value = v
    schedulePersist()
  }
  function setCompact(v: boolean): void {
    compact.value = v
    applyCompact()
    schedulePersist()
  }
  /** 版本保留全局默认 · 保留天数（clamp 1-365；未单独设定的书使用） */
  function setSnapDays(v: number): void {
    snapDays.value = Math.min(365, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** 版本保留全局默认 · 保留数量（clamp 1-200；未单独设定的书使用） */
  function setSnapCount(v: number): void {
    snapCount.value = Math.min(200, Math.max(1, Math.round(v)))
    schedulePersist()
  }

  // ── 书级设定全局托底 setter（clamp 后写 ref → 走 schedulePersist 防抖落 global.json）──

  /** 写作默认 · 题材（trim；'' = 未设） */
  function setDefaultGenre(v: string): void {
    defaultGenre.value = v.trim()
    schedulePersist()
  }
  /** 写作默认 · 每卷章数（clamp 5-500 取整；仅长篇使用） */
  function setDefaultVolumeSize(v: number): void {
    defaultVolumeSize.value = Math.min(500, Math.max(5, Math.round(v)))
    schedulePersist()
  }
  /** 写作默认 · 目标字数（0 = 未设，否则正整数） */
  function setDefaultTargetWords(v: number): void {
    defaultTargetWords.value = Math.max(0, Math.round(v))
    schedulePersist()
  }
  /** 写作默认 · 每章字数（0 = 未设，否则正整数） */
  function setDefaultChapterTargetWords(v: number): void {
    defaultChapterTargetWords.value = Math.max(0, Math.round(v))
    schedulePersist()
  }
  /** AI 机检 · 短篇严格模式（仅短篇书生效） */
  function setDefaultShortStrict(v: boolean): void {
    defaultShortStrict.value = v
    schedulePersist()
  }
  /** AI 写作 · 文风注入强度 */
  function setStyleInjection(v: 'light' | 'heavy'): void {
    styleInjection.value = v
    schedulePersist()
  }
  /** AI 写作 · 自动确认细纲 */
  function setAutoConfirmOutline(v: boolean): void {
    autoConfirmOutline.value = v
    schedulePersist()
  }
  /** AI 写作 · 批量写作章数（clamp 1-20 取整） */
  function setAiBatchSize(v: number): void {
    aiBatchSize.value = Math.min(20, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** AI 写作 · 单章调用上限（clamp 1-50 取整） */
  function setCallsPerChapter(v: number): void {
    callsPerChapter.value = Math.min(50, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** 关系图 · 自动梳理 */
  function setRelationAutoMine(v: boolean): void {
    relationAutoMine.value = v
    schedulePersist()
  }
  /** 关系图 · 章节增量阈值（clamp 1-20 取整） */
  function setRelationMineThreshold(v: number): void {
    relationMineThreshold.value = Math.min(20, Math.max(1, Math.round(v)))
    schedulePersist()
  }
  /** 知识检索 · 启用 */
  function setRagEnabled(v: boolean): void {
    ragEnabled.value = v
    schedulePersist()
  }
  /** 知识检索 · 提供方（trim；'' = 未设） */
  function setRagProvider(v: string): void {
    ragProvider.value = v.trim()
    schedulePersist()
  }

  return {
    theme,
    proseSize,
    proseLh,
    uiFontCn,
    uiFontEn,
    uiFontSizeStep,
    proseFontCn,
    proseFontEn,
    pageWidth,
    autosaveInterval,
    shelfView,
    chatEnabled,
    compact,
    snapDays,
    snapCount,
    defaultGenre,
    defaultVolumeSize,
    defaultTargetWords,
    defaultChapterTargetWords,
    defaultShortStrict,
    styleInjection,
    autoConfirmOutline,
    aiBatchSize,
    callsPerChapter,
    relationAutoMine,
    relationMineThreshold,
    ragEnabled,
    ragProvider,
    bookPageWidth,
    bookAutosaveInterval,
    effectivePageWidth,
    effectiveAutosaveInterval,
    init,
    apply,
    applyTheme,
    applyCompact,
    setOverlayDimmed,
    syncOverlayDelayed,
    beginOverlaySweep,
    endOverlaySweep,
    setThemeValue,
    setSize,
    setLh,
    setUiFontCn,
    setUiFontEn,
    setUiFontSizeStep,
    setProseFontCn,
    setProseFontEn,
    setPageWidth,
    setAutosaveInterval,
    setShelfView,
    setChatEnabled,
    setCompact,
    setSnapDays,
    setSnapCount,
    setDefaultGenre,
    setDefaultVolumeSize,
    setDefaultTargetWords,
    setDefaultChapterTargetWords,
    setDefaultShortStrict,
    setStyleInjection,
    setAutoConfirmOutline,
    setAiBatchSize,
    setCallsPerChapter,
    setRelationAutoMine,
    setRelationMineThreshold,
    setRagEnabled,
    setRagProvider,
  }
})
