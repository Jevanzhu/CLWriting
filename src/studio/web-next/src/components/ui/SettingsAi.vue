<script setup lang="ts">
// 设置 · AI tab：对话助手/文风注入/调用预算/自动写作/关系图/知识检索。
import { ref, watch, inject } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { getConfig, putConfig } from '../../api/books'
import { friendlyError } from '../../shared/error'
import { SAVE_CONFIG_KEY } from './settings-context'

const ui = useUiStore()
const ws = useWorkspaceStore()
const prefs = usePrefsStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

const styleInjection = ref<'light' | 'heavy'>('light')
const callsPerChapter = ref(10)
const autoConfirmOutline = ref(false)
const batchSize = ref(1)
// 关系图 AI 梳理：手动按钮为主（控成本，方案③决策）；自动梳理默认关，作者可自行开启
const relationAutoMine = ref(false)
const relationMineThreshold = ref(3)
// AI 配置（RAG 保留在 book.yaml）
const ragEnabled = ref(false)
const ragEndpoint = ref('')
const ragModel = ref('')

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open || !name) return
    try {
      const cfg = await getConfig(name)
      styleInjection.value = cfg.style?.injection ?? 'light'
      callsPerChapter.value = cfg.budget?.calls_per_chapter ?? 10
      autoConfirmOutline.value = cfg.auto?.confirm_outline ?? false
      batchSize.value = cfg.auto?.batch_size ?? 1
      relationAutoMine.value = cfg.auto?.relation_auto_mine ?? false
      relationMineThreshold.value = cfg.auto?.relation_mine_threshold ?? 3
      ragEnabled.value = cfg.rag?.enabled ?? false
      ragEndpoint.value = cfg.rag?.endpoint ?? ''
      ragModel.value = cfg.rag?.model ?? ''
    } catch {
      /* 读不到就用默认值展示 */
    }
  },
  { immediate: true },
)

function setStyleInjection(mode: 'light' | 'heavy'): void {
  styleInjection.value = mode
  void saveConfig((c) => {
    if (!c.style) c.style = { injection: 'light' }
    c.style.injection = mode
  })
}
function onCallsInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  callsPerChapter.value = Math.min(50, Math.max(1, Math.round(raw)))
  void saveConfig((c) => {
    if (!c.budget) c.budget = { calls_per_chapter: 10 }
    c.budget.calls_per_chapter = callsPerChapter.value
  })
}
function onAutoConfirmToggle(e: Event): void {
  autoConfirmOutline.value = (e.target as HTMLInputElement).checked
  void saveConfig((c) => {
    if (!c.auto) c.auto = { confirm_outline: false, batch_size: 1 }
    c.auto.confirm_outline = autoConfirmOutline.value
  })
}
function onBatchSizeInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  batchSize.value = Math.min(20, Math.max(1, Math.round(raw)))
  void saveConfig((c) => {
    if (!c.auto) c.auto = { confirm_outline: false, batch_size: 1 }
    c.auto.batch_size = batchSize.value
  })
}
function onRelationAutoMineToggle(e: Event): void {
  relationAutoMine.value = (e.target as HTMLInputElement).checked
  void saveConfig((c) => {
    if (!c.auto) c.auto = { confirm_outline: false, batch_size: 1 }
    c.auto.relation_auto_mine = relationAutoMine.value
  })
}
function onMineThresholdInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  relationMineThreshold.value = Math.min(20, Math.max(1, Math.round(raw)))
  void saveConfig((c) => {
    if (!c.auto) c.auto = { confirm_outline: false, batch_size: 1 }
    c.auto.relation_mine_threshold = relationMineThreshold.value
  })
}

// RAG 配置操作（RAG 保留在 book.yaml）
function onRagToggle(e: Event): void {
  ragEnabled.value = (e.target as HTMLInputElement).checked
  void saveConfig((c) => {
    if (!c.rag) c.rag = {}
    c.rag.enabled = ragEnabled.value
  })
}
/** RAG 地址/模型显式保存：只提交已打开弹窗时缓冲的 v-model 值 */
async function saveRagConfig(): Promise<void> {
  const name = ws.bookName
  if (!name) return
  try {
    const cfg = await getConfig(name)
    if (!cfg.rag) cfg.rag = {}
    cfg.rag.endpoint = ragEndpoint.value || undefined
    cfg.rag.model = ragModel.value || undefined
    await putConfig(name, cfg)
    ui.toast('检索设置已保存', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}
</script>

<template>
  <!-- 单根包裹：见 SettingsBook.vue 说明 -->
  <div class="settings-tab">
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">对话助手</div>
        <div class="setting-item-desc">在工作台显示对话面板，可与 AI 讨论剧情、机检章节</div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="对话助手" :checked="prefs.chatEnabled" @change="prefs.setChatEnabled(($event.target as HTMLInputElement).checked)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">写作风格</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">文风注入</div>
        <div class="setting-item-desc">AI 写正文时遵循文风铁律的强度</div>
      </div>
      <div class="setting-item-control">
        <div class="seg">
          <button :class="{ on: styleInjection === 'light' }" @click="setStyleInjection('light')">轻</button>
          <button :class="{ on: styleInjection === 'heavy' }" @click="setStyleInjection('heavy')">重</button>
        </div>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">AI 预算</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">单章调用上限</div>
        <div class="setting-item-desc">每章 AI 辅助的最大调用次数，防止成本失控</div>
      </div>
      <div class="setting-item-control">
        <input class="num-input" type="number" min="1" max="50" step="1" :value="callsPerChapter" @change="onCallsInput($event)" />
        <span class="val-suffix">次</span>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">自动写作</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">自动确认细纲 <span class="tag-soon">即将支持</span></div>
        <div class="setting-item-desc">AI 生成细纲后自动确认，无需手动点确认</div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="自动确认细纲" :checked="autoConfirmOutline" @change="onAutoConfirmToggle($event)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">批量写作章数</div>
        <div class="setting-item-desc">一次自动写作流程连续写的章数（即将支持）</div>
      </div>
      <div class="setting-item-control">
        <input class="num-input" type="number" min="1" max="20" step="1" :value="batchSize" @change="onBatchSizeInput($event)" />
        <span class="val-suffix">章</span>
      </div>
    </div>
  </section>

  <div class="cfg-card-head">关系图</div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">自动梳理 <span class="tag-soon">即将支持</span></div>
          <div class="setting-item-desc">打开关系图时，若新增章节达到阈值则自动 AI 梳理</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="关系图自动梳理" :checked="relationAutoMine" @change="onRelationAutoMineToggle($event)" />
            <span class="switch-slider"></span>
          </label>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">章节增量阈值 <span class="tag-soon">即将支持</span></div>
          <div class="setting-item-desc">自上次梳理后新增多少章触发自动梳理</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="1" max="20" step="1" :value="relationMineThreshold" @change="onMineThresholdInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
    </section>

  <div class="cfg-card-head">知识检索</div>
  <section class="cfg-card">
    <div class="setting-item">
      <div class="setting-item-info">
        <div class="setting-item-name">启用检索</div>
        <div class="setting-item-desc">开启后 AI 可检索已有章节作为上下文</div>
      </div>
      <div class="setting-item-control">
        <label class="switch">
          <input type="checkbox" aria-label="启用知识检索" :checked="ragEnabled" @change="onRagToggle($event)" />
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <template v-if="ragEnabled">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">嵌入服务地址</div>
          <div class="setting-item-desc">向量嵌入服务的网址</div>
        </div>
        <div class="setting-item-control">
          <input v-model="ragEndpoint" class="text-input" type="text" placeholder="https://..." />
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">嵌入模型</div>
          <div class="setting-item-desc">向量嵌入模型名称</div>
        </div>
        <div class="setting-item-control">
          <input v-model="ragModel" class="text-input" type="text" placeholder="如 text-embedding-3-small" />
        </div>
      </div>
      <div class="rag-save-row">
        <button class="save-btn" @click="saveRagConfig">保存检索设置</button>
      </div>
    </template>
  </section>
  </div>
</template>

<style scoped>
.tag-soon {
  padding: 1px 7px;
  font-size: var(--font-size-xxs);
  font-weight: 600;
  border-radius: 99px;
  background: var(--background-modifier-hover);
  color: var(--text-faint);
}
</style>
