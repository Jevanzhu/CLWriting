<script setup lang="ts">
// 设置 · 本书页（单页，IA 重组后不再有页内子标签）：
// 书名 banner + 基本信息（书名，唯一纯书级项）+ 覆盖组（编辑排版/写作默认/智能分析——各
// 全局默认已拆到对应独立一级页；编辑排版即纸张宽度/自动保存的书级覆盖，直连 prefs store）
// + 定稿版本 + 存储。AI 写作与版本保留起砍掉书级（一律跟随全局），不再出现在本书页。
// 覆盖组拆成子组件各自独立拉 config——书级配置读走 workspace.loadBookConfig 单源
//（同书在途合并 + 缓存复用），故本书页 + Analysis + Writing 各点的读取共享一次请求，
// 不为「父级统一状态」另造协调面。
// 书名改动走全量改名（POST /rename：磁盘目录 + books.jsonl 登记 + active 指针 + book.yaml title 同步），
// 成功后路由切到新名——防「书名/文件夹/登记名」三分歧。
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { useDocStore } from '../../stores/doc'
import { renameBook } from '../../api/books'
import { getEventStoreFootprint, type EventStoreFootprint } from '../../api/health'
import { notifyCrossWindow } from '../../shared/cross-window'
import { friendlyError } from '../../shared/error'
import { migrateBookKeyedState } from '../../composables/useShelf' // 改名迁移渲染层按书键控状态——删除链（useShelf deleteBooks）
import { useStaleGuard } from '../../composables/useStaleGuard'
import { parseNumericInput } from '../../shared/numeric-input'
import { usePrefsStore } from '../../stores/prefs'
import SettingsBookWriting from './SettingsBookWriting.vue'
import SettingsBookAnalysis from './SettingsBookAnalysis.vue'
import SettingsBookRetention from './SettingsBookRetention.vue'
import SettingItem from './SettingItem.vue'
import SettingToggle from './SettingToggle.vue'

const ui = useUiStore()
const ws = useWorkspaceStore()
const router = useRouter()
const doc = useDocStore()
const prefs = usePrefsStore()

// ── 编辑排版（纸张宽度/自动保存）书级覆盖 —— 直连 prefs store book ref。
// 关闭 = 跟随全局默认（book 置 null，不改动全局默认）；开启 = 写本书覆盖。
// 持久化由 workspace 的 startPersistWatch 统一写 prefs.json（本页不碰 book.yaml）。
const pfwOverride = computed(() => prefs.bookPageWidth !== null)
const asOverride = computed(() => prefs.bookAutosaveInterval !== null)
const pfwEff = computed(() => prefs.bookPageWidth ?? prefs.get('pageWidth'))
const asEff = computed(() => prefs.bookAutosaveInterval ?? prefs.get('autosaveInterval'))
function onPfwToggle(v: boolean): void {
  prefs.bookPageWidth = v ? prefs.effectivePageWidth : null
  prefs.apply()
}
function onAsToggle(v: boolean): void {
  prefs.bookAutosaveInterval = v ? prefs.effectiveAutosaveInterval : null
  prefs.apply()
}
function onPfwInput(v: number): void {
  prefs.bookPageWidth = v
  prefs.apply()
}
function onAsInput(v: number): void {
  prefs.bookAutosaveInterval = v
  prefs.apply()
}
// 书级 num-input（range 配套数字输入）改共享 helper + 组件层钳制——此前
// `Number('')===0` 穿透直写 prefs.bookPageWidth（store 的 bookOnly 分支无钳制），
// apply 落 `--page-width: 0px` 页宽当场塌掉；空串/非数字不写，合法值钳到滑杆
// 同款 min/max（纸宽 600-1400、间隔 5-120）。五处组件已接 helper，此处是唯一漏点
function onPfwNumChange(e: Event): void {
  const v = parseNumericInput(e)
  if (v === null) return
  onPfwInput(Math.min(1400, Math.max(600, v)))
}
function onAsNumChange(e: Event): void {
  const v = parseNumericInput(e)
  if (v === null) return
  onAsInput(Math.min(120, Math.max(5, v)))
}

const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)
const hasBook = computed(() => !!ws.bookName)

/** 事件库体积读数（health/event-store）：null = 数据目录未配置 / 库不在位 / 读取失败——渲染缺省值 */
const eventStore = ref<EventStoreFootprint | null>(null)

/** 字节数人性化（口径同 SettingsBookRetention 的占用显示）。 */
function formatBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const eventStoreText = computed(() => {
  const bytes = eventStore.value?.bytes
  return bytes == null ? '—' : formatBytes(bytes)
})
/** 超阈指引里的阈值文案：只渲染服务端给的阈值原值，前端不另算超阈判据。 */
const eventStoreThresholdText = computed(() => formatBytes(eventStore.value?.warnThresholdBytes ?? 0))

const bookTitle = ref('')
/** 打开设置时读到的书名基线：判断是否真的改了名（防同名重存触发无谓改名）。 */
const titleBaseline = ref('')

async function openBookDir(): Promise<void> {
  if (!ws.bookName) return
  // IPC 失败不再静默（书目录被外部移动等）——toast 交代
  try {
    await window.clwritingDesktop?.openBookDir(ws.bookName)
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

// 配置加载代守卫（只修了兄弟组件 SettingsBookAnalysis）——本组件
// 的 titleBaseline 同样会被在途旧响应污染：A 书在途配置读取迟到落地 B 书面板后，
// 书名框显示 A 书标题并污染改名基线（对齐 SettingsBookAnalysis 的 loadGen + 双复检口径）。
// 裸计数器换装 useStaleGuard。
const loadGen = useStaleGuard()

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open) return
    const gen = loadGen.begin()
    // 无书打开：整页空态（banner/书名/覆盖组/存储全部隐藏），基线复位
    if (!name) {
      bookTitle.value = ''
      titleBaseline.value = ''
      eventStore.value = null
      return
    }
    try {
      // 配置读走 workspace.loadBookConfig 单源（与覆盖组各子页共享一次请求与缓存）；
      // 读不到（error 面）与失败同口径——书名留空展示
      const r = await ws.loadBookConfig(name)
      if (loadGen.stale(gen) || ws.bookName !== name) return // 双复检：代 + 书名
      if (!r.error) {
        bookTitle.value = r.config.book?.title ?? ''
        titleBaseline.value = bookTitle.value
      }
    } catch {
      /* 读不到书名就留空展示 */
    }
    // 事件库体积读数：与书名同代守卫（在途旧书的迟到读数不落新书面板）；只读探测失败按缺省值
    try {
      const f = await getEventStoreFootprint(name)
      if (loadGen.stale(gen) || ws.bookName !== name) return
      eventStore.value = f.bytes == null ? null : f
    } catch {
      if (!loadGen.stale(gen) && ws.bookName === name) eventStore.value = null
    }
  },
  { immediate: true },
)

// 改名在途锁——改名是重操作（冲排 + 目录/登记/active 搬家 +
// 事件库迁移），二连发（连点回车/双 change）时第二笔在第一笔进行中对旧名发起 renameBook，
// 必然 404 或撞半途态（数据无损、体验受损）。在途直接吞掉：成功路径会 router.replace 到
// 新名整树重挂，输入框随 watch 重载对齐，无需额外提示。
let renaming = false
async function onBookTitleChange(): Promise<void> {
  if (renaming) return
  renaming = true
  try {
    await doBookTitleChange()
  } finally {
    renaming = false
  }
}
async function doBookTitleChange(): Promise<void> {
  const name = ws.bookName
  if (!name) return
  const next = bookTitle.value.trim()
  // 空书名 → 回退显示当前名（book.yaml 校验非空）
  if (!next) {
    bookTitle.value = titleBaseline.value
    return
  }
  if (next === titleBaseline.value) return
  // 带未决冲突的脏文档不在 flushDirty 清单内（doc store 过滤 conflict 项）也不落盘
  // ——放行改名后「留在本书」回退到已搬走的旧书目录，树/心跳/保存全 404。前置拦截。
  const conflicted = doc.conflictedDirtyDocs()
  if (conflicted.length > 0) {
    ui.toast(`有 ${conflicted.length} 篇文档存在未解决的修改冲突，请先处理（重载或覆盖）后再改名`, 'error')
    return
  }
  // 改名 = 磁盘目录+登记+active 一起搬；先落盘未保存的正文编辑，
  // 防目录搬家后旧名 URL 404 导致编辑丢失
  // 冲排失败必须中止改名——flushDirty 返回保存失败的 docId 清单，此前
  // 被丢弃照常改名：目录搬走后旧名 URL 404，这些未落盘编辑的救援路径彻底断裂
  const flushFailed = await doc.flushDirty()
  if (flushFailed.length > 0) {
    ui.toast(`有 ${flushFailed.length} 篇文档保存失败，改名会中断其找回路径——请先重试保存或解决冲突后再改名`, 'error')
    return
  }
  try {
    const res = await renameBook(name, next)
    titleBaseline.value = res.name
    // kk-改名成功但事件库迁移失败 → 警告而非静默成功（历史对话/审计暂留在旧名下，
    // 服务端已保旧库原地完整，重试改名前先处理在跑任务）
    if (res.eventsMigrationFailed) {
      ui.toast('已改名，但历史对话/事件的迁移失败了（数据仍完整保留，可重试改名恢复关联）', 'error')
    } else {
      ui.toast('已保存', 'success')
    }
    if (res.renamed && res.name !== name) {
      // 改名迁移渲染层按书键控状态——删除链（useShelf deleteBooks）
      // 同族五件的「清理旧名 + 值搬家」：章号记忆 / 失败草稿 / 误报灰显 / 梗概 / 首开
      // 标记（此前改名零迁移，旧名条目成孤儿 + 新名侧功能丢失）
      migrateBookKeyedState(name, res.name)
      // 书名搬家即服务端 book.yaml 已变（title 随改名同步）——本窗丢旧/新名两侧配置缓存，
      // 他窗丢缓存，值各自重取（改名是低频重操作，此处直召 store 与失效通知同点）
      ws.invalidateBookConfig()
      notifyCrossWindow(['book-config'])
      // 全量切换：路由换新名 → Book.vue watch 统一清 store / 载 prefs / seed 对话
      void router.replace(`/book/${encodeURIComponent(res.name)}`)
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
    // 失败回退输入框为当前书名
    bookTitle.value = titleBaseline.value
  }
}
</script>

<template>
  <!-- 单根包裹：多根 fragment 在 <Transition> 下无法动画（Vue warn）。
       本页全部内容依赖当前书——无书打开时整页空态（四个覆盖组随 v-if 一起卸载复位）。 -->
  <div class="settings-tab">
    <template v-if="hasBook">
      <div class="book-banner">
        <BookOpen :size="16" />
        <span>{{ ws.bookName }}</span>
      </div>

      <div class="cfg-card-head">基本信息</div>
      <section class="cfg-card">
        <SettingItem name="书名" desc="显示在书架和标题栏">
          <input
            v-model="bookTitle"
            class="text-input"
            type="text"
            placeholder="书名"
            aria-label="书名"
            @change="onBookTitleChange"
          />
        </SettingItem>
      </section>

      <!-- 覆盖组：编辑排版（纸张宽度/自动保存 书级覆盖）+ 写作默认 + 智能分析（AI 写作/版本保留已砍书级，见各组件头注释） -->
      <div class="cfg-card-head">编辑排版</div>
      <section class="cfg-card">
        <SettingToggle name="纸张宽度" ariaLabel="本书独立设定纸张宽度" :checked="pfwOverride" @change="onPfwToggle">
          <template #desc>
            当前生效 {{ pfwEff }}px{{ pfwOverride ? '（本书独立设定）' : '（跟随全局默认）' }}
          </template>
        </SettingToggle>
        <SettingItem v-if="pfwOverride" sub name="本书纸宽">
          <input
            type="range"
            min="600"
            max="1400"
            step="20"
            :value="prefs.bookPageWidth ?? 1020"
            @input="onPfwInput(Number(($event.target as HTMLInputElement).value))"
          />
          <input
            class="num-input"
            type="number"
            min="600"
            max="1400"
            step="20"
            :value="prefs.bookPageWidth ?? ''"
            aria-label="本书纸宽"
            @change="onPfwNumChange($event)"
          />
          <span class="val-suffix">px</span>
        </SettingItem>
        <SettingToggle name="自动保存" ariaLabel="本书独立设定自动保存" :checked="asOverride" @change="onAsToggle">
          <template #desc> 当前生效 {{ asEff }}s{{ asOverride ? '（本书独立设定）' : '（跟随全局默认）' }} </template>
        </SettingToggle>
        <SettingItem v-if="asOverride" sub name="本书自动保存间隔">
          <input
            type="range"
            min="5"
            max="120"
            step="5"
            :value="prefs.bookAutosaveInterval ?? 30"
            @input="onAsInput(Number(($event.target as HTMLInputElement).value))"
          />
          <input
            class="num-input"
            type="number"
            min="5"
            max="120"
            step="5"
            :value="prefs.bookAutosaveInterval ?? ''"
            aria-label="本书自动保存间隔"
            @change="onAsNumChange($event)"
          />
          <span class="val-suffix">s</span>
        </SettingItem>
      </section>
      <SettingsBookWriting />
      <SettingsBookAnalysis />
      <SettingsBookRetention />

      <!-- 存储：体积面健康项对作者可见（浏览器版也渲染——体积读数不依赖桌面 IPC），
           仅「书库目录」需要桌面通道在文件管理器里打开 -->
      <div class="cfg-card-head">存储</div>
      <section class="cfg-card">
        <SettingItem name="事件库">
          <template #desc>
            <span v-if="eventStore?.overThreshold" data-testid="event-store-hint">
              已达提示阈值（{{
                eventStoreThresholdText
              }}）：对话、审计与机检历史只增不减——可在「审计」页「清除事件史」、
              或在对话面板「清空对话」回收这部分空间。
            </span>
            <span v-else>对话、审计与机检历史的数据库，不自动清理。</span>
          </template>
          <span class="backup-summary" data-testid="event-store-size">{{ eventStoreText }}</span>
        </SettingItem>
        <SettingItem v-if="hasDesktop" name="书库目录" desc="在文件管理器中打开">
          <button class="link-btn" @click="openBookDir">打开</button>
        </SettingItem>
      </section>
    </template>
    <div v-else class="empty-tab">
      <BookOpen :size="28" />
      <p>请先打开一本书</p>
    </div>
  </div>
</template>
