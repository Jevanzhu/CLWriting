<script setup lang="ts">
// 设置 · AI tab：对话助手/文风注入/调用预算/自动写作/关系图/知识检索。
import { ref, watch, inject, onUnmounted } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { usePrefsStore } from '../../stores/prefs'
import { getConfig, putConfig, getRagStatus, triggerRagBuild, setRagApiKey, type RagStatus } from '../../api/books'
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
// RAG 建索引状态（cc 批4 P1-8）：api_key 不入 book.yaml（落 rag.secret），单独输入
const ragApiKey = ref('')
const ragStatus = ref<RagStatus | null>(null)
const ragBuilding = ref(false)
const ragStatusText = ref('')
let ragPollTimer: ReturnType<typeof setInterval> | undefined
let ragPolling = false

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
      // 拉一次建索引状态（不阻塞配置读取）
      void refreshRagStatus(name)
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

// ── RAG 建索引（cc 批4 P1-8）：api_key 落 rag.secret，建索引后台跑 + 轮询 ──

/** api_key 单独保存：落 .clwriting/rag.secret（gitignore 区，H1 绝不进 book.yaml） */
async function saveRagApiKey(): Promise<void> {
  const name = ws.bookName
  const key = ragApiKey.value.trim()
  if (!name || !key) return
  try {
    await setRagApiKey(name, key)
    ragApiKey.value = '' // 不回显（凭据）
    ui.toast('API Key 已保存', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

/** 刷新建索引状态（读 .rag.db 现状 + 最近结果） */
async function refreshRagStatus(name?: string): Promise<void> {
  const book = name ?? ws.bookName
  if (!book) return
  try {
    const s = await getRagStatus(book)
    ragStatus.value = s
    ragBuilding.value = s.running
    if (s.running) {
      ragStatusText.value = '索引构建中…'
    } else if (s.lastResult && s.lastResult.ok) {
      // 增量结果：本次有新增报本次数，纯增量（0 新块）报库内总数
      ragStatusText.value =
        s.lastResult.chapterCount > 0
          ? `已索引 ${s.lastResult.chapterCount} 章 / ${s.lastResult.chunkCount} 块`
          : `索引已是最新：共 ${s.indexedChapters} 章 / ${s.chunkCount} 块`
    } else if (s.lastResult) {
      ragStatusText.value = `索引失败：${s.lastResult.error ?? '未知错误'}`
    } else if (s.indexedChapters > 0) {
      ragStatusText.value = `已索引 ${s.indexedChapters} 章 / ${s.chunkCount} 块`
    } else {
      ragStatusText.value = '尚未建立索引'
    }
  } catch {
    /* 状态拉不到不打扰（如书未配置） */
  }
}

/** 触发建索引：后台任务，轮询 status 直到完成（组件卸载时清理定时器） */
async function startRagBuild(): Promise<void> {
  const name = ws.bookName
  if (!name || ragBuilding.value) return
  try {
    await triggerRagBuild(name)
    ragBuilding.value = true
    ragStatusText.value = '索引构建中…'
    void pollRagStatus(name)
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

async function pollRagStatus(name: string): Promise<void> {
  if (ragPolling) return
  ragPolling = true
  ragPollTimer = setInterval(async () => {
    if (!ragBuilding.value) {
      clearInterval(ragPollTimer)
      ragPollTimer = undefined
      ragPolling = false
      return
    }
    await refreshRagStatus(name)
    if (!ragBuilding.value) {
      clearInterval(ragPollTimer)
      ragPollTimer = undefined
      ragPolling = false
    }
  }, 1500)
}

onUnmounted(() => {
  if (ragPollTimer) {
    clearInterval(ragPollTimer)
    ragPollTimer = undefined
  }
  ragPolling = false
})
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
        <div class="setting-item-desc">一次自动写作流程连续写的章数，中途红项触顶会停在当前章</div>
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
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">API Key</div>
          <div class="setting-item-desc">嵌入服务密钥，落 .clwriting/rag.secret（不进 book.yaml）</div>
        </div>
        <div class="setting-item-control">
          <input v-model="ragApiKey" class="text-input" type="password" placeholder="留空则用环境变量 CLWRITING_RAG_API_KEY" />
        </div>
      </div>
      <div class="rag-save-row">
        <button class="save-btn" @click="saveRagConfig">保存检索设置</button>
        <button class="save-btn" @click="saveRagApiKey" :disabled="!ragApiKey.trim()">保存 API Key</button>
      </div>
      <div class="rag-build-row">
        <button class="save-btn" @click="startRagBuild" :disabled="ragBuilding">{{ ragBuilding ? '构建中…' : '建立索引' }}</button>
        <span class="rag-status" :class="{ running: ragBuilding }">{{ ragStatusText }}</span>
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

.rag-build-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.rag-status {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}

.rag-status.running {
  color: var(--text-accent);
}
</style>
