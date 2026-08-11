<script setup lang="ts">
// 设置弹窗（Obsidian 风格：左侧分类导航 + 右侧列表项）。
// 容器：管理 tab 切换 + 提供 saveConfig（串行化读写 book.yaml）。
// 各 tab 内容拆分到 Settings*.vue 子组件。
import { ref, computed, onMounted, onBeforeUnmount, provide } from 'vue'
import { X, Palette, Type, History, BookOpen, Sparkles, Server } from 'lucide-vue-next'
import { useUiStore } from '../../stores/ui'
import { useWorkspaceStore } from '../../stores/workspace'
import { getConfig, putConfig, type BookConfig } from '../../api/books'
import { friendlyError } from '../../shared/error'
import { useFocusTrap } from '../../composables/useFocusTrap'
import { SAVE_CONFIG_KEY } from './settings-context'
import SettingsAppearance from './SettingsAppearance.vue'
import SettingsEditor from './SettingsEditor.vue'
import SettingsBook from './SettingsBook.vue'
import SettingsAi from './SettingsAi.vue'
import SettingsHistory from './SettingsHistory.vue'
import AiServicePanel from './AiServicePanel.vue'

const ui = useUiStore()
const ws = useWorkspaceStore()
const modalRef = ref<HTMLElement | null>(null)
useFocusTrap(modalRef)

type Tab = 'appearance' | 'editor' | 'book' | 'ai' | 'providers' | 'history'
const activeTab = ref<Tab>('appearance')
/** 顶栏副标题：当前 tab 的一句话说明 */
const TAB_SUBTITLES: Record<Tab, string> = {
  appearance: '主题、字体与界面显示',
  editor: '编辑区排版与自动保存',
  book: '本书信息与写作目标',
  ai: 'AI 写作行为与预算',
  providers: 'AI 服务服务商与档位',
  history: '版本保留与定稿档案',
}
const tabSubtitle = computed(() => TAB_SUBTITLES[activeTab.value])
/** 当前 tab 的配置归属：外观/编辑器/AI/服务商 → 全局（跨书共享）；版本历史/书籍 → 本书（跟随当前书） */
const tabScope = computed<'global' | 'book'>(() =>
  activeTab.value === 'history' || activeTab.value === 'book' ? 'book' : 'global',
)

const tabComponents = {
  appearance: SettingsAppearance,
  editor: SettingsEditor,
  book: SettingsBook,
  ai: SettingsAi,
  providers: AiServicePanel,
  history: SettingsHistory,
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

// Esc 关闭
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && ui.settingsOpen) ui.closeSettings()
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
            <button :class="{ active: activeTab === 'appearance' }" @click="activeTab = 'appearance'">
              <Palette :size="16" /><span>外观</span>
            </button>
            <button :class="{ active: activeTab === 'editor' }" @click="activeTab = 'editor'">
              <Type :size="16" /><span>编辑器</span>
            </button>
            <button :class="{ active: activeTab === 'book' }" @click="activeTab = 'book'">
              <BookOpen :size="16" /><span>书籍</span>
            </button>
            <button :class="{ active: activeTab === 'ai' }" @click="activeTab = 'ai'">
              <Sparkles :size="16" /><span>AI</span>
            </button>
            <button :class="{ active: activeTab === 'providers' }" @click="activeTab = 'providers'">
              <Server :size="16" /><span>服务商</span>
            </button>
            <button :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
              <History :size="16" /><span>版本历史</span>
            </button>
          </nav>

          <!-- 右侧设置内容 -->
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

<style>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 150;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: clw-overlay var(--dur-norm) var(--ease-out);
}
.settings-modal {
  width: min(1024px, calc(100vw - 32px));
  height: min(760px, calc(100vh - 48px));
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: clw-appear var(--dur-norm) var(--ease-out);
}

/* ── 顶栏 ── */
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--size-4-4) var(--size-4-6);
  border-bottom: 1px solid var(--background-modifier-border);
  flex-shrink: 0;
}
.modal-heading {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.modal-title {
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--text-normal);
  letter-spacing: -0.01em;
}
.modal-subtitle {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.close-btn:hover {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}

/* ── 左右分栏 ── */
.settings-split {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ── 左侧导航 ── */
.settings-nav {
  width: 184px;
  flex-shrink: 0;
  border-right: 1px solid var(--background-modifier-border);
  padding: var(--size-4-4) var(--size-4-3);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.settings-nav button {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  border: none;
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-s);
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.settings-nav button svg {
  color: var(--text-faint);
  transition: color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.settings-nav button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.settings-nav button:hover svg {
  color: var(--text-muted);
}
.settings-nav button.active {
  background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
  color: var(--text-accent);
  font-weight: 600;
}
.settings-nav button.active svg {
  color: var(--text-accent);
}
/* 激活项左侧指示条 */
.settings-nav button.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 0 2px 2px 0;
  background: var(--interactive-accent);
}

/* ── 右侧内容 ── */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--size-4-5) var(--size-4-6);
}
.tab-pane {
  position: relative;
  min-height: 100%;
  padding-bottom: var(--size-4-6);
}
/* tab 组件单根包裹层：继承 tab-pane 的宽度/居中约束 */
.settings-tab {
  min-height: 100%;
}

/* tab 切换过渡（并行模式）：离开面板绝对定位浮于上层 → 与进入面板交叉淡出，无双面板堆叠。
   离开快（120ms 消失）→ 进入缓（200ms 浮现），形成干净的前后交接感。 */
.tab-fade-enter-active {
  transition: opacity var(--dur-norm) var(--ease-out);
}
.tab-fade-leave-active {
  position: absolute;
  inset: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}
.tab-fade-enter-from {
  opacity: 0;
}
.tab-fade-leave-to {
  opacity: 0;
}

/* ── 空状态 ── */
.empty-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-8) 0;
  color: var(--text-faint);
  font-size: var(--font-size-s);
}

/* ── 卡片容器 ── */
.cfg-card {
  border: 1px solid var(--background-modifier-border);
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: var(--size-4-4);
}
.cfg-card:last-child {
  margin-bottom: 0;
}
.cfg-card-head {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
  padding: 0 var(--size-4-1);
  margin-top: var(--size-4-5);
  margin-bottom: var(--size-4-2);
}
.cfg-card-head:first-child {
  margin-top: 0;
}

/* 卡片内设置项：去掉圆角 + 缩进分割线 */
.cfg-card .setting-item {
  position: relative;
  padding: var(--size-4-3) var(--size-4-4);
  border-radius: 0;
  gap: var(--size-4-4);
}
.cfg-card .setting-item:not(:last-child)::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: var(--size-4-4);
  right: var(--size-4-4);
  height: 1px;
  background: var(--background-modifier-border);
}
.cfg-card .setting-item:hover {
  background: color-mix(in srgb, var(--text-normal) 2%, transparent);
}
/* 卡片内 sub 项更大缩进 */
.cfg-card .setting-item.sub {
  padding-left: var(--size-4-8);
}
/* 卡片内非 setting-item 元素对齐 padding */
.cfg-card .rag-save-row,
.cfg-card .stats-hint {
  padding-left: var(--size-4-4);
  padding-right: var(--size-4-4);
}

/* ── 书籍 banner ── */
.book-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-accent);
  padding: var(--size-4-3) var(--size-4-4);
  margin-bottom: var(--size-4-3);
  border: 1px solid color-mix(in srgb, var(--text-accent) 22%, transparent);
  border-radius: var(--radius-m);
  background: color-mix(in srgb, var(--text-accent) 6%, transparent);
}
.book-banner svg {
  flex-shrink: 0;
  padding: 4px;
  border-radius: var(--radius-s);
  background: color-mix(in srgb, var(--text-accent) 14%, transparent);
}
.book-banner span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 设置项（大间距、呼吸感）── */
.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--size-4-5);
  padding: var(--size-4-4) var(--size-4-3);
  border-radius: var(--radius-s);
  transition: background var(--dur-fast) var(--ease-out);
}
.setting-item:hover {
  background: color-mix(in srgb, var(--text-normal) 2.5%, transparent);
}
.setting-item-info {
  flex: 1;
  min-width: 0;
}
.setting-item-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-s);
  font-weight: 500;
  color: var(--text-normal);
}
/* 配置归属标签（::after 由 data-tab-scope 驱动，非 .sub 项才显示） */
.settings-content[data-tab-scope] .setting-item:not(.sub) .setting-item-name::after {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 99px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  flex-shrink: 0;
}
.settings-content[data-tab-scope="global"] .setting-item:not(.sub) .setting-item-name::after {
  content: "全局";
  color: var(--text-faint);
  background: var(--background-modifier-hover);
}
.settings-content[data-tab-scope="book"] .setting-item:not(.sub) .setting-item-name::after {
  content: "本书";
  color: var(--text-on-accent);
  background: color-mix(in srgb, var(--interactive-accent) 22%, transparent);
}
.setting-item-desc {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  margin-top: 3px;
  line-height: 1.4;
}
/* "仅本书"覆盖开关 */
.scope-btn {
  margin-left: 8px;
  padding: 1px 8px;
  font-size: var(--font-size-xxs);
  font-weight: 600;
  border: 1px solid var(--background-modifier-border);
  border-radius: 99px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.scope-btn:hover {
  color: var(--text-normal);
  border-color: var(--background-modifier-border-active);
}
.scope-btn.on {
  background: color-mix(in srgb, var(--interactive-accent) 22%, transparent);
  border-color: transparent;
  color: var(--text-on-accent);
}
.setting-item-control {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-shrink: 0;
}
.setting-item.sub {
  padding-left: var(--size-4-4);
}
.setting-item.sub .setting-item-name {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-weight: 400;
}

/* ── 数值标签 ── */
.val {
  color: var(--text-normal);
  font-variant-numeric: tabular-nums;
  font-size: var(--font-size-xs);
  min-width: 44px;
  text-align: right;
  font-weight: 500;
}
.val-suffix {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.val-input {
  width: 52px;
  padding: 4px 6px;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  text-align: center;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.val-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.val-input::-webkit-inner-spin-button,
.val-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.backup-summary {
  font-size: var(--font-size-s);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.stats-hint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  padding: var(--size-4-3) 0;
}

/* ── range slider（跨平台统一，替代 accent-color）── */
.setting-item input[type='range'] {
  -webkit-appearance: none;
  appearance: none;
  width: 168px;
  height: 6px;
  border-radius: 3px;
  background: var(--background-modifier-border);
  cursor: pointer;
  outline: none;
}
.setting-item input[type='range']::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--interactive-accent);
  border: 2px solid var(--background-primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  cursor: grab;
  transition: transform var(--dur-fast) var(--ease-out);
}
.setting-item input[type='range']::-webkit-slider-thumb:active {
  cursor: grabbing;
  transform: scale(1.2);
}
.setting-item input[type='range']::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--interactive-accent);
  border: 2px solid var(--background-primary);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  cursor: grab;
}
.setting-item input[type='range']:hover::-webkit-slider-thumb {
  transform: scale(1.15);
}
.setting-item input[type='range']:focus-visible::-webkit-slider-thumb {
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--interactive-accent) 25%, transparent);
}

/* ── segmented control ── */
.seg {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  gap: 2px;
}
.seg button {
  padding: 5px 16px;
  font-size: var(--font-size-s);
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.seg button:hover:not(.on) {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
}
.seg button.on {
  background: var(--background-primary);
  color: var(--text-normal);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

/* ── number / text input ── */
.num-input,
.text-input {
  padding: 6px 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.num-input {
  width: 104px;
  font-variant-numeric: tabular-nums;
}
.text-input {
  width: 220px;
}
.num-input:focus,
.text-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}

/* ── RAG 显式保存行 ── */
.rag-save-row {
  display: flex;
  justify-content: flex-end;
  padding: var(--size-4-3) 0;
}
.save-btn {
  padding: 7px 18px;
  font-size: var(--font-size-s);
  font-weight: 600;
  border: none;
  border-radius: var(--radius-s);
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  cursor: pointer;
}
.save-btn:hover {
  filter: brightness(1.1);
}

/* ── link button ── */
.link-btn {
  padding: 6px 18px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.link-btn:hover {
  background: var(--background-modifier-hover);
}
.link-btn.danger {
  border-color: color-mix(in srgb, var(--text-error) 40%, var(--background-modifier-border));
  color: var(--text-error);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.link-btn.danger:hover {
  background: color-mix(in srgb, var(--text-error) 10%, transparent);
}

/* ── font pair ── */
.font-pair {
  display: flex;
  gap: var(--size-4-2);
}
.font-select {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.font-select:focus {
  border-color: var(--interactive-accent);
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}

/* ── toggle switch ── */
.switch {
  position: relative;
  display: inline-block;
  width: 38px;
  height: 22px;
  cursor: pointer;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.switch-slider {
  position: absolute;
  inset: 0;
  background: var(--background-modifier-border-active);
  border-radius: 22px;
  transition: background var(--dur-fast) var(--ease-out);
}
.switch-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 3px;
  bottom: 3px;
  background: var(--text-on-accent);
  border-radius: 50%;
  transition: transform var(--dur-fast) var(--ease-out);
}
.switch input:checked + .switch-slider {
  background: var(--interactive-accent);
}
.switch input:checked + .switch-slider::before {
  transform: translateX(16px);
}
.switch-slider {
  box-shadow: inset 0 0 0 1px transparent;
}
/* hover 反馈：未选中时轨道轻微提亮 */
.switch:hover input:not(:checked) + .switch-slider {
  background: color-mix(in srgb, var(--background-modifier-border-active) 80%, var(--interactive-accent) 20%);
}
/* 选中态 hover：轨道加深一档 */
.switch:hover input:checked + .switch-slider {
  background: var(--interactive-accent-hover);
}
</style>
