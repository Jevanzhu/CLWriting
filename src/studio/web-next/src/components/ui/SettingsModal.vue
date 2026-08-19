<script setup lang="ts">
// 设置弹窗（Obsidian 风格：左侧分类导航 + 右侧列表项）。
// 容器：管理 tab 切换 + 提供 saveConfig（串行化读写 book.yaml）。
// 各 tab 内容拆分到 Settings*.vue 子组件；设置域共享样式在 settings-shared.css
//（hh §八-16 自本件 <style> 原样搬出——全局样式，全部 Settings* 子件共用）。
import { ref, computed, onMounted, onBeforeUnmount, provide } from 'vue'
import { X, Palette, Type, NotebookPen, Sparkles, ScanSearch, History, BookOpen, Server } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { useWorkspaceStore } from '../../stores/workspace'
import { getConfig, putConfig, type BookConfig } from '../../api/books'
import { friendlyError } from '../../shared/error'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { SAVE_CONFIG_KEY } from './settings-context'
import './settings-shared.css'
import BetaBadge from './BetaBadge.vue'
import SettingsAppearance from './SettingsAppearance.vue'
import SettingsEditor from './SettingsEditor.vue'
import SettingsWriting from './SettingsWriting.vue'
import SettingsAi from './SettingsAi.vue'
import SettingsAnalysis from './SettingsAnalysis.vue'
import SettingsRetention from './SettingsRetention.vue'
import SettingsBook from './SettingsBook.vue'
import AiServicePanel from './AiServicePanel.vue'

const ui = useUiStore()
const ws = useWorkspaceStore()
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)

// IA 重组：全局默认按选项类别拆 4 个独立一级页（写作默认/AI 写作/智能分析/版本保留），
// 「本书」收敛为单页（书名 + 各领域的本书独立设定覆盖组 + 定稿版本 + 存储）——共 8 项导航。
// 「本书」置顶；其余 7 页按 界面（外观/编辑器）/ 写作（默认/AI/分析）/ 系统（保留/提供方）
// 三组小节标题分组（Obsidian 设置导航范式：靠命名分组，无线条）。
type Tab = 'appearance' | 'editor' | 'writing' | 'ai' | 'analysis' | 'retention' | 'book' | 'providers'
const activeTab = ref<Tab>('appearance')
/** 顶栏副标题：当前 tab 的一句话说明（列出该页包含的设置项） */
const TAB_SUBTITLES: Record<Tab, string> = {
  appearance: '主题、界面字体、紧凑模式与书架视图',
  editor: '编辑器字体、排版（字号/行距/段距）、纸张与自动保存',
  writing: '题材、每卷章数、目标字数、每章字数的全局默认——未单独设定的书使用',
  ai: '对话助手与 AI 写作默认：文风注入、批量章数、调用上限',
  analysis: 'AI 机检、关系图、知识检索的全局默认',
  retention: '版本保留全局默认：天数与数量上限',
  book: '书名与各领域的本书独立设定、定稿版本、存储',
  providers: 'AI 与 RAG 提供方增删、测试连接与任务档位',
}
const tabSubtitle = computed(() => TAB_SUBTITLES[activeTab.value])
/** 当前 tab 的配置归属：仅「本书」页为 book（实存 book.yaml），其余 7 页均为 global（跨书共享）。
 * 绑在 settings-content 上即可覆盖整页——本书页内的条目得「本书」徽章，全局页条目得「全局」徽章。 */
const tabScope = computed<'global' | 'book'>(() =>
  activeTab.value === 'book' ? 'book' : 'global',
)

const tabComponents = {
  appearance: SettingsAppearance,
  editor: SettingsEditor,
  writing: SettingsWriting,
  ai: SettingsAi,
  analysis: SettingsAnalysis,
  retention: SettingsRetention,
  book: SettingsBook,
  providers: AiServicePanel,
}
const currentTabComponent = computed(() => tabComponents[activeTab.value])

// ── saveConfig（串行化读写 book.yaml）──
/** 通用：读 → 改 → 写 book.yaml。silent=true 不弹 toast（range 拖动等高频场景）。
 * P1-10：串行化防竞态——快速连续修改时 getConfig 可能在前一 putConfig 完成前发出，
 * 读到旧值覆盖前一修改。用 Promise 队列保证读改写原子序列。 */
let saveChain: Promise<void> = Promise.resolve()
function saveConfig(mutate: (cfg: BookConfig) => void, silent = false): Promise<void> {
  const name = ws.bookName
  if (!name) return Promise.resolve()
  saveChain = saveChain.then(async () => {
    try {
      const cfg = await getConfig(name)
      mutate(cfg)
      await putConfig(name, cfg)
      if (!silent) ui.toast('已保存', 'success')
    } catch (e) {
      ui.toast(friendlyError(e), 'error')
    }
  })
  return saveChain
}
provide(SAVE_CONFIG_KEY, saveConfig)

// Esc 关闭（PromptDialog/ConfirmPrompt 打开时让位——层级更高，先关它们再关设置）
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !ui.settingsOpen) return
  if (ui.promptState || ui.confirmState) return
  ui.closeSettings()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.settingsOpen" class="modal-mask" @click.self="ui.closeSettings">
      <div ref="modalRef" class="settings-modal" role="dialog" aria-modal="true" aria-label="设置" tabindex="-1">
        <div class="modal-head">
          <div class="modal-heading">
            <span class="modal-title">设置</span>
            <span class="modal-subtitle">{{ tabSubtitle }}</span>
          </div>
          <button class="close-btn" data-tip="关闭（Esc）" aria-label="关闭" @click="ui.closeSettings"><X :size="18" /></button>
        </div>
        <div class="settings-split">
          <!-- 左侧分类导航 -->
          <nav class="settings-nav">
            <button class="nav-book" :class="{ active: activeTab === 'book' }" @click="activeTab = 'book'">
              <span class="nav-book-icon"><BookOpen :size="15" /></span>
              <span>本书</span>
            </button>
            <div class="nav-section-label">界面</div>
            <button :class="{ active: activeTab === 'appearance' }" @click="activeTab = 'appearance'">
              <Palette :size="16" /><span>外观与主题</span>
            </button>
            <button :class="{ active: activeTab === 'editor' }" @click="activeTab = 'editor'">
              <Type :size="16" /><span>编辑器排版</span>
            </button>
            <div class="nav-section-label">写作</div>
            <button :class="{ active: activeTab === 'writing' }" @click="activeTab = 'writing'">
              <NotebookPen :size="16" /><span>写作默认</span>
            </button>
            <button :class="{ active: activeTab === 'ai' }" @click="activeTab = 'ai'">
              <Sparkles :size="16" /><span>AI 写作 <BetaBadge /></span>
            </button>
            <button :class="{ active: activeTab === 'analysis' }" @click="activeTab = 'analysis'">
              <ScanSearch :size="16" /><span>智能分析 <BetaBadge /></span>
            </button>
            <div class="nav-section-label">系统</div>
            <button :class="{ active: activeTab === 'retention' }" @click="activeTab = 'retention'">
              <History :size="16" /><span>版本保留</span>
            </button>
            <button :class="{ active: activeTab === 'providers' }" @click="activeTab = 'providers'">
              <Server :size="16" /><span>服务提供方 <BetaBadge /></span>
            </button>
          </nav>

          <!-- 右侧设置内容：data-tab-scope 驱动整页徽章（book 页条目得「本书」，其余 7 页得「全局」） -->
          <div class="settings-content" :data-tab-scope="tabScope">
            <div class="tab-pane">
              <!-- mode="out-in" + keep-alive + :key 是 Vue 3 已知竞态组合：
                   快速切 tab 时缓存命中跳过挂载，但过渡仍等离开动画 → 内容区永久空白。
                   去掉 mode（并行过渡）→ 离开面板 absolute 浮于上层交叉淡出，无堆叠。 -->
              <transition name="tab-fade">
                <keep-alive>
                  <component :is="currentTabComponent" :key="activeTab" />
                </keep-alive>
              </transition>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
