<script setup lang="ts">
// AI 服务服务商管理面板（设置页「服务商」tab 的内容）。
// 应用级配置，跨书共享，存 userData/providers.json。
import { ref, onMounted } from 'vue'
import { Plus, Trash2, Check, Zap, Loader2, AlertTriangle, Pencil, RefreshCw } from 'lucide-vue-next'
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
  type ProviderConfDto,
  type ProviderCaps,
  type Protocol,
  type AuthStrategy,
  type TestResult,
  type TierSlot,
} from '../../api/providers'
import { useUiStore } from '../../stores/ui'
import { friendlyError } from '../../shared/error'
import { useChatTier } from '../../composables/useChatTier'

const ui = useUiStore()

const providers = ref<ProviderConfDto[]>([])
const currentId = ref<string | null>(null)
const loading = ref(false)
const testing = ref<string | null>(null)
const testResults = ref<Map<string, TestResult>>(new Map())
const probeModel = ref('') // 测试连接用的模型（默认当前模型，可手动切换）

// 任务档位（D 档：创作档/助手档/对话档）
const models = ref<string[]>([])
const tierForm = ref<{ creative: TierSlot; assistant: TierSlot | null; chat: TierSlot | null }>({
  creative: { model: '', effort: 'xhigh' },
  assistant: null,
  chat: null,
})
const assistantEnabled = ref(false)
const chatTierEnabled = ref(false)
const tierSaving = ref(false)
const fetchingModels = ref(false)

/** 手动获取模型列表（初始拉取失败时的重试入口）。 */
async function fetchModelList(): Promise<void> {
  if (!currentId.value || fetchingModels.value) return
  fetchingModels.value = true
  try {
    const r = await fetchModels({ id: currentId.value })
    models.value = r.models
    ui.toast(`已获取 ${r.models.length} 个模型`, 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
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
      try {
        const r = await fetchModels({ id: currentId.value })
        models.value = r.models
        // 默认探测模型 = 当前全局模型；不在列表中则取首个
        probeModel.value = data.currentModel ?? r.models[0] ?? ''
      } catch {
        models.value = []
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

/** 选协议类型——自动定认证策略（anthropic→anthropic 头，openai→bearer） */
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
    // P0-2：服务商表已变 → 刷新 AI 可达性（新增后未测连接按钮仍灰，语义正确）
    void ui.probeAiStatus()
    await refresh()
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

async function remove(p: ProviderConfDto): Promise<void> {
  const ok = await ui.ask({
    title: '删除服务商',
    message: `确认删除「${p.name}」？删除后不可恢复。`,
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    const r = await deleteProvider(p.id)
    currentId.value = r.currentId
    // P0-2：删除可能翻转可达性（删除当前服务商 + 无兜底 → 不可达）
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
    // P0-2：切换当前服务商后工作台/开书按钮应立即可用
    void ui.probeAiStatus()
    ui.toast(`已启用「${p.name}」`, 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}

async function test(p: ProviderConfDto): Promise<void> {
  testing.value = p.id
  try {
    const r = await testProvider(p.id, probeModel.value || undefined)
    testResults.value.set(p.id, r)
    // P0-2：测试通过 → caps 落库 → 可达性翻转，工作台按钮即时解灰
    void ui.probeAiStatus()
    await refresh()
    if (r.ok && r.caps?.connected) ui.toast(`${p.name} 测试通过`, 'success')
    else ui.toast(r.error ?? '测试失败', 'error')
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
    <!-- 服务商列表 -->
    <template v-if="!editing">
      <div class="group-title">
        AI 服务服务商
        <button class="add-btn" @click="startAdd"><Plus :size="14" />添加</button>
      </div>

      <div v-if="loading" class="empty"><Loader2 :size="20" class="spin" /> 加载中...</div>

      <div v-else-if="providers.length === 0" class="empty">
        <p>尚未配置任何 AI 服务商</p>
        <button class="add-btn-lg" @click="startAdd"><Plus :size="16" />添加服务商</button>
      </div>

      <template v-else>
        <div v-for="p in providers" :key="p.id" class="provider-card" :class="{ active: p.id === currentId }">
          <div class="provider-head">
            <div class="provider-name">
              <span class="dot" :class="p.id === currentId ? 'on' : 'off'" />
              {{ p.name }}
            </div>
            <div class="provider-actions">
              <button
                v-if="p.id !== currentId && p.caps?.connected"
                class="mini-btn"
                data-tip="设为当前启用"
                @click="activate(p)"
              >
                <Check :size="13" />
              </button>
              <!-- 测试模型 + 下拉（挪到测试按钮前，与按钮同行） -->
              <span class="probe-inline" :title="models.length ? '测试连接用模型' : '请先获取模型列表'">
                <span class="probe-hint">测试模型</span>
                <select v-model="probeModel" class="probe-select" :disabled="!models.length">
                  <option value="" disabled>{{ models.length ? '选择模型' : '请先获取列表' }}</option>
                  <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
                </select>
              </span>
              <button
                class="mini-btn"
                :class="{ testing: testing === p.id }"
                :disabled="testing === p.id"
                data-tip="测试连接"
                @click="test(p)"
              >
                <Loader2 v-if="testing === p.id" :size="13" class="spin" />
                <Zap v-else :size="13" />
              </button>
              <button class="mini-btn" data-tip="编辑" @click="startEdit(p)">
                <Pencil :size="13" />
              </button>
              <button class="mini-btn danger" data-tip="删除" @click="remove(p)">
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
          <div class="provider-meta">
            <span class="tag">{{ p.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI' }}</span>
            <span class="base-url" :title="p.baseUrl">{{ p.baseUrl }}</span>
            <span class="key">{{ p.apiKeyMasked }}</span>
          </div>
          <!-- caps 徽章（测试模型已挪到测试按钮前） -->
          <div class="provider-meta">
            <span v-if="p.caps" class="caps-badge" :class="capsBadge(p.caps)?.cls">{{ capsBadge(p.caps)?.text }}</span>
            <span v-if="p.caps?.connected" class="probed-at">{{ timeAgo(p.capsProbedAt) }}</span>
          </div>
          <!-- 测试结果详情 -->
          <div v-if="testResults.get(p.id)" class="test-detail" :class="{ fail: !testResults.get(p.id)?.ok }">
            <div v-for="(d, i) in testResults.get(p.id)?.details" :key="i" class="detail-line">{{ d }}</div>
            <div v-if="testResults.get(p.id)?.error" class="detail-line err">
              <AlertTriangle :size="12" /> {{ testResults.get(p.id)?.error }}
            </div>
          </div>
          <div v-if="!p.caps" class="caps-hint">
            <AlertTriangle :size="12" /> 尚未测试连接——未测试的服务商不能启用
          </div>
        </div>
      </template>

      <!-- 任务档位 -->
      <div v-if="currentId" class="tier-section">
        <div class="group-title">
          任务档位
          <button class="add-btn" :disabled="fetchingModels" @click="fetchModelList">
            <Loader2 v-if="fetchingModels" :size="14" class="spin" />
            <RefreshCw v-else :size="14" />
            {{ fetchingModels ? '获取中…' : '获取模型列表' }}
          </button>
        </div>
        <div class="tier-card">
          <div class="tier-head">
            <span class="tier-name">创作档</span>
            <span class="tier-desc">写正文 / 改写 / 大纲</span>
          </div>
          <div class="tier-fields">
            <select v-model="tierForm.creative.model" class="tier-select">
              <option value="" disabled>{{ models.length ? '选择模型' : '请先获取模型列表' }}</option>
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
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
            <label class="tier-toggle">
              <input type="checkbox" v-model="assistantEnabled" @change="toggleAssistant(assistantEnabled)" />
              <span class="tier-name">助手档</span>
            </label>
            <span class="tier-desc">三审 / 分析 · 不配则与创作档相同</span>
          </div>
          <div v-if="assistantEnabled && tierForm.assistant" class="tier-fields">
            <select v-model="tierForm.assistant.model" class="tier-select">
              <option value="" disabled>{{ models.length ? '选择模型' : '请先获取模型列表' }}</option>
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
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
            <label class="tier-toggle">
              <input type="checkbox" v-model="chatTierEnabled" @change="toggleChatTier(chatTierEnabled)" />
              <span class="tier-name">对话档</span>
            </label>
            <span class="tier-desc">对话助手 · 不配则与创作档相同</span>
          </div>
          <div v-if="chatTierEnabled && tierForm.chat" class="tier-fields">
            <select v-model="tierForm.chat.model" class="tier-select">
              <option value="" disabled>{{ models.length ? '选择模型' : '请先获取模型列表' }}</option>
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
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
        <button class="save-btn" :disabled="tierSaving" @click="saveTiers">
          <Loader2 v-if="tierSaving" :size="14" class="spin" /> 保存档位
        </button>
      </div>
    </template>

    <!-- 新增/编辑表单 -->
    <template v-else>
      <div class="group-title">{{ editId ? '编辑服务商' : '新增服务商' }}</div>
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
/* ── 分组标题 ── */
.group-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
  padding-bottom: var(--size-4-2);
}

/* ── 添加按钮 ── */
.add-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  font-size: var(--font-size-xs);
  font-weight: 600;
  border: 1px solid var(--background-modifier-border);
  border-radius: 99px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
  text-transform: none;
  letter-spacing: 0;
}
.add-btn:hover {
  color: var(--text-normal);
  border-color: var(--interactive-accent);
}
.add-btn-lg {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  font-size: var(--font-size-s);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.add-btn-lg:hover {
  background: var(--background-modifier-hover);
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

/* ── 服务商卡片 ── */
.provider-card {
  padding: var(--size-4-3) var(--size-4-4);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  margin-bottom: var(--size-4-2);
  transition: border-color var(--dur-fast) var(--ease-out);
}
.provider-card.active {
  border-color: color-mix(in srgb, var(--interactive-accent) 40%, transparent);
  background: color-mix(in srgb, var(--interactive-accent) 4%, transparent);
}

.provider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.provider-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
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

.provider-actions {
  display: flex;
  gap: 4px;
}
.mini-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-s);
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
}
.mini-btn.testing {
  pointer-events: none;
}

.provider-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  flex-wrap: wrap;
}
.tag {
  padding: 1px 7px;
  font-size: var(--font-size-xxs);
  font-weight: 600;
  border-radius: 99px;
  background: color-mix(in srgb, var(--interactive-accent) 14%, transparent);
  color: var(--text-accent);
}
.tag.dim {
  background: var(--background-modifier-hover);
  color: var(--text-faint);
}
.key {
  font-family: var(--font-monospace);
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.base-url {
  font-family: var(--font-monospace);
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── 测试模型选择（与测试按钮同行，同高协调） ── */
.probe-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-right: 2px;
}
.probe-hint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
  white-space: nowrap;
}
.probe-select {
  max-width: 150px;
  height: 26px; /* 与 mini-btn 同高 */
  padding: 0 22px 0 8px;
  font-size: var(--font-size-s); /* 与卡片标题同号 */
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.probe-select:hover:not(:disabled) {
  border-color: var(--interactive-accent);
}
.probe-select:focus {
  outline: none;
  border-color: var(--interactive-accent);
}
.probe-select:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── caps 徽章 ── */
.caps-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}
.caps-badge {
  font-size: var(--font-size-xxs);
  font-weight: 600;
  padding: 2px 8px;
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

.caps-hint {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  font-size: var(--font-size-xs);
  color: var(--color-orange, var(--text-muted));
}

/* ── 测试详情 ── */
.test-detail {
  margin-top: 6px;
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
.tier-card {
  padding: var(--size-4-3) var(--size-4-4);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  margin-bottom: var(--size-4-2);
}
.tier-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--size-4-2);
}
.tier-name {
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-normal);
}
.tier-desc {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.tier-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.tier-toggle input {
  accent-color: var(--interactive-accent);
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
}
.tier-select.sm {
  flex: 0 0 auto;
  min-width: 80px;
}
</style>
