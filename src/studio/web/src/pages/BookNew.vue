<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'

interface OnboardResult {
  path: string
  words: number
  content: string
}
interface OnboardStep {
  key: 'synopsis' | 'characters' | 'world' | 'realm' | 'volume' | 'leads-seed' | 'style-sample' | 'style-rules' | 'style-quotes'
  label: string
  running: boolean
  result: OnboardResult | null
}

const router = useRouter()
const name = ref('')
const genre = ref('')
const kind = ref<'long' | 'short'>('long')
const leads = ref<string[]>([])
const targetWords = ref('')
const brief = ref('')
const submitting = ref(false)
const error = ref('')

// 段 2:onboard(AI 填设定)
const phase = ref<'form' | 'onboard'>('form')
const createdName = ref('')
const onboardSteps = ref<OnboardStep[]>([])
/** 按 kind 构建段 2 步骤集（长篇 9 步 / 短篇专属待 5.2 短篇补全） */
function buildOnboardSteps(k: 'long' | 'short'): OnboardStep[] {
  if (k === 'short') {
    return [{ key: 'synopsis', label: '📋 集子定位', running: false, result: null }]
  }
  return [
    { key: 'synopsis', label: '📋 总纲', running: false, result: null },
    { key: 'characters', label: '👥 角色', running: false, result: null },
    { key: 'world', label: '🌍 世界观', running: false, result: null },
    { key: 'realm', label: '⚡ 境界体系', running: false, result: null },
    { key: 'volume', label: '📚 卷纲', running: false, result: null },
    { key: 'leads-seed', label: '🎯 账本种子', running: false, result: null },
    { key: 'style-sample', label: '✍️ 文风样章', running: false, result: null },
    { key: 'style-rules', label: '📜 文风铁律', running: false, result: null },
    { key: 'style-quotes', label: '💎 金句库', running: false, result: null },
  ]
}

const EXTENDED_LEADS = ['局线', '设定线', '成长线', '关系债']

function toggleLead(l: string): void {
  const i = leads.value.indexOf(l)
  if (i >= 0) leads.value.splice(i, 1)
  else leads.value.push(l)
}

async function submit(): Promise<void> {
  submitting.value = true
  error.value = ''
  try {
    const body: Record<string, unknown> = {
      name: name.value.trim(),
      genre: genre.value.trim(),
      kind: kind.value,
      host: 'cc',
    }
    // 长篇且用户勾选了扩展类才传；留空 → doInit 按题材自动推荐
    if (kind.value === 'long' && leads.value.length > 0) body.leads = leads.value
    // 目标字数（可选，落 book.yaml target_words，总览页算完成度）
    const tw = Number(targetWords.value)
    if (Number.isFinite(tw) && tw > 0) body.targetWords = tw
    // 简介（可选，落 简介.md）
    if (brief.value.trim()) body.brief = brief.value.trim()
    const r = await fetch('/api/books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await r.json().catch(() => ({}))) as { name?: string; error?: string }
    if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`)
    createdName.value = data.name ?? name.value.trim()
    phase.value = 'onboard' // 建书成功 → 进段 2(不直接跳单书)
    onboardSteps.value = buildOnboardSteps(kind.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}

/** 段 2 各步:POST /onboard-ai → spawnRole 产设定 → 落盘 + 展示 */
async function onboardRun(step: OnboardStep['key']): Promise<void> {
  const s = onboardSteps.value.find((x) => x.key === step)
  if (!s || s.running || !createdName.value) return
  s.running = true
  s.result = null
  error.value = ''
  try {
    const r = await fetch(`/api/books/${encodeURIComponent(createdName.value)}/onboard-ai`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step }),
    })
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; path?: string; words?: number; content?: string; error?: string }
    if (r.ok && d.ok) {
      s.result = { path: d.path ?? '', words: d.words ?? 0, content: d.content ?? '' }
    } else {
      error.value = d.error ?? `HTTP ${r.status}`
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  s.running = false
}

function finishOnboard(): void {
  router.push(`/books/${encodeURIComponent(createdName.value)}`)
}

// kind 切换实时预览长/短篇目录结构差异（5.1 三点增强③）
const dirPreview = computed(() =>
  kind.value === 'short'
    ? ['篇/NNN-标题/正文.md（每篇独立）', '定稿/设定/（角色·境界·集子定位）', '文风/（样章·铁律·金句，整集共享）', '工作区/']
    : ['定稿/正文/章号-标题.md（每章一文件）', '大纲/（总纲·卷纲·账本类）', '定稿/设定/（角色·境界·世界观）', '文风/（样章·铁律·金句）', '工作区/'],
)
const canSubmit = computed(() => name.value.trim().length > 0 && !submitting.value)
</script>

<template>
  <section class="book-new">
    <div class="head">
      <button class="btn-back" @click="router.push('/')">← 返回书架</button>
    </div>

    <!-- 段 1:init 表单 -->
    <template v-if="phase === 'form'">
      <h2>新建书籍</h2>

      <form class="form" @submit.prevent="submit">
        <div class="field">
          <label>书名 <span class="req">*</span></label>
          <input v-model="name" placeholder="如：我的世界" />
        </div>

        <div class="field">
          <label>题材</label>
          <input v-model="genre" placeholder="如：玄幻 / 悬疑 / 言情（驱动账本推荐）" />
        </div>

        <div class="field">
          <label>类型</label>
          <div class="seg">
            <button type="button" :class="{ active: kind === 'long' }" @click="kind = 'long'">长篇</button>
            <button type="button" :class="{ active: kind === 'short' }" @click="kind = 'short'">短篇集</button>
          </div>
        </div>

        <div class="field">
          <label>目标字数 <span class="tip">可选，填了总览页显示完成度</span></label>
          <input type="number" v-model="targetWords" placeholder="如：300000（30 万字）" />
        </div>

        <div class="field">
          <label>简介 <span class="tip">可选，落 简介.md（长篇简介 / 短篇集定位）</span></label>
          <textarea v-model="brief" rows="3" placeholder="一两句话讲清这本书讲什么、主角是谁、核心看点"></textarea>
        </div>

        <div class="field">
          <label>目录结构（{{ kind === 'short' ? '短篇集' : '长篇' }}）</label>
          <pre class="dir-preview">{{ dirPreview.join('\n') }}</pre>
        </div>

        <div v-if="kind === 'long'" class="field">
          <label>扩展账本类 <span class="tip">留空则按题材自动推荐</span></label>
          <div class="leads">
            <label v-for="l in EXTENDED_LEADS" :key="l" class="lead">
              <input type="checkbox" :checked="leads.includes(l)" @change="toggleLead(l)" /> {{ l }}
            </label>
          </div>
        </div>

        <div class="field">
          <label>AI 宿主</label>
          <div class="host">
            <span class="host-active">Claude Code (cc)</span>
            <span class="host-disabled" title="首版暂不支持（决策 22）">Codex（暂未支持）</span>
          </div>
        </div>

        <p v-if="error" class="error">{{ error }}</p>

        <div class="actions">
          <button type="submit" class="btn-primary" :disabled="!canSubmit">
            {{ submitting ? '创建中…' : '创建' }}
          </button>
        </div>
      </form>
    </template>

    <!-- 段 2:AI 填设定 -->
    <template v-else>
      <h2>段 2 · AI 填设定</h2>
      <p class="onboard-tip">《{{ createdName }}》已创建。让 AI 据题材填设定(各步独立生成,可重跑覆盖)。</p>

      <div class="onboard-steps">
        <button
          v-for="s in onboardSteps"
          :key="s.key"
          class="btn-step"
          :class="{ done: !!s.result }"
          :disabled="s.running"
          @click="onboardRun(s.key)"
        >
          {{ s.running ? '生成中…' : s.label }}
        </button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <article v-for="s in onboardSteps" :key="s.key">
        <p v-if="s.result" class="result-tip">✓ 已生成 <span class="mono">{{ s.result.path }}</span>({{ s.result.words }} 字)</p>
        <pre v-if="s.result" class="result-content">{{ s.result.content }}</pre>
      </article>

      <div class="actions">
        <button class="btn-primary" @click="finishOnboard">完成 → 进单书</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.book-new {
  max-width: 640px;
  margin: 0 auto;
}
.head {
  margin-bottom: 16px;
}
.btn-back {
  padding: 6px 14px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
}
.btn-back:hover {
  border-color: #3b82f6;
}
h2 {
  margin: 12px 0 20px;
  font-size: 16px;
}
.form {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 24px;
  display: grid;
  gap: 18px;
}
.field {
  display: grid;
  gap: 6px;
}
.field > label {
  font-size: 13px;
  color: #374151;
}
.req {
  color: #dc2626;
}
.tip {
  color: #9ca3af;
  font-weight: normal;
}
.field input:not([type='checkbox']) {
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  font-size: 14px;
}
.field input:focus {
  outline: none;
  border-color: #3b82f6;
}
.seg {
  display: inline-flex;
  gap: 8px;
}
.seg button {
  padding: 6px 16px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
}
.seg button.active {
  border-color: #3b82f6;
  background: #eff6ff;
  color: #3b82f6;
  font-weight: 600;
}
.leads {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.lead {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  cursor: pointer;
}
.host {
  display: flex;
  gap: 16px;
  font-size: 14px;
}
.host-active {
  color: #3b82f6;
  font-weight: 600;
}
.host-disabled {
  color: #d1d5db;
}
.error {
  color: #dc2626;
  font-size: 13px;
  margin: 0;
}
.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.btn-primary {
  padding: 8px 24px;
  border: none;
  border-radius: 6px;
  background: #3b82f6;
  color: #fff;
  cursor: pointer;
  font-size: 14px;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 段 2 onboard */
.onboard-tip {
  background: #eff6ff;
  color: #1e40af;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 16px;
}
.onboard-steps {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
}
.btn-step {
  padding: 8px 16px;
  border: 1px solid #7c3aed;
  border-radius: 6px;
  background: #fff;
  color: #7c3aed;
  cursor: pointer;
  font-size: 14px;
}
.btn-step:disabled {
  opacity: 0.6;
  cursor: progress;
}
.btn-step.done {
  border-color: #059669;
  color: #059669;
}
.result-tip {
  margin: 0 0 6px;
  font-size: 13px;
  color: #065f46;
}
.mono {
  font-family: ui-monospace, monospace;
}
.result-content {
  margin: 0 0 16px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  color: #111827;
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
}
</style>
