<script setup lang="ts">
// AI 提供方管理面板（设置页「服务提供方」tab 的内容）——编排层。
// 应用级配置，跨书共享，存 userData/providers.json。
// 阶段 14 第二步（§6.3 统一 store + I2 卡片化单卡展开 + I5 内嵌新增）：
// 数据源收敛到 useProviderStore（AI + RAG + 档位 + 模型清单 + revision 单份）；
// 本层只保留编排态（分页 tab / 展开互斥 / 新增卡 / 档位草稿）与确认弹窗、可达性联动。
import { ref, onMounted } from 'vue'
import { MessageSquare, Database } from 'lucide-vue-next'
import {
  type ProviderConfDto,
  type Protocol,
  type AuthStrategy,
  type TierSlot,
  type RagProviderDto,
} from '../../api/providers'
import '../../styles/providers.css'
import { useUiStore } from '../../stores/ui'
import { useProviderStore } from '../../stores/provider'
import { apiKeyFailure, validateModels, type ModelRowDraft } from '../../shared/provider-format'
import AiProviderList from './AiProviderList.vue'
import AiProviderEditor from './AiProviderEditor.vue'
import TierSection from './TierSection.vue'
import RagProviderList from './RagProviderList.vue'
import RagProviderEditor from './RagProviderEditor.vue'

const ui = useUiStore()
const store = useProviderStore()

// 内部分页：AI 提供方（聊天模型 + 任务档位）/ RAG 提供方（嵌入检索）
const panelTab = ref<'ai' | 'rag'>('ai')

// ── 编排态（数据本体在 store） ──
// 单卡就地展开互斥（照搬 DSH ModelsSection §四「编辑 = setEditing(open ? undefined : target)」）：
// AI 与 RAG 各自至多一张卡展开；「编辑」按钮与行尾展开钮都切同一单值 editedId，
// 展开槽 = 行内编辑器（列表保持可见，不切视图、不弹全屏）。
const editedId = ref<string | null>(null)
const ragEditedId = ref<string | null>(null)
// 新增卡（DSH addBlock）：列表保持可见，新增卡内嵌空白编辑器；与任一行展开互斥
const addOpen = ref(false)
const ragAddOpen = ref(false)

// 档位草稿（作者编辑中的那份；保存才落库——refresh 后从 store 重置）
const tierForm = ref<{ creative: TierSlot; assistant: TierSlot | null; chat: TierSlot | null }>({
  creative: { model: '', effort: 'xhigh' },
  assistant: null,
  chat: null,
})
const assistantEnabled = ref(false)
const chatTierEnabled = ref(false)
const tierSaving = ref(false)
// R73-62（E-1）：保存入口在途锁——按钮 disabled 管不住双击/慢网窗口（R70-25 建书在途锁
// 同类先例）。新增卡双击会双 POST 落两条同名记录；编辑卡第二笔以陈旧 revision 409 弹
// 误导性「并发冲突」。锁在编排层（校验/API 写入都在这），经 :saving 下传编辑器禁按钮 + 文案
const saving = ref(false)
const ragSaving = ref(false)

/** store → 档位草稿重置（挂载 + 每次 store.refresh 后） */
function syncTierForm(): void {
  tierForm.value.creative = { ...store.tiers.creative }
  tierForm.value.assistant = store.tiers.assistant ? { ...store.tiers.assistant } : null
  tierForm.value.chat = store.tiers.chat ? { ...store.tiers.chat } : null
  // 档位开关默认关：仅当该档真配了模型才算开（空模型槽运行时本就回落创作档，显示应一致）
  assistantEnabled.value = !!store.tiers.assistant?.model
  chatTierEnabled.value = !!store.tiers.chat?.model
}

onMounted(async () => {
  await store.refreshAll()
  syncTierForm()
})

// ── AI 提供方：就地展开 / 新增（照搬 DSH） ──
/** 「编辑」/行尾展开钮：切单值互斥就地进行编辑（open ? close : open）；开编辑关新增卡。 */
function toggleEdit(p: ProviderConfDto): void {
  editedId.value = editedId.value === p.id ? null : p.id
  if (editedId.value) addOpen.value = false
}

/** 新增卡：列表保持可见，卡内嵌空白编辑器；关任一展开行。 */
function openAdd(): void {
  addOpen.value = true
  editedId.value = null
}

function closeEdit(): void {
  editedId.value = null
}

function setProbeModel(id: string, model: string): void {
  store.probeModels.set(id, model)
}

/** 编辑器内「获取模型」由 ModelListEditor 自持（表单现值探测 + 勾选弹窗，dsh 语义）。 */

/** 档位模型越界检测：启用中的档位模型不在目标清单里 → 返回越界档名数组 */
function outOfRangeTiers(declared: string[]): string[] {
  const out: string[] = []
  if (tierForm.value.creative.model && !declared.includes(tierForm.value.creative.model)) out.push('创作档')
  if (assistantEnabled.value && tierForm.value.assistant?.model && !declared.includes(tierForm.value.assistant.model)) out.push('助手档')
  if (chatTierEnabled.value && tierForm.value.chat?.model && !declared.includes(tierForm.value.chat.model)) out.push('对话档')
  return out
}

/** 档位模型对齐清单：越界档的模型换成清单默认（第一个已声明模型），保存并刷新 */
async function alignTiersToDeclared(declared: string[]): Promise<void> {
  const fallback = declared[0]
  if (!fallback) return
  if (tierForm.value.creative.model && !declared.includes(tierForm.value.creative.model)) tierForm.value.creative.model = fallback
  if (assistantEnabled.value && tierForm.value.assistant?.model && !declared.includes(tierForm.value.assistant.model)) tierForm.value.assistant.model = fallback
  if (chatTierEnabled.value && tierForm.value.chat?.model && !declared.includes(tierForm.value.chat.model)) tierForm.value.chat.model = fallback
  await saveTiers()
}

/** 提供方模型行落定后：测试模型未选/越界 → 默认选第一个声明模型；
 *  该提供方为当前提供方且档位越界 → 档位自动对齐默认模型。 */
async function afterProviderModelsSaved(pid: string): Promise<void> {
  const p = store.providers.find((x) => x.id === pid)
  const declared = (p?.models ?? []).map((m) => m.id).filter(Boolean)
  if (!declared.length) return
  const cur = store.probeModels.get(pid) ?? ''
  if (!cur || !declared.includes(cur)) store.probeModels.set(pid, declared[0]!)
  if (store.currentId === pid && outOfRangeTiers(declared).length) await alignTiersToDeclared(declared)
}

/** 保存（新增/展开编辑共用）：P6 Key 前端校验 + P9 模型行校验（非法 abort） */
async function save(f: {
  name: string
  protocol: Protocol
  auth: AuthStrategy
  baseUrl: string
  apiKey: string
  models?: ProviderConfDto['models']
  modelDrafts?: ModelRowDraft[]
}): Promise<void> {
  if (saving.value) return // R73-62：在途锁（双击第二笔在入口丢弃）
  if (!f.name.trim()) return ui.toast('名称必填', 'error')
  if (!f.baseUrl.trim()) return ui.toast('API 地址必填', 'error')
  if (!editedId.value && !f.apiKey.trim()) return ui.toast('API Key 必填', 'error')
  const keyErr = apiKeyFailure(f.apiKey)
  if (keyErr && !(editedId.value && !f.apiKey)) return ui.toast(keyErr, 'error')
  if (f.modelDrafts) {
    const err = validateModels(f.modelDrafts)
    if (err) {
      const which = err.index + 1
      const field = err.field === 'id' ? '模型 id' : err.field === 'contextWindow' ? 'Context Window' : 'Max Output Tokens'
      return ui.toast(`第 ${which} 行 ${field}：${err.error}`, 'error')
    }
  }
  const input = { name: f.name.trim(), protocol: f.protocol, auth: f.auth, baseUrl: f.baseUrl.trim(), apiKey: f.apiKey, models: f.models }
  saving.value = true
  try {
    const addId = editedId.value ? null : await store.add(input)
    const ok = editedId.value ? await store.update(editedId.value, input) : !!addId
    if (!ok) return
    const pid = editedId.value ?? addId
    closeEdit()
    addOpen.value = false
    // P0-2：提供方表已变 → 刷新 AI 可达性
    void ui.probeAiStatus()
    await store.refresh()
    syncTierForm()
    if (pid) await afterProviderModelsSaved(pid)
  } finally {
    saving.value = false // R73-62：成败都解锁（失败停留表单可改后重试）
  }
}

async function remove(p: ProviderConfDto): Promise<void> {
  const ok = await ui.ask({
    title: '删除提供方',
    message: `确认删除「${p.name}」？删除后不可恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  const done = await store.remove(p.id)
  if (!done) return
  editedId.value = null
  void ui.probeAiStatus()
  await store.refresh()
  syncTierForm()
}

async function activate(p: ProviderConfDto): Promise<void> {
  // 切换提供方：档位模型若不在新提供方清单 → 确认后自动更新为默认（第一个声明模型）
  const declared = (p.models ?? []).map((m) => m.id).filter(Boolean)
  const stale = outOfRangeTiers(declared)
  if (stale.length) {
    const ok = await ui.ask({
      title: '切换 AI 提供方',
      message: declared.length
        ? `任务档位（${stale.join('、')}）的模型不在「${p.name}」的清单中，切换后将自动更新为其默认模型「${declared[0]}」。`
        : `「${p.name}」尚未配置模型清单，切换后任务档位模型将不可用，需先在其编辑页添加模型。`,
      confirmText: declared.length ? '切换并更新档位' : '仍要切换',
    })
    if (!ok) return
  }
  // 启用不再要求先测试通过——测试是健康检查，不是启用门槛
  if (!(await store.activate(p.id))) return // R70-24：失败已 toast 错误，不再叠「已启用」
  void ui.probeAiStatus()
  ui.toast(`已启用「${p.name}」`, 'success')
  if (declared.length && stale.length) await alignTiersToDeclared(declared)
}

async function test(p: ProviderConfDto): Promise<void> {
  await store.test(p.id, store.probeModels.get(p.id) || undefined)
  const r = store.testResults.get(p.id)
  if (r?.ok && r.caps?.connected) ui.toast(`${p.name} 测试通过`, 'success')
  else if (r) ui.toast(r.error ?? '测试失败', 'error')
  void ui.probeAiStatus()
}

// ── 任务档位 ──
function toggleAssistant(on: boolean): void {
  assistantEnabled.value = on
  if (on && !tierForm.value.assistant) {
    tierForm.value.assistant = { model: tierForm.value.creative.model, effort: 'low' }
  }
}

function toggleChatTier(on: boolean): void {
  chatTierEnabled.value = on
  if (on && !tierForm.value.chat) {
    tierForm.value.chat = { model: tierForm.value.creative.model, effort: 'low' }
  }
}

async function saveTiers(): Promise<void> {
  if (!tierForm.value.creative.model) return ui.toast('创作档模型必选', 'error')
  tierSaving.value = true
  try {
    const ok = await store.saveTiers({
      creative: tierForm.value.creative,
      assistant: assistantEnabled.value ? tierForm.value.assistant : null,
    })
    if (ok) {
      // 对话档独立端点（不碰 creative/assistant/currentModel）
      await store.applyChatTier(chatTierEnabled.value ? tierForm.value.chat : null)
      void ui.probeAiStatus()
      ui.toast('档位已保存', 'success')
    }
    await store.refresh()
    syncTierForm()
  } finally {
    tierSaving.value = false
  }
}

// ── RAG（嵌入）提供方：就地展开 / 新增（照搬 DSH，与 AI 同款单卡互斥） ──
function toggleRagEdit(p: RagProviderDto): void {
  ragEditedId.value = ragEditedId.value === p.id ? null : p.id
  if (ragEditedId.value) ragAddOpen.value = false
}

function openRagAdd(): void {
  ragAddOpen.value = true
  ragEditedId.value = null
}

function closeRagEdit(): void {
  ragEditedId.value = null
}

async function saveRag(f: { name: string; endpoint: string; model: string; apiKey: string }): Promise<void> {
  if (ragSaving.value) return // R73-62：在途锁（同 save）
  if (!f.name.trim()) return ui.toast('名称必填', 'error')
  if (!f.endpoint.trim()) return ui.toast('嵌入服务地址必填', 'error')
  if (!f.model.trim()) return ui.toast('嵌入模型必填', 'error')
  if (!ragEditedId.value && !f.apiKey.trim()) return ui.toast('API Key 必填', 'error')
  const keyErr = apiKeyFailure(f.apiKey)
  if (keyErr && !(ragEditedId.value && !f.apiKey)) return ui.toast(keyErr, 'error')
  const input = { name: f.name.trim(), endpoint: f.endpoint.trim(), model: f.model.trim(), apiKey: f.apiKey }
  ragSaving.value = true
  try {
    const ok = ragEditedId.value ? await store.updateRag(ragEditedId.value, input) : await store.addRag(input)
    if (!ok) return
    closeRagEdit()
    ragAddOpen.value = false
    await store.refreshRag()
  } finally {
    ragSaving.value = false
  }
}

async function removeRag(p: RagProviderDto): Promise<void> {
  const ok = await ui.ask({
    title: '删除 RAG 提供方',
    message: `确认删除「${p.name}」？引用它的书将无法建索引，需在「设置 · 本书」页重新选择。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  const done = await store.removeRag(p.id)
  if (done) {
    ragEditedId.value = null
    await store.refreshRag()
  }
}

async function testRag(p: RagProviderDto): Promise<void> {
  await store.testRag(p.id)
  await store.refreshRag()
  const r = store.ragTestResults.get(p.id)
  if (r?.ok) ui.toast(`${p.name} 测试通过`, 'success')
  else if (r) ui.toast(r.error ?? '测试失败', 'error')
}
</script>


<template>
  <div class="ai-service-panel">
    <!-- 内部分页：AI 提供方 / RAG 提供方（柔光分段切换）——列表始终可见，编辑/新增就地展开 -->
    <div class="panel-tabs" role="tablist" aria-label="提供方分页">
      <button class="panel-tab" :class="{ on: panelTab === 'ai' }" role="tab" :aria-selected="panelTab === 'ai'" @click="panelTab = 'ai'">
        <span class="tab-icon"><MessageSquare :size="15" /></span>
        <span>AI 提供方</span>
      </button>
      <button class="panel-tab" :class="{ on: panelTab === 'rag' }" role="tab" :aria-selected="panelTab === 'rag'" @click="panelTab = 'rag'">
        <span class="tab-icon"><Database :size="15" /></span>
        <span>RAG 提供方</span>
      </button>
    </div>

    <!-- ═══════════ AI 提供方（聊天模型 + 任务档位） ═══════════ -->
    <template v-if="panelTab === 'ai'">
      <AiProviderList
        :providers="store.providers"
        :current-id="store.currentId"
        :loading="store.loading"
        :testing="store.testing"
        :test-results="store.testResults"
        :expanded-id="editedId"
        :add-open="addOpen"
        @add="openAdd"
        @edit="toggleEdit"
        @activate="activate"
        @test="test"
        @remove="remove"
      >
        <!-- 单卡就地展开：展开槽 = 行内编辑器（DSH：list 可见，editor 嵌该行下方） -->
        <template #row-expand="{ p }">
          <div v-if="editedId === p.id" class="row-inline-editor">
            <AiProviderEditor
              :initial="p"
              embedded
              :probe-model="store.probeModels.get(p.id) ?? ''"
              :saving="saving"
              @probe-model="(m) => setProbeModel(p.id, m)"
              @save="save"
              @cancel="closeEdit"
            />
          </div>
          <div v-else class="row-expand-preview">
            <span v-if="(p.models ?? []).length" class="row-expand-model-count">{{ (p.models ?? []).length }} 个模型行</span>
            <span v-else class="row-expand-placeholder">展开编辑配置</span>
          </div>
        </template>
      </AiProviderList>

      <!-- 新增卡（DSH addBlock）：列表保持可见，卡内嵌空白编辑器 -->
      <div v-if="addOpen" class="add-provider-card">
        <AiProviderEditor
          :initial="null"
          :saving="saving"
          @save="save"
          @cancel="addOpen = false"
        />
      </div>

      <!-- 任务档位 -->
      <TierSection
        v-if="store.currentId"
        :tier-form="tierForm"
        :assistant-enabled="assistantEnabled"
        :chat-tier-enabled="chatTierEnabled"
        :current-models="store.currentModels"
        :tier-saving="tierSaving"
        @toggle-assistant="toggleAssistant"
        @toggle-chat="toggleChatTier"
        @save-tiers="saveTiers"
      />
    </template>

    <!-- ═══════════ RAG（嵌入）提供方 ═══════════ -->
    <template v-else>
      <RagProviderList
        :rag-providers="store.ragProviders"
        :rag-loading="store.ragLoading"
        :rag-testing="store.ragTesting"
        :expanded-id="ragEditedId"
        @add="openRagAdd"
        @edit="toggleRagEdit"
        @remove="removeRag"
        @test="testRag"
      >
        <template #row-expand="{ p }">
          <div v-if="ragEditedId === p.id" class="row-inline-editor">
            <RagProviderEditor :initial="p" :saving="ragSaving" @save="saveRag" @cancel="closeRagEdit" />
          </div>
          <div v-else class="row-expand-preview"><span class="row-expand-placeholder">展开编辑配置</span></div>
        </template>
      </RagProviderList>

      <!-- RAG 新增卡：列表保持可见 -->
      <div v-if="ragAddOpen" class="add-provider-card">
        <RagProviderEditor :initial="null" :saving="ragSaving" @save="saveRag" @cancel="ragAddOpen = false" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 面板为单列网格：下挂的子组件根节点（多为 fragment 多根）各自占一整行，无需逐个 :deep 拉通。
 * 共享控件语言在 styles/providers.css（script 里引入）。 */
.ai-service-panel {
  display: grid;
  gap: var(--size-4-3);
  /* 标签条上移：抵掉 settings-content 顶部 padding 8px，分页切换贴顶更紧 */
  margin-top: calc(var(--size-4-2) * -1);
}

/* ── 内部分页（AI 提供方 / RAG 提供方）——柔光分段切换，配色对齐「书籍名」强调色 ── */
.panel-tabs {
  display: inline-flex;
  /* grid 子项默认拉伸占满整行，导致灰底比两个标签宽——收回到内容宽度 */
  justify-self: start;
  gap: 4px;
  padding: 4px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.04);
}
.panel-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 18px;
  font-size: var(--font-size-s);
  font-weight: 500;
  border: 1px solid transparent;
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.panel-tab:hover {
  color: var(--text-accent);
  background: color-mix(in srgb, var(--text-accent) 6%, transparent);
  border-color: transparent;
}
.panel-tab.on {
  /* 与书籍名 book-banner 同款强调色配色：描边 + 浅铺底 + 强调色文字 */
  border-color: color-mix(in srgb, var(--text-accent) 22%, transparent);
  background: color-mix(in srgb, var(--text-accent) 7%, transparent);
  color: var(--text-accent);
  font-weight: 600;
}
.tab-icon {
  display: flex;
  color: var(--text-faint);
  transition: color var(--dur-fast) var(--ease-out);
}
.panel-tab:hover .tab-icon {
  color: var(--text-accent);
}
.panel-tab.on .tab-icon {
  color: var(--text-accent);
}

/* ── 行内编辑器（单卡展开槽；填充底色由 ProviderRow 的 .provider-row-expand 提供） ── */
.row-inline-editor {
  display: grid;
  gap: var(--size-4-2);
  width: 100%;
}

/* ── 新增卡（DSH addBlock）：面板里唯一的虚线占位壳——「这里将新增一条」的空位感，
 *    区别于已有行卡的实线；hover 时虚线转 accent 提示可交互。 ── */
.add-provider-card {
  padding: 12px 14px;
  border: 1px dashed var(--background-modifier-border-hover);
  border-radius: var(--radius-l);
  /* 与展开编辑区同一份模块底（唯一填充词汇），虚线承担「空位」语义 */
  background: var(--background-secondary);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.add-provider-card:hover {
  border-color: color-mix(in srgb, var(--interactive-accent) 45%, transparent);
}
</style>