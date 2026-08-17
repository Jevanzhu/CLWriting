<script setup lang="ts">
// AI 提供方管理面板（设置页「AI 提供方」tab 的内容）。
// 应用级配置，跨书共享，存 userData/providers.json。
import { ref, onMounted } from 'vue'
import { Plus, Trash2, Check, Zap, Loader2, AlertTriangle, Pencil, RefreshCw, MessageSquare, Database, Bot } from 'lucide-vue-next'
import {
  getProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  setCurrentProvider,
  testProvider,
  fetchModels,
  setTiers,
  setChatTier,
  getRagProviders,
  createRagProvider,
  updateRagProvider,
  deleteRagProvider,
  testRagProvider,
  type ProviderConfDto,
  type ProviderCaps,
  type Protocol,
  type AuthStrategy,
  type TestResult,
  type TierSlot,
  type RagProviderDto,
} from '../../api/providers'
import { useUiStore } from '../../stores/ui'
import { friendlyError } from '../../shared/error'
import { useChatTier } from '../../composables/useChatTier'

const ui = useUiStore()

// 内部分页：AI 提供方（聊天模型 + 任务档位）/ RAG 提供方（嵌入检索）
const panelTab = ref<'ai' | 'rag'>('ai')

const providers = ref<ProviderConfDto[]>([])
const currentId = ref<string | null>(null)
const loading = ref(false)
const testing = ref<string | null>(null)
const testResults = ref<Map<string, TestResult>>(new Map())
// 测试连接用模型——按提供方分卡独立（默认当前模型，可手动切换；不选后端回落该提供方 conf.model）
const probeModels = ref<Map<string, string>>(new Map())

function probeModelOf(p: ProviderConfDto): string {
  return probeModels.value.get(p.id) ?? ''
}
function setProbeModel(p: ProviderConfDto, e: Event): void {
  probeModels.value.set(p.id, (e.target as HTMLSelectElement).value)
}

/** 提供方 p 的模型清单（未拉取 → 空，模板据此显示引导文案）。 */
function modelsOf(p: ProviderConfDto): string[] {
  return modelsByProvider.value.get(p.id) ?? []
}

// 任务档位（D 档：创作档/助手档/对话档）
// V-P2-26：模型清单按提供方分存——共享单份清单时，非当前供应商的「测试模型」
// 下拉显示的是别家模型，选中即 404 且看不出原因。
const modelsByProvider = ref<Map<string, string[]>>(new Map())
const fetchingModelIds = new Set<string>()
const tierForm = ref<{ creative: TierSlot; assistant: TierSlot | null; chat: TierSlot | null }>({
  creative: { model: '', effort: 'xhigh' },
  assistant: null,
  chat: null,
})
const assistantEnabled = ref(false)
const chatTierEnabled = ref(false)
const tierSaving = ref(false)
const fetchingModels = ref(false)

/** 档位下拉用：当前供应商的模型清单。 */
const currentModels = (): string[] =>
  (currentId.value ? (modelsByProvider.value.get(currentId.value) ?? []) : [])

/**
 * 拉取提供方模型清单（幂等去重 + 探测模型回落 + 手动重试）。
 * @param opts.fallbackModel 全局当前模型在清单内时优先作探测默认
 * @param opts.force 已有缓存也重拉（「获取模型列表」手动重试）
 */
async function ensureModels(
  p: { id: string },
  opts: { fallbackModel?: string; force?: boolean; silent?: boolean } = {},
): Promise<void> {
  if (fetchingModelIds.has(p.id)) return
  if (!opts.force && modelsByProvider.value.has(p.id)) return
  fetchingModelIds.add(p.id)
  try {
    const r = await fetchModels({ id: p.id })
    modelsByProvider.value.set(p.id, r.models)
    // 探测模型：空 / 不在新清单 → 回落（全局模型在清单内优先，否则取首个）；
    // 已在清单 → 保留手动选择（测试完成 refresh 不重置作者的选择）
    const cur = probeModels.value.get(p.id) ?? ''
    if (!cur || !r.models.includes(cur)) {
      const fallback =
        opts.fallbackModel && r.models.includes(opts.fallbackModel) ? opts.fallbackModel : (r.models[0] ?? '')
      probeModels.value.set(p.id, fallback)
    }
    if (!opts.silent) ui.toast(`已获取 ${r.models.length} 个模型`, 'success')
  } catch (e) {
    if (!opts.silent) ui.toast(friendlyError(e), 'error')
    // dd-P2：失败保留旧缓存——此前 force 重拉失败会把已成功的清单清成空，
    // 档位区 select 退回占位态（网络抖动丢好数据）
  } finally {
    fetchingModelIds.delete(p.id)
  }
}

/** 手动获取模型列表（初始拉取失败时的重试入口，档位区按钮）。 */
async function fetchModelList(): Promise<void> {
  if (!currentId.value || fetchingModels.value) return
  fetchingModels.value = true
  try {
    const cur = providers.value.find((x) => x.id === currentId.value)
    if (cur) await ensureModels(cur, { force: true })
  } finally {
    fetchingModels.value = false
  }
}

// 编辑/新增表单
const editing = ref(false)
const editId = ref<string | null>(null)
const form = ref({
  name: '',
  protocol: 'openai' as Protocol,
  auth: 'bearer' as AuthStrategy,
  baseUrl: '',
  apiKey: '',
})


async function refresh(): Promise<void> {
  loading.value = true
  try {
    const data = await getProviders()
    providers.value = data.providers
    currentId.value = data.currentId
    // D 档：读档位配置 + 模型列表
    tierForm.value.creative = { ...data.tiers.creative }
    tierForm.value.assistant = data.tiers.assistant ? { ...data.tiers.assistant } : null
    assistantEnabled.value = !!data.tiers.assistant
    tierForm.value.chat = data.tiers.chat ? { ...data.tiers.chat } : null
    chatTierEnabled.value = !!data.tiers.chat
    if (currentId.value) {
      const cur = providers.value.find((x) => x.id === currentId.value)
      if (cur) {
        try {
          // V-P2-26：清单按提供方入缓存（拉取失败不崩，档位区可手动重试）
          await ensureModels(cur, { fallbackModel: data.currentModel ?? undefined, silent: true })
        } catch {
          /* 静默：fetchModelList 可重试 */
        }
      }
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void refresh()
  void refreshRag()
})

function startAdd(): void {
  editing.value = true
  editId.value = null
  form.value = { name: '', protocol: 'openai', auth: 'bearer', baseUrl: '', apiKey: '' }
}

function startEdit(p: ProviderConfDto): void {
  editing.value = true
  editId.value = p.id
  // 旧配置可能无 auth → 按协议推断（anthropic 官方 / openai bearer）
  form.value = { name: p.name, protocol: p.protocol, auth: p.auth ?? (p.protocol === 'anthropic' ? 'anthropic' : 'bearer'), baseUrl: p.baseUrl, apiKey: '' }
}

function cancelEdit(): void {
  editing.value = false
  editId.value = null
}

/** 选协议类型——自动定认证策略（anthropic→anthropic 头，openai/openai-responses→bearer） */
function selectProtocol(p: Protocol): void {
  form.value.protocol = p
  form.value.auth = p === 'anthropic' ? 'anthropic' : 'bearer'
}

async function save(): Promise<void> {
  const f = form.value
  if (!f.name.trim()) return ui.toast('名称必填', 'error')
  if (!f.baseUrl.trim()) return ui.toast('API 地址必填', 'error')
  if (!editId.value && !f.apiKey.trim()) return ui.toast('API Key 必填', 'error')

  try {
    if (editId.value) {
      await updateProvider(editId.value, f)
      ui.toast('已保存', 'success')
    } else {
      await createProvider(f)
      ui.toast('已添加', 'success')
    }
    editing.value = false
    editId.value = null
    // P0-2：提供方表已变 → 刷新 AI 可达性（新增后未测连接按钮仍灰，语义正确）
    void ui.probeAiStatus()
    await refresh()
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
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
  try {
    const r = await deleteProvider(p.id)
    currentId.value = r.currentId
    // P0-2：删除可能翻转可达性（删除当前提供方 + 无兜底 → 不可达）
    void ui.probeAiStatus()
    await refresh()
    ui.toast('已删除', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

async function activate(p: ProviderConfDto): Promise<void> {
  if (!p.caps) return ui.toast('请先测试连接', 'error')
  try {
    await setCurrentProvider(p.id)
    currentId.value = p.id
    // P0-2：切换当前提供方后工作台/开书按钮应立即可用
    void ui.probeAiStatus()
    // 切提供方 → 模型清单/探测模型跟随新提供方（否则测试下拉仍是旧提供方清单，
    // 测旧模型名会 404 且看不出原因）
    try {
      await ensureModels(p, { force: true, silent: true })
    } catch {
      /* 拉取失败不阻塞启用；「获取模型列表」可手动重试 */
    }
    ui.toast(`已启用「${p.name}」`, 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

async function test(p: ProviderConfDto): Promise<void> {
  testing.value = p.id
  try {
    const r = await testProvider(p.id, probeModels.value.get(p.id) || undefined)
    testResults.value.set(p.id, r)
    // P0-2：测试通过 → caps 落库 → 可达性翻转，工作台按钮即时解灰
    void ui.probeAiStatus()
    // dd-P3：结果先 toast——refresh 内含静默拉模型清单（30s 超时），结果出来了
    // 再等它会让按钮白转圈数十秒
    if (r.ok && r.caps?.connected) ui.toast(`${p.name} 测试通过`, 'success')
    else ui.toast(r.error ?? '测试失败', 'error')
    void refresh()
  } catch (e) {
    testResults.value.set(p.id, { ok: false, error: friendlyError(e) })
    ui.toast(friendlyError(e), 'error')
  } finally {
    testing.value = null
  }
}

function toggleAssistant(on: boolean): void {
  if (on && !tierForm.value.assistant) {
    tierForm.value.assistant = { model: tierForm.value.creative.model, effort: 'low' }
  }
}

function toggleChatTier(on: boolean): void {
  if (on && !tierForm.value.chat) {
    tierForm.value.chat = { model: tierForm.value.creative.model, effort: 'low' }
  }
}

async function saveTiers(): Promise<void> {
  if (!tierForm.value.creative.model) return ui.toast('创作档模型必选', 'error')
  tierSaving.value = true
  try {
    await setTiers({
      creative: tierForm.value.creative,
      assistant: assistantEnabled.value ? tierForm.value.assistant : null,
    })
    // 对话档走独立端点（不碰 creative/assistant/currentModel）
    await setChatTier(chatTierEnabled.value ? tierForm.value.chat : null)
    void ui.probeAiStatus()
    ui.toast('档位已保存', 'success')
    await refresh()
    // 配置变更 → 刷新对话档位下拉（ChatPanel/ChatDock 共用的单例）
    void useChatTier().refresh()
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
    // 部分保存失败 → 回读服务端状态，防本地与服务端不一致
    await refresh()
  } finally {
    tierSaving.value = false
  }
}

function capsBadge(caps: ProviderCaps | null): { text: string; cls: string } | null {
  if (!caps) return null
  if (!caps.connected) return { text: '连接失败', cls: 'bad' }
  return { text: '已连接', cls: 'ok' }
}

// ── RAG（嵌入）提供方：应用级多提供方，书在「AI 功能」页选引用 ──
const ragProviders = ref<RagProviderDto[]>([])
const ragLoading = ref(false)
const ragTesting = ref<string | null>(null)
const ragEditing = ref(false)
const ragEditId = ref<string | null>(null)
const ragForm = ref({ name: '', endpoint: '', model: '', apiKey: '' })

async function refreshRag(): Promise<void> {
  ragLoading.value = true
  try {
    const r = await getRagProviders()
    ragProviders.value = r.ragProviders
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    ragLoading.value = false
  }
}

function startRagAdd(): void {
  ragEditing.value = true
  ragEditId.value = null
  ragForm.value = { name: '', endpoint: '', model: '', apiKey: '' }
}

function startRagEdit(p: RagProviderDto): void {
  ragEditing.value = true
  ragEditId.value = p.id
  ragForm.value = { name: p.name, endpoint: p.endpoint, model: p.model, apiKey: '' }
}

function cancelRagEdit(): void {
  ragEditing.value = false
  ragEditId.value = null
}

async function saveRag(): Promise<void> {
  const f = ragForm.value
  if (!f.name.trim()) return ui.toast('名称必填', 'error')
  if (!f.endpoint.trim()) return ui.toast('嵌入服务地址必填', 'error')
  if (!f.model.trim()) return ui.toast('嵌入模型必填', 'error')
  if (!ragEditId.value && !f.apiKey.trim()) return ui.toast('API Key 必填', 'error')
  try {
    if (ragEditId.value) {
      await updateRagProvider(ragEditId.value, f)
      ui.toast('已保存', 'success')
    } else {
      await createRagProvider(f)
      ui.toast('已添加', 'success')
    }
    ragEditing.value = false
    ragEditId.value = null
    await refreshRag()
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

async function removeRag(p: RagProviderDto): Promise<void> {
  const ok = await ui.ask({
    title: '删除 RAG 提供方',
    message: `确认删除「${p.name}」？引用它的书将无法建索引，需在「AI 功能」页重新选择。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await deleteRagProvider(p.id)
    await refreshRag()
    ui.toast('已删除', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

async function testRag(p: RagProviderDto): Promise<void> {
  ragTesting.value = p.id
  try {
    const r = await testRagProvider(p.id)
    await refreshRag()
    if (r.ok) ui.toast(`${p.name} 测试通过`, 'success')
    else ui.toast(r.error ?? '测试失败', 'error')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    ragTesting.value = null
  }
}

function timeAgo(ts: number | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
</script>


<template>
  <div class="ai-service-panel">
    <!-- 提供方列表（含内部分页：AI 提供方 / RAG 提供方） -->
    <template v-if="!editing">
      <!-- 内部分页：AI 提供方 / RAG 提供方（柔光分段切换） -->
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
        <div class="group-title">
          <span class="group-title-text">AI 提供方</span>
          <button class="add-btn" @click="startAdd"><Plus :size="14" />添加</button>
        </div>

        <div v-if="loading" class="empty"><Loader2 :size="20" class="spin" /> 加载中...</div>

        <div v-else-if="providers.length === 0" class="empty">
          <div class="empty-icon"><MessageSquare :size="26" /></div>
          <p>尚未配置任何 AI 提供方</p>
          <button class="add-btn-lg" @click="startAdd"><Plus :size="16" />添加提供方</button>
        </div>

        <template v-else>
          <div class="provider-list">
            <div
              v-for="p in providers"
              :key="p.id"
              class="provider-row"
              :class="{ active: p.id === currentId }"
            >
              <div class="provider-row-main">
                <span class="dot" :class="p.id === currentId ? 'on' : 'off'" />
                <span class="provider-row-avatar"><Bot :size="16" /></span>
                <span class="provider-row-name">{{ p.name }}</span>
                <span v-if="p.id === currentId" class="current-badge">当前</span>
                <span class="tag">{{ p.protocol === 'anthropic' ? 'Anthropic' : p.protocol === 'openai-responses' ? 'Responses' : 'OpenAI' }}</span>
                <span class="provider-status">
                  <span v-if="p.caps" class="caps-badge" :class="capsBadge(p.caps)?.cls">{{ capsBadge(p.caps)?.text }}</span>
                  <span v-if="p.caps?.connected" class="probed-at">{{ timeAgo(p.capsProbedAt) }}</span>
                  <span v-if="!p.caps" class="unchecked-hint">未测试</span>
                </span>
              </div>
              <div class="provider-actions">
                <button
                  v-if="p.id !== currentId && p.caps?.connected"
                  class="mini-btn enable"
                  data-tip="设为当前启用"
                  @click="activate(p)"
                >
                  <Check :size="13" />
                </button>
                <!-- 测试模型下拉（与测试按钮同行）：未拉清单可点开引导拉取；选择后再测 -->
                <span class="probe-inline" :title="modelsOf(p).length ? '测试连接用模型' : '点击下拉获取该提供方的模型清单'">
                  <select
                    :value="probeModelOf(p)"
                    class="probe-select"
                    :disabled="!modelsOf(p).length"
                    @focus="ensureModels(p, { silent: true })"
                    @change="setProbeModel(p, $event)"
                  >
                    <option value="" disabled>{{ modelsOf(p).length ? '选择模型' : '点此获取清单' }}</option>
                    <option v-for="m in modelsOf(p)" :key="m" :value="m">{{ m }}</option>
                  </select>
                </span>
                <button class="mini-btn" :class="{ testing: testing === p.id }" :disabled="testing === p.id" data-tip="测试连接" @click="test(p)">
                  <Loader2 v-if="testing === p.id" :size="13" class="spin" />
                  <Zap v-else :size="13" />
                </button>
                <button class="mini-btn" data-tip="编辑" @click="startEdit(p)"><Pencil :size="13" /></button>
                <button class="mini-btn danger" data-tip="删除" @click="remove(p)"><Trash2 :size="13" /></button>
              </div>
              <div v-if="testResults.get(p.id)" class="test-detail" :class="{ fail: !testResults.get(p.id)?.ok }">
                <div v-for="(d, i) in testResults.get(p.id)?.details" :key="i" class="detail-line">{{ d }}</div>
                <div v-if="testResults.get(p.id)?.error" class="detail-line err">
                  <AlertTriangle :size="12" /> {{ testResults.get(p.id)?.error }}
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- 任务档位 -->
        <div v-if="currentId" class="tier-section">
          <div class="group-title">
            <span class="group-title-text">任务档位</span>
            <button class="add-btn" :disabled="fetchingModels" @click="fetchModelList">
              <Loader2 v-if="fetchingModels" :size="14" class="spin" />
              <RefreshCw v-else :size="14" />
              {{ fetchingModels ? '获取中…' : '获取模型列表' }}
            </button>
          </div>
          <div class="tier-grid">
            <div class="tier-card">
              <div class="tier-head">
                <span class="tier-name">创作档</span>
              </div>
              <div class="tier-desc">写正文 / 改写 / 大纲</div>
              <div class="tier-fields">
                <select v-model="tierForm.creative.model" class="tier-select">
                  <option value="" disabled>{{ currentModels().length ? '选择模型' : '请先获取模型列表' }}</option>
                  <option v-for="m in currentModels()" :key="m" :value="m">{{ m }}</option>
                </select>
                <select v-model="tierForm.creative.effort" class="tier-select sm">
                  <option value="max">max</option>
                  <option value="xhigh">xhigh</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </div>
            </div>
            <div class="tier-card">
              <div class="tier-head">
                <span class="tier-name">助手档</span>
                <label class="tier-toggle">
                  <input type="checkbox" v-model="assistantEnabled" @change="toggleAssistant(assistantEnabled)" />
                  <span class="tier-toggle-text">启用</span>
                </label>
              </div>
              <div class="tier-desc">三审 / 分析 · 不配则与创作档相同</div>
              <div v-if="assistantEnabled && tierForm.assistant" class="tier-fields">
                <select v-model="tierForm.assistant.model" class="tier-select">
                  <option value="" disabled>{{ currentModels().length ? '选择模型' : '请先获取模型列表' }}</option>
                  <option v-for="m in currentModels()" :key="m" :value="m">{{ m }}</option>
                </select>
                <select v-model="tierForm.assistant.effort" class="tier-select sm">
                  <option value="max">max</option>
                  <option value="xhigh">xhigh</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </div>
            </div>
            <div class="tier-card">
              <div class="tier-head">
                <span class="tier-name">对话档</span>
                <label class="tier-toggle">
                  <input type="checkbox" v-model="chatTierEnabled" @change="toggleChatTier(chatTierEnabled)" />
                  <span class="tier-toggle-text">启用</span>
                </label>
              </div>
              <div class="tier-desc">对话助手 · 不配则与创作档相同</div>
              <div v-if="chatTierEnabled && tierForm.chat" class="tier-fields">
                <select v-model="tierForm.chat.model" class="tier-select">
                  <option value="" disabled>{{ currentModels().length ? '选择模型' : '请先获取模型列表' }}</option>
                  <option v-for="m in currentModels()" :key="m" :value="m">{{ m }}</option>
                </select>
                <select v-model="tierForm.chat.effort" class="tier-select sm">
                  <option value="max">max</option>
                  <option value="xhigh">xhigh</option>
                  <option value="high">high</option>
                  <option value="medium">medium</option>
                  <option value="low">low</option>
                </select>
              </div>
            </div>
          </div>
          <button class="save-btn tier-save" :disabled="tierSaving" @click="saveTiers">
            <Loader2 v-if="tierSaving" :size="14" class="spin" /> 保存档位
          </button>
        </div>
      </template>

      <!-- ═══════════ RAG（嵌入）提供方 ═══════════ -->
      <template v-else>
        <div class="rag-provider-section">
          <div class="group-title">
            <span class="group-title-text">RAG 提供方</span>
            <button v-if="!ragEditing" class="add-btn" @click="startRagAdd"><Plus :size="14" />添加</button>
          </div>

          <template v-if="!ragEditing">
            <div v-if="ragLoading" class="empty"><Loader2 :size="20" class="spin" /> 加载中...</div>

            <div v-else-if="ragProviders.length === 0" class="empty">
              <div class="empty-icon"><Database :size="26" /></div>
              <p>尚未配置嵌入提供方——「AI 功能」页的知识检索需要至少一个</p>
              <button class="add-btn-lg" @click="startRagAdd"><Plus :size="16" />添加 RAG 提供方</button>
            </div>

            <template v-else>
              <div class="provider-list">
                <div v-for="p in ragProviders" :key="p.id" class="provider-row">
                  <div class="provider-row-main">
                    <span class="provider-row-avatar rag"><Database :size="16" /></span>
                    <span class="provider-row-name">{{ p.name }}</span>
                    <span class="model-tag" :title="p.model">{{ p.model }}</span>
                    <span class="provider-status">
                      <span v-if="p.caps" class="caps-badge" :class="p.caps.connected ? 'ok' : 'bad'">{{ p.caps.connected ? '已连接' : '连接失败' }}</span>
                      <span v-if="p.caps?.connected" class="probed-at">{{ timeAgo(p.capsProbedAt) }}</span>
                      <span v-if="!p.caps" class="unchecked-hint">未测试</span>
                    </span>
                  </div>
                  <div class="provider-actions">
                    <button class="mini-btn" :class="{ testing: ragTesting === p.id }" :disabled="ragTesting === p.id" data-tip="测试连接" @click="testRag(p)">
                      <Loader2 v-if="ragTesting === p.id" :size="13" class="spin" />
                      <Zap v-else :size="13" />
                    </button>
                    <button class="mini-btn" data-tip="编辑" @click="startRagEdit(p)"><Pencil :size="13" /></button>
                    <button class="mini-btn danger" data-tip="删除" @click="removeRag(p)"><Trash2 :size="13" /></button>
                  </div>
                </div>
              </div>
            </template>
          </template>

          <!-- RAG 新增/编辑表单 -->
          <template v-else>
            <div class="form">
              <div class="form-row">
                <label>名称</label>
                <input v-model="ragForm.name" type="text" placeholder="如「OpenAI 官方」" class="text-input" />
              </div>
              <div class="form-row">
                <label>嵌入服务地址</label>
                <input v-model="ragForm.endpoint" type="text" placeholder="https://api.example.com/v1/embeddings（完整 URL）" class="text-input" />
              </div>
              <div class="form-row">
                <label>嵌入模型</label>
                <input v-model="ragForm.model" type="text" placeholder="如 text-embedding-3-small" class="text-input" />
              </div>
              <div class="form-row">
                <label>API Key</label>
                <input
                  v-model="ragForm.apiKey"
                  type="password"
                  :placeholder="ragEditId ? '不改则保留原 Key' : '粘贴你的 API Key'"
                  class="text-input"
                />
              </div>
              <div class="form-actions">
                <button class="cancel-btn" @click="cancelRagEdit">取消</button>
                <button class="save-btn" @click="saveRag">保存</button>
              </div>
            </div>
          </template>
        </div>
      </template>
    </template>

    <!-- AI 新增/编辑表单 -->
    <template v-else>
      <div class="group-title">{{ editId ? '编辑提供方' : '新增提供方' }}</div>
      <div class="form">
        <!-- 协议类型选择 -->
        <div class="form-row">
          <label>类型</label>
          <div class="protocol-toggle">
            <button
              class="protocol-btn"
              :class="{ on: form.protocol === 'openai' }"
              @click="selectProtocol('openai')"
            >OpenAI 兼容</button>
            <button
              class="protocol-btn"
              :class="{ on: form.protocol === 'anthropic' }"
              @click="selectProtocol('anthropic')"
            >Anthropic</button>
            <!-- Responses 启用批（缺口 15）：协议栏三选一，Responses 排最后（日常推荐 Chat 兼容） -->
            <button
              class="protocol-btn"
              :class="{ on: form.protocol === 'openai-responses' }"
              title="OpenAI 新线（gpt-5/o 系列深度用）；日常推荐 OpenAI 兼容"
              @click="selectProtocol('openai-responses')"
            >Responses</button>
          </div>
        </div>
        <div class="form-row">
          <label>名称</label>
          <input v-model="form.name" type="text" placeholder="如「我的中转」" class="text-input" />
        </div>
        <div class="form-row">
          <label>API 地址</label>
          <input v-model="form.baseUrl" type="text" placeholder="https://..." class="text-input" />
        </div>
        <div class="form-row">
          <label>API Key</label>
          <input
            v-model="form.apiKey"
            type="password"
            :placeholder="editId ? '不改则保留原 Key' : '粘贴你的 API Key'"
            class="text-input"
          />
        </div>
        <div class="form-actions">
          <button class="cancel-btn" @click="cancelEdit">取消</button>
          <button class="save-btn" @click="save">保存</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ── 内部分页（AI 提供方 / RAG 提供方）——柔光分段切换，配色对齐「书籍名」强调色 ── */
.panel-tabs {
  display: inline-flex;
  /* grid 子项默认拉伸占满整行，导致灰底比两个标签宽——收回到内容宽度 */
  justify-self: start;
  gap: 4px;
  padding: 4px;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: 12px;
  margin-bottom: var(--size-4-4);
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
  border-radius: 9px;
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

/* ── 分组标题（对齐设置页 cfg-card-head 风格） ── */
.group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
  padding: 0 var(--size-4-1);
  margin-bottom: var(--size-4-2);
}
.group-title-text {
  letter-spacing: 0.02em;
}

/* ── 添加按钮 ── */
.add-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  border: 1px solid var(--background-modifier-border);
  border-radius: 99px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.add-btn:hover:not(:disabled) {
  color: var(--text-normal);
  border-color: var(--interactive-accent);
  background: color-mix(in srgb, var(--interactive-accent) 6%, transparent);
}
.add-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.add-btn-lg {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 22px;
  font-size: var(--font-size-s);
  font-weight: 500;
  border: 1px solid var(--background-modifier-border);
  border-radius: 10px;
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.add-btn-lg:hover {
  background: var(--background-modifier-hover);
  border-color: var(--background-modifier-border-hover);
}

/* ── 空状态 ── */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-8) 0;
  color: var(--text-faint);
  font-size: var(--font-size-s);
}
.empty p {
  margin: 0;
}
.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--background-secondary);
  color: var(--text-faint);
  border: 1px solid var(--background-modifier-border);
}
/* ── 提供方列表：紧凑单列，多提供方时不占纵向空间 ──
 * 每行只显示 状态点/名称/标签/状态/操作，测试详情仅在需要时展开。 */
.ai-service-panel {
  display: grid;
  gap: var(--size-4-2);
}
.ai-service-panel > .panel-tabs,
.ai-service-panel > .group-title,
.ai-service-panel > .empty,
.ai-service-panel > .tier-section,
.ai-service-panel > .rag-provider-section,
.ai-service-panel > .form,
.ai-service-panel > .provider-list {
  grid-column: 1 / -1;
}

.provider-list {
  display: grid;
  gap: var(--size-4-1);
}
.provider-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 8px 12px;
  border: 1px solid var(--background-modifier-border);
  border-radius: 10px;
  background: var(--background-primary);
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.provider-row:hover {
  border-color: var(--background-modifier-border-hover);
}
.provider-row.active {
  border-color: color-mix(in srgb, var(--interactive-accent) 45%, transparent);
  background: color-mix(in srgb, var(--interactive-accent) 3%, transparent);
}
.provider-row-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
.provider-row-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  flex-shrink: 0;
  background: color-mix(in srgb, var(--interactive-accent) 14%, transparent);
  color: var(--text-accent);
}
.provider-row-avatar.rag {
  background: color-mix(in srgb, var(--dv-good) 14%, transparent);
  color: var(--dv-good);
}
.provider-row-name {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.provider-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding-right: 2px;
}
.unchecked-hint {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  color: var(--text-faint);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  padding: 2px 9px;
  border-radius: 99px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.on {
  background: var(--dv-good);
  box-shadow: 0 0 6px color-mix(in srgb, var(--dv-good) 60%, transparent);
}
.dot.off {
  background: var(--text-faint);
}
.current-badge {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  color: var(--text-on-accent);
  background: var(--interactive-accent);
  padding: 1px 8px;
  border-radius: 99px;
  flex-shrink: 0;
}
.provider-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.mini-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-m);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.mini-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.mini-btn.danger:hover {
  color: var(--dv-bad);
  background: color-mix(in srgb, var(--dv-bad) 10%, transparent);
}
.mini-btn.enable {
  color: var(--dv-good);
}
.mini-btn.enable:hover {
  background: color-mix(in srgb, var(--dv-good) 14%, transparent);
  color: var(--dv-good);
}
.mini-btn.testing {
  pointer-events: none;
}

/* ── 测试模型选择（与测试按钮同行，同高协调） ── */
.probe-inline {
  display: flex;
  align-items: center;
  gap: 4px;
}
.probe-select {
  max-width: 150px;
  padding: 3px 8px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.probe-select:hover:not(:disabled) {
  border-color: var(--interactive-accent);
}
.probe-select:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.probe-select:disabled {
  opacity: 0.5;
  cursor: default;
}

.tag {
  padding: 1px 7px;
  font-size: var(--font-size-xxs);
  font-weight: 600;
  border-radius: 99px;
  background: color-mix(in srgb, var(--interactive-accent) 14%, transparent);
  color: var(--text-accent);
  flex-shrink: 0;
}
.model-tag {
  font-family: var(--font-monospace);
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── caps 徽章 ── */
.caps-badge {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 99px;
}
.caps-badge.ok {
  background: color-mix(in srgb, var(--dv-good) 14%, transparent);
  color: var(--dv-good);
}
.caps-badge.bad {
  background: color-mix(in srgb, var(--dv-bad) 14%, transparent);
  color: var(--dv-bad);
}
.probed-at {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}

/* ── 测试详情 ── */
.test-detail {
  flex-basis: 100%;
  margin-top: 2px;
  padding: 6px 10px;
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}
.test-detail.fail {
  background: color-mix(in srgb, var(--dv-bad) 6%, transparent);
}
.detail-line {
  line-height: 1.6;
}
.detail-line.err {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--dv-bad);
}

/* ── 表单 ── */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
  padding: var(--size-4-4);
  border: 1px solid var(--background-modifier-border);
  border-radius: 12px;
  background: var(--background-primary);
}
.form-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.form-row label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
}
.text-input {
  width: 100%;
  padding: 8px 12px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.text-input:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.protocol-toggle {
  display: flex;
  gap: 8px;
}
.protocol-btn {
  padding: 8px 16px;
  font-size: var(--font-size-s);
  font-weight: 500;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: var(--background-secondary);
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.protocol-btn:hover {
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}
.protocol-btn.on {
  border-color: var(--interactive-accent);
  background: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
  color: var(--text-normal);
  font-weight: 600;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: var(--size-4-2);
}
.cancel-btn {
  padding: 7px 18px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.cancel-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
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

/* ── spin ── */
.spin {
  animation: clw-spin 0.8s linear infinite;
}
@keyframes clw-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── 任务档位 ── */
.tier-section {
  margin-top: var(--size-4-6);
}
.tier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: var(--size-4-2);
}
.tier-card {
  padding: var(--size-4-3) var(--size-4-4);
  border: 1px solid var(--background-modifier-border);
  border-radius: 12px;
  background: var(--background-primary);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.tier-card:hover {
  border-color: var(--background-modifier-border-hover);
  box-shadow: var(--shadow-s);
}
.tier-grid .tier-fields {
  flex-direction: column;
  align-items: stretch;
  flex-wrap: nowrap;
}
.tier-save {
  margin-top: var(--size-4-3);
}
.tier-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: var(--size-4-1);
}
.tier-name {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.tier-desc {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  margin-bottom: var(--size-4-2);
}
.tier-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  flex: none;
}
.tier-toggle input {
  accent-color: var(--interactive-accent);
}
.tier-toggle-text {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.tier-fields {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.tier-select {
  flex: 1;
  min-width: 140px;
  padding: 6px 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.tier-select:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.tier-select.sm {
  flex: 0 0 auto;
  min-width: 80px;
}

/* ── RAG（嵌入）提供方区：内部单列紧凑行列表 ── */
.rag-provider-section {
  margin-top: 0;
  display: grid;
  gap: var(--size-4-2);
}
.rag-provider-section > .group-title,
.rag-provider-section > .empty,
.rag-provider-section > .form,
.rag-provider-section > .provider-list {
  grid-column: 1 / -1;
}
</style>
