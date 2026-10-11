import { defineStore } from 'pinia'
import { computed, ref, type Ref } from 'vue'
import type { GlobalPrefs } from '../api/prefs'
import { createPrefsDomEffects } from '../composables/usePrefsDomEffects'
import {
  applyPrefsTo,
  createPrefRefs,
  createPrefRows,
  createRowSetters,
  snapshotRows,
  type BookOnlyKey,
  type PrefKey,
  type PrefValueMap,
  type PrefWriteValue,
  type WritablePrefKey,
} from '../shared/prefs-rows'
import { createPrefsPersist } from '../shared/prefs-persist'
import { useUiStore } from './ui'

/**
 * 全局编辑器偏好 store（主题 + 排版 + 字体 + 书架视图 + 版本保留全局默认）。
 *
 * 存储：userData/global.json（APP 级，跨书库共享；对齐 Obsidian 全局配置）。
 * 替代旧 localStorage（LevelDB 黑盒，不可编辑不可备份）。
 *
 * 书级覆盖：pageWidth / autosaveInterval 可被 .clwriting/prefs.json 覆盖。
 * effectivePageWidth = 书级 > 全局；apply 用有效值。
 * 书级覆盖的持久化由 workspace store 统一写入 prefs.json（避免双写冲突）。
 *
 * 版本保留全局默认（snapDays/snapCount → 持久化为 global.json 的 snapMaxDays/snapMaxCount）：
 * 生效链 global.json → 硬编码 14 天 / 30 个（服务端 prune 同链）；所有书统一，
 * book.yaml snapshots 书级覆盖已于砍掉。
 *
 * 书级设定全局托底（同 snapMax* 模式修正口径）：题材/每卷章数/目标字数/
 * 每章字数/短篇严格/自动梳理/增量阈值/启用检索/检索提供方 可被书覆盖；文风注入/自动
 * 确认细纲/批量章数/单章上限（AI 写作组）与版本保留已砍书级，所有书统一。
 * 生效链 book.yaml 对应键 → 此处 → 硬编码回落（ref 初值即回落，服务端合并同链）；
 * 书级覆盖存 book.yaml（「本书」页各领域的「本书使用独立设定」组开关写），不进本 store。
 *
 * 分件（纯移动，行为零变化）：本文件 = 编排壳——建 refs、接线 DOM 副作用与持久化单飞链、
 * 泛型 get/set 出口、书级覆盖两键（effective 计算）、旧 localStorage 迁移、生命周期出口。
 * 键表与读写面（默认值锚/类型锚/PREF_ROWS 行表/守卫/组装/setter 工厂）在
 * shared/prefs-rows.ts（新增一个偏好键的四面同步清单见其头注）；持久化单飞链、409 合并
 * 恢复与跨窗失效重取在 shared/prefs-persist.ts。
 *
 * 对外接口（收口）：偏好读写走泛型 get(key) / set(key, value[, bookOnly])——
 * 键类型由 PREF_ROWS 经 PrefValueMap 推导，拼错键编译期红；书级覆盖与有效值为
 * 直读 ref/computed；写 DOM 与窗控变暗副作用在 composables/usePrefsDomEffects.ts。
 * 类型锚（PrefValueMap / PrefKey / WritablePrefKey 等）自本文件原样再出口（消费方零改动）。
 *
 * 初始化：main.ts 在 mount 前 await init → API 读取 → apply CSS 变量。
 * 首次为空时从旧 localStorage 自动迁移。
 */
export type { BookOnlyKey, PrefKey, PrefValueMap, PrefWriteValue, WritablePrefKey } from '../shared/prefs-rows'

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

export const usePrefsStore = defineStore('prefs', () => {
  // ── 全局偏好（global.json）──
  // refs 初值即硬编码回落，表与默认值单源在 shared/prefs-rows.ts（键集/值型由
  // PrefValueMap 逐键钉死，行表缺行/多行/值型不符任一编译期红）。
  const refs = createPrefRefs()
  const rows = createPrefRows(refs)

  /** 从当前全局 ref 构建 GlobalPrefs 对象（不含书级覆盖）。键序即 JSON 键序（PUT body
   *  字节不变），undefined 序列化丢弃 = 未设不覆盖盘上已有值（机检五键）。 */
  const buildCache = (): GlobalPrefs => snapshotRows(rows)
  /** 将 API 读到的 prefs 逐键守卫应用到各 ref（守卫/边界/取整/trim/白名单见行表）。 */
  const applyPrefs = (p: GlobalPrefs): void => applyPrefsTo(rows, p)

  // ── 书级覆盖（prefs.json；null = 用全局）──
  const bookPageWidth = ref<number | null>(null)
  const bookAutosaveInterval = ref<number | null>(null)

  // ── 有效值（书级 > 全局）──
  const effectivePageWidth = computed(() => bookPageWidth.value ?? refs.pageWidth.value)
  const effectiveAutosaveInterval = computed(() => bookAutosaveInterval.value ?? refs.autosaveInterval.value)

  // ── 写 DOM 与窗控变暗副作用（批次续）：本体迁出 store——
  // applyTheme/setOverlayDimmed（含挂/摘过渡压制 class 的 classList.add('theme-instant')
  // / classList.remove('theme-instant') 两行，本体在 shared/theme-apply.ts）与
  // apply/applyCompact 本体移至 ../composables/usePrefsDomEffects.ts（createPrefsDomEffects
  // 工厂收 prefs refs，行为零变化）；setup 内同步解构接线——usePrefsStore 首次实例化
  // 即接好，init 在 main.ts mount 前调用，启动写 DOM 时序不晚于原实现（无启动闪主题）。
  // overlay-dim.test.ts 对本文件的 theme-instant 源码锁由本注记承接，base.css 的
  // html.theme-instant 规则改名须三处同步（base.css / shared/theme-apply.ts / 本注记）。
  const { apply, applyTheme, applyCompact, setOverlayDimmed } = createPrefsDomEffects({
    theme: refs.theme,
    proseSize: refs.proseSize,
    proseLh: refs.proseLh,
    effectivePageWidth,
    uiFontSizeStep: refs.uiFontSizeStep,
    uiFontCn: refs.uiFontCn,
    uiFontEn: refs.uiFontEn,
    proseFontCn: refs.proseFontCn,
    proseFontEn: refs.proseFontEn,
    compact: refs.compact,
  })

  // ── 持久化（单飞链 + 409 恢复 + 跨窗失效重取在 shared/prefs-persist.ts）──
  // 依赖注入面：快照/守卫应用来自行表，副作用三连来自 usePrefsDomEffects，toast 出口
  // 经 useUiStore（函数内延迟取实例——store 模块环 prefs↔ui 既有口径不变），旧
  // localStorage 迁移读写留在本件（refs 归 store 所有）。
  const persist = createPrefsPersist({
    snapshot: buildCache,
    applyPrefs,
    apply,
    applyTheme,
    applyCompact,
    toast: (msg, kind) => useUiStore().toast(msg, kind),
    migrateLegacy: migrateFromLocalStorage,
    clearLegacy: clearLegacyLocalStorage,
  })

  // ── setter（收口）──
  // 表驱动：「写 ref →（side 副作用）→ schedulePersist」三段式收拢进行工厂（夹取窗
  // win.clamp 与副作用族 side 从行取——与 applyPrefs 守卫、buildCache 组装三面单源），
  // 行工厂之上再收一层键控映射经泛型 set(key, value) 单出口（拼错键编译期红）。
  // 异形保留：setPageWidth / setAutosaveInterval（bookOnly 双分支双 ref 写，双 ref 无法
  // 进单行表——泛型 set 的第三参分支落点）。
  const SETTERS = createRowSetters(rows, { apply, applyTheme, applyCompact, schedulePersist: persist.schedulePersist })

  /** 从旧 localStorage 迁移到 ref（仅首次 cache 为空时调）。返回是否有迁移数据。 */
  function migrateFromLocalStorage(): boolean {
    let has = false
    try {
      const t = localStorage.getItem(OLD_LS.theme)
      if (t === 'dark' || t === 'light') {
        refs.theme.value = t
        has = true
      }
      // 逐键迁移收口为两个带载体 ref 的写函数（ref 类型即判据，无需跨形态断言）：
      // num 只收正有限数（未设/非法/空串一律不迁），str 只收非空串。
      const num = (k: string, r: Ref<number>): void => {
        const v = Number(localStorage.getItem(k))
        if (Number.isFinite(v) && v > 0) {
          r.value = v
          has = true
        }
      }
      const str = (k: string, r: Ref<string>): void => {
        const v = localStorage.getItem(k) ?? ''
        if (v) {
          r.value = v
          has = true
        }
      }
      num(OLD_LS.size, refs.proseSize)
      num(OLD_LS.lh, refs.proseLh)
      num(OLD_LS.pageWidth, refs.pageWidth)
      num(OLD_LS.autosaveInterval, refs.autosaveInterval)
      str(OLD_LS.uiFontCn, refs.uiFontCn)
      str(OLD_LS.uiFontEn, refs.uiFontEn)
      str(OLD_LS.proseFontCn, refs.proseFontCn)
      str(OLD_LS.proseFontEn, refs.proseFontEn)
      const sv = localStorage.getItem(OLD_LS.shelfView)
      if (sv === 'grid' || sv === 'list') {
        refs.shelfView.value = sv
        has = true
      }
    } catch {
      /* localStorage 损坏降级 */
    }
    return has
  }

  /** 迁移完成后清理旧 localStorage 键——旧值残留会让后续
   *  「API 不可达」场景反复误判出伪迁移数据源 */
  function clearLegacyLocalStorage(): void {
    try {
      for (const key of Object.values(OLD_LS)) localStorage.removeItem(key)
    } catch {
      /* localStorage 不可用降级 */
    }
  }

  /** 纸张宽度：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖）——泛型 set 的
   *  pageWidth 分支落点。 */
  function setPageWidth(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookPageWidth.value = v
      apply()
      // 书级持久化由 workspace watch 写 prefs.json 承担——书级键
      // 不在 buildCache 内，再 schedulePersist 是纯冗余 PUT global.json（服务端无条件
      // bump revision → 双窗伪 409）
      return
    }
    refs.pageWidth.value = v
    bookPageWidth.value = null
    apply()
    persist.schedulePersist()
  }
  /** 自动保存间隔：bookOnly=true 写书级覆盖，false 写全局默认（清除覆盖）——泛型 set 的
   *  autosaveInterval 分支落点。 */
  function setAutosaveInterval(v: number, bookOnly = false): void {
    if (bookOnly) {
      bookAutosaveInterval.value = v
      // 同 setPageWidth——书级持久化归 workspace watch，跳过全局 PUT
      return
    }
    refs.autosaveInterval.value = v
    bookAutosaveInterval.value = null
    persist.schedulePersist()
  }

  /** 泛型读：取承载 ref 的 .value——在 computed/watch/渲染效应内调用照常建立响应依赖
   *  （等价旧 ref 直读面）。键类型由 PrefValueMap 推导，拼错键编译期红。 */
  function get<K extends PrefKey>(key: K): PrefValueMap[K] {
    return rows[key].r.value
  }

  /** 泛型写：31 键走 SETTERS 行工厂（夹取/trim/副作用逐键同旧平铺 setter）；pageWidth/
   *  autosaveInterval 两键带 bookOnly 书级覆盖第三参（缺省 false）。两个重载把「哪些键
   *  带第三参」钉进类型面：二元键传第三参、值型不符均编译期红（重载 1 先试——只有
   *  bookOnly 两键吃第三参；非 bookOnly 键落重载 2，无第三参位）。 */
  function set<K extends BookOnlyKey>(key: K, value: number, bookOnly?: boolean): void
  function set<K extends PrefKey>(key: K, value: PrefWriteValue<K>): void
  function set(key: PrefKey, value: unknown, bookOnly?: boolean): void {
    if (key === 'pageWidth') {
      setPageWidth(value as number, bookOnly ?? false) // 重载 1 保证 number/bookOnly
      return
    }
    if (key === 'autosaveInterval') {
      setAutosaveInterval(value as number, bookOnly ?? false)
      return
    }
    // key 已排除 bookOnly 两键（控制流收窄到 WritablePrefKey）；实现体必须兼容重载 1
    // 的 (number, bookOnly?) 形态故 value 只能取宽型——键值配对由重载面保证，此处把
    // 宽型 value 交回键控映射（唯一的值面收窄：收到「可写键的值型并集」，非 any）。
    writeWritable(key, value as PrefWriteValue<WritablePrefKey>)
  }

  /** SETTERS 的分发口：泛型 K 下索引映射得该键的 setter 型（联合键索引得联合函数型，
   *  调用联合函数要求参数取交集——那是本件要避免的形态）——本函数用泛型把相关性留住，
   *  调用方 set 的实现体只需一次值面收窄。 */
  function writeWritable<K extends WritablePrefKey>(key: K, value: PrefWriteValue<K>): void {
    SETTERS[key](value)
  }

  return {
    // ── 泛型读写面（键类型由 PrefValueMap 推导；pageWidth/autosaveInterval 带书级覆盖第三参）──
    get,
    set,
    // ── 书级覆盖与有效值（不进行表：持久化归 workspace 的 prefs.json，消费方直写 ref）──
    bookPageWidth,
    bookAutosaveInterval,
    effectivePageWidth,
    effectiveAutosaveInterval,
    // ── 生命周期与冲刷（本体在 shared/prefs-persist.ts）──
    init: persist.init,
    flushPendingPersist: persist.flushPendingPersist,
    /** 跨窗失效刷新（收到他窗 prefs 落盘广播时调用）：GET + 脏键合并，不落盘（见其注） */
    refreshOnRemoteChange: persist.refreshOnRemoteChange,
    // ── 副作用句柄（本体在 composables/usePrefsDomEffects.ts；受保护消费方经 store 出口：
    // workspace.ts 直调 apply，ui.ts 遮罩链直调 setOverlayDimmed——两者签名逐位不变）──
    apply,
    setOverlayDimmed,
  }
})
