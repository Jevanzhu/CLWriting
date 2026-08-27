<script setup lang="ts">
// 设置 · 本书页（单页，IA 重组后不再有页内子标签）：
// 书名 banner + 基本信息（书名，唯一纯书级项）+ 覆盖组（编辑排版/写作默认/智能分析——各
// 全局默认已拆到对应独立一级页；编辑排版即纸张宽度/自动保存的书级覆盖，直连 prefs store）
// + 定稿版本 + 存储。AI 写作与版本保留 2026-08-19 起砍掉书级（一律跟随全局），不再出现在本书页。
// 覆盖组拆成子组件各自独立拉 config（设置打开时共 2 次 getConfig，可接受——不引入父级统一状态）。
// 书名改动走全量改名（POST /rename：磁盘目录 + books.jsonl 登记 + active 指针 + book.yaml title 同步），
// 成功后路由切到新名——防「书名/文件夹/登记名」三分歧。
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { useDocStore } from '../../stores/doc'
import { getConfig, renameBook } from '../../api/books'
import { friendlyError } from '../../shared/error'
import { usePrefsStore } from '../../stores/prefs'
import SettingsBookWriting from './SettingsBookWriting.vue'
import SettingsBookAnalysis from './SettingsBookAnalysis.vue'
import SettingsBookRetention from './SettingsBookRetention.vue'

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
const pfwEff = computed(() => prefs.bookPageWidth ?? prefs.pageWidth)
const asEff = computed(() => prefs.bookAutosaveInterval ?? prefs.autosaveInterval)
function onPfwToggle(e: Event): void {
  prefs.bookPageWidth = (e.target as HTMLInputElement).checked ? prefs.effectivePageWidth : null
  prefs.apply()
}
function onAsToggle(e: Event): void {
  prefs.bookAutosaveInterval = (e.target as HTMLInputElement).checked ? prefs.effectiveAutosaveInterval : null
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

const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)
const hasBook = computed(() => !!ws.bookName)

const bookTitle = ref('')
/** 打开设置时读到的书名基线：判断是否真的改了名（防同名重存触发无谓改名）。 */
const titleBaseline = ref('')

async function openBookDir(): Promise<void> {
  if (!ws.bookName) return
  await window.clwritingDesktop?.openBookDir(ws.bookName)
}

// R64-4（十二轮）：配置加载代守卫（R63-3 只修了兄弟组件 SettingsBookAnalysis）——本组件
// 的 titleBaseline 同样会被在途旧响应污染：A 书在途 getConfig 迟到落地 B 书面板后，
// 书名框显示 A 书标题并污染改名基线（对齐 SettingsBookAnalysis 的 loadGen + 双复检口径）
let loadGen = 0

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open) return
    const gen = ++loadGen
    // 无书打开：整页空态（banner/书名/覆盖组/存储全部隐藏），基线复位
    if (!name) {
      bookTitle.value = ''
      titleBaseline.value = ''
      return
    }
    try {
      const cfg = await getConfig(name)
      if (gen !== loadGen || ws.bookName !== name) return // R64-4 双复检：代 + 书名
      bookTitle.value = cfg.book?.title ?? ''
      titleBaseline.value = bookTitle.value
    } catch {
      /* 读不到书名就留空展示 */
    }
  },
  { immediate: true },
)

async function onBookTitleChange(): Promise<void> {
  const name = ws.bookName
  if (!name) return
  const next = bookTitle.value.trim()
  // 空书名 → 回退显示当前名（book.yaml 校验非空）
  if (!next) {
    bookTitle.value = titleBaseline.value
    return
  }
  if (next === titleBaseline.value) return
  // 改名 = 磁盘目录+登记+active 一起搬；先落盘未保存的正文编辑，
  // 防目录搬家后旧名 URL 404 导致编辑丢失
  // R66-34（十四轮）：冲排失败必须中止改名——flushDirty 返回保存失败的 docId 清单，此前
  // 被丢弃照常改名：目录搬走后旧名 URL 404，这些未落盘编辑的救援路径彻底断裂
  const flushFailed = await doc.flushDirty()
  if (flushFailed.length > 0) {
    ui.toast(`有 ${flushFailed.length} 篇文档保存失败，改名会中断其找回路径——请先重试保存或解决冲突后再改名`, 'error')
    return
  }
  try {
    const res = await renameBook(name, next)
    titleBaseline.value = res.name
    // kk-P1-3：改名成功但事件库迁移失败 → 警告而非静默成功（历史对话/审计暂留在旧名下，
    // 服务端已保旧库原地完整，重试改名前先处理在跑任务）
    if (res.eventsMigrationFailed) {
      ui.toast('已改名，但历史对话/事件的迁移失败了（数据仍完整保留，可重试改名恢复关联）', 'error')
    } else {
      ui.toast('已保存', 'success')
    }
    if (res.renamed && res.name !== name) {
      // 全量切换：路由换新名 → Book.vue watch 统一清 store / 载 prefs / seed 对话
      router.replace(`/book/${encodeURIComponent(res.name)}`)
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
        <div class="setting-item">
          <div class="setting-item-info">
            <div class="setting-item-name">书名</div>
            <div class="setting-item-desc">显示在书架和标题栏</div>
          </div>
          <div class="setting-item-control">
            <input v-model="bookTitle" class="text-input" type="text" placeholder="书名" aria-label="书名" @change="onBookTitleChange" />
          </div>
        </div>
      </section>

      <!-- 覆盖组：编辑排版（纸张宽度/自动保存 书级覆盖）+ 写作默认 + 智能分析（AI 写作/版本保留已砍书级，见各组件头注释） -->
      <div class="cfg-card-head">编辑排版</div>
      <section class="cfg-card">
        <div class="setting-item">
          <div class="setting-item-info">
            <div class="setting-item-name">纸张宽度</div>
            <div class="setting-item-desc">
              当前生效 {{ pfwEff }}px{{ pfwOverride ? '（本书独立设定）' : '（跟随全局默认）' }}
            </div>
          </div>
          <div class="setting-item-control">
            <label class="switch">
              <input type="checkbox" aria-label="本书独立设定纸张宽度" :checked="pfwOverride" @change="onPfwToggle($event)" />
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>
        <div v-if="pfwOverride" class="setting-item sub">
          <div class="setting-item-info">
            <div class="setting-item-name">本书纸宽</div>
          </div>
          <div class="setting-item-control">
            <input type="range" min="600" max="1400" step="20" :value="prefs.bookPageWidth ?? 1020" @input="onPfwInput(Number(($event.target as HTMLInputElement).value))" />
            <input class="num-input" type="number" min="600" max="1400" step="20" :value="prefs.bookPageWidth ?? ''" aria-label="本书纸宽" @change="onPfwInput(Number(($event.target as HTMLInputElement).value))" />
            <span class="val-suffix">px</span>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-item-info">
            <div class="setting-item-name">自动保存</div>
            <div class="setting-item-desc">
              当前生效 {{ asEff }}s{{ asOverride ? '（本书独立设定）' : '（跟随全局默认）' }}
            </div>
          </div>
          <div class="setting-item-control">
            <label class="switch">
              <input type="checkbox" aria-label="本书独立设定自动保存" :checked="asOverride" @change="onAsToggle($event)" />
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>
        <div v-if="asOverride" class="setting-item sub">
          <div class="setting-item-info">
            <div class="setting-item-name">本书自动保存间隔</div>
          </div>
          <div class="setting-item-control">
            <input type="range" min="5" max="120" step="5" :value="prefs.bookAutosaveInterval ?? 30" @input="onAsInput(Number(($event.target as HTMLInputElement).value))" />
            <input class="num-input" type="number" min="5" max="120" step="5" :value="prefs.bookAutosaveInterval ?? ''" aria-label="本书自动保存间隔" @change="onAsInput(Number(($event.target as HTMLInputElement).value))" />
            <span class="val-suffix">s</span>
          </div>
        </div>
      </section>
      <SettingsBookWriting />
      <SettingsBookAnalysis />
      <SettingsBookRetention />

      <template v-if="hasDesktop">
        <div class="cfg-card-head">存储</div>
        <section class="cfg-card">
          <div class="setting-item">
            <div class="setting-item-info">
              <div class="setting-item-name">书库目录</div>
              <div class="setting-item-desc">在文件管理器中打开</div>
            </div>
            <div class="setting-item-control">
              <button class="link-btn" @click="openBookDir">打开</button>
            </div>
          </div>
        </section>
      </template>
    </template>
    <div v-else class="empty-tab">
      <BookOpen :size="28" />
      <p>请先打开一本书</p>
    </div>
  </div>
</template>
