<script setup lang="ts">
// 新建书（newbook）：段 1 表单 + 段 2 AI 填设定。对齐 mockup v5 renderNbForm / renderNbOnboard。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import type { OnboardStep } from '../types'
import { createBook, runOnboardStep, saveOnboardStep } from '../api/books'

const router = useRouter()
const name = ref('')
const genre = ref('')
const kind = ref<'long' | 'short'>('long')
const leads = ref<string[]>([])
const targetWords = ref('')
const brief = ref('')
const submitting = ref(false)
const error = ref('')
const savedMsg = ref('')

// 当前书库（段 1 副标题显示所属书库；desktop getCurrentLibrary 取，浏览器版 fallback）
const currentLib = ref('当前书库')
onMounted(async () => {
  try {
    const p = await window.clwritingDesktop?.getCurrentLibrary()
    if (p) currentLib.value = p
  } catch {
    /* 浏览器版无 desktop IPC */
  }
})

// 段 2:onboard(AI 填设定)
const phase = ref<'form' | 'onboard'>('form')
const createdName = ref('')
const onboardSteps = ref<OnboardStep[]>([])
/** 按 kind 构建段 2 步骤集（长篇 9 步 / 短篇 5 步） */
function buildOnboardSteps(k: 'long' | 'short'): OnboardStep[] {
  if (k === 'short') {
    return [
      { key: 'collection-pitch', label: '📋 集子定位', running: false, result: null },
      { key: 'first-outline', label: '📝 首篇细纲', running: false, result: null },
      { key: 'style-sample', label: '✍️ 文风样章', running: false, result: null },
      { key: 'style-rules', label: '📜 文风铁律', running: false, result: null },
      { key: 'style-quotes', label: '💎 金句库', running: false, result: null },
    ]
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
    const body = {
      name: name.value.trim(),
      genre: genre.value.trim(),
      kind: kind.value,
      host: 'cc',
    }
    // 长篇且用户勾选了扩展类才传；留空 → doInit 按题材自动推荐
    const request = { ...body } as Parameters<typeof createBook>[0]
    if (kind.value === 'long' && leads.value.length > 0) request.leads = leads.value
    // 目标字数（可选，落 book.yaml target_words，总览页算完成度）
    const tw = Number(targetWords.value)
    if (Number.isFinite(tw) && tw > 0) request.targetWords = tw
    // 简介（可选，落 简介.md）
    if (brief.value.trim()) request.brief = brief.value.trim()
    const data = await createBook(request)
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
    s.result = await runOnboardStep(createdName.value, step)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
  s.running = false
}

/** 保存段 2 某步的编辑（作者预览后改内容再落盘） */
async function onboardSave(s: OnboardStep): Promise<void> {
  if (!s.result || !createdName.value) return
  try {
    const d = await saveOnboardStep(createdName.value, s.key, s.result.content)
    s.result.words = d.words ?? s.result.content.length
    savedMsg.value = `✓ ${s.label} 已保存`
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function finishOnboard(): void {
  router.push(`/books/${encodeURIComponent(createdName.value)}`)
}

// kind 切换实时预览长/短篇目录结构差异
const dirPreview = computed(() =>
  kind.value === 'short'
    ? ['篇/NNN-标题/正文.md（每篇独立）', '定稿/设定/（角色·境界·集子定位）', '文风/（样章·铁律·金句，整集共享）', '工作区/']
    : ['定稿/正文/章号-标题.md（每章一文件）', '大纲/（总纲·卷纲·账本类）', '定稿/设定/（角色·境界·世界观）', '文风/（样章·铁律·金句）', '工作区/'],
)
const canSubmit = computed(() => name.value.trim().length > 0 && !submitting.value)
</script>

<template>
  <div class="workspace full">
    <!-- 段 1：init 表单 -->
    <div v-if="phase === 'form'" class="shelf-inner" style="max-width:720px">
      <button class="btn" style="margin-bottom:18px" @click="router.push('/shelf')">← 返回</button>
      <div class="shelf-title">新建书籍</div>
      <div class="panel-sub" style="margin:6px 0 22px">所属书库：{{ currentLib }}</div>

      <form class="card" style="padding:18px 20px" @submit.prevent="submit">
        <div class="sfield">
          <label>书名 <span style="color:var(--cinnabar)">*</span></label>
          <input v-model="name" placeholder="如：我的世界" />
        </div>
        <div class="sfield">
          <label>题材</label>
          <input v-model="genre" placeholder="如：玄幻 / 悬疑 / 言情（驱动账本推荐）" />
        </div>
        <div class="sfield">
          <label>类型</label>
          <div class="seg">
            <button type="button" :class="{ active: kind === 'long' }" @click="kind = 'long'">长篇</button>
            <button type="button" :class="{ active: kind === 'short' }" @click="kind = 'short'">短篇集</button>
          </div>
        </div>
        <div class="sfield">
          <label>目标字数</label>
          <input type="number" v-model="targetWords" placeholder="如：300000（可选，算完成度）" />
        </div>
        <div class="sfield">
          <label>简介</label>
          <textarea v-model="brief" rows="3" placeholder="一两句话讲清这本书讲什么、主角是谁、核心看点"></textarea>
        </div>
        <div class="sfield">
          <label>目录</label>
          <pre class="dir-preview">{{ dirPreview.join('\n') }}</pre>
        </div>
        <div v-if="kind === 'long'" class="sfield">
          <label>扩展账本</label>
          <div class="nb-leads">
            <label v-for="l in EXTENDED_LEADS" :key="l" class="nb-lead">
              <input type="checkbox" :checked="leads.includes(l)" @change="toggleLead(l)" /> {{ l }}
            </label>
          </div>
        </div>
        <div class="sfield">
          <label>AI 宿主</label>
          <div class="nb-host">
            <span class="host-on">⚡ Claude Code (cc)</span>
            <span class="host-off" title="首版暂不支持">Codex（暂未支持）</span>
          </div>
        </div>
      </form>

      <p v-if="error" style="color:var(--cinnabar);font-size:13px;margin:12px 0">{{ error }}</p>
      <div class="btn-row" style="justify-content:flex-end">
        <button class="btn primary" :disabled="!canSubmit" @click="submit">
          {{ submitting ? '创建中…' : '创建 → 进段 2' }}
        </button>
      </div>
    </div>

    <!-- 段 2：AI 填设定 -->
    <div v-else class="shelf-inner" style="max-width:780px">
      <button class="btn" style="margin-bottom:18px" @click="router.push('/shelf')">← 返回书架</button>
      <div class="shelf-title">段 2 · AI 填设定</div>
      <div class="panel-sub" style="margin:6px 0 22px">
        《{{ createdName }}》已创建 · 让 AI 据题材填设定（每步可生成 / 编辑 / 重生成 / 跳过）
      </div>

      <div v-for="s in onboardSteps" :key="s.key" class="card nb-step" :class="{ skipped: s.skipped }">
        <div class="step-head">
          <span class="step-label">{{ s.label }}</span>
          <span class="tag" :class="s.result ? 'green' : s.skipped ? 'gray' : ''">
            {{ s.skipped ? '已跳过' : s.result ? '已生成' : '待处理' }}
          </span>
          <div class="step-ops">
            <button class="btn" :disabled="s.running" @click="onboardRun(s.key)">
              {{ s.running ? '生成中…' : s.result ? '🔄 重生成' : '⚡ 生成' }}
            </button>
            <button v-if="!s.result && !s.skipped" class="btn" @click="s.skipped = true">⏭ 跳过</button>
            <button v-else-if="s.skipped" class="btn" @click="s.skipped = false">恢复</button>
          </div>
        </div>
        <template v-if="s.result">
          <textarea v-model="s.result.content" class="result-edit" rows="6"></textarea>
          <div class="step-foot">
            <span class="result-path">{{ s.result.path }} · {{ s.result.words }} 字</span>
            <button class="btn primary" @click="onboardSave(s)">💾 保存编辑</button>
          </div>
        </template>
      </div>

      <p v-if="error" style="color:var(--cinnabar);font-size:13px;margin:12px 0">{{ error }}</p>
      <p v-if="savedMsg" style="color:var(--ink-cyan);font-size:13px;margin:8px 0">{{ savedMsg }}</p>
      <div class="btn-row" style="justify-content:flex-end">
        <button class="btn primary" @click="finishOnboard">完成 → 进单书</button>
      </div>
    </div>
  </div>
</template>
