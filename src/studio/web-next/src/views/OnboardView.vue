<script setup lang="ts">
// 开书对话（重设计 · 向导式 master-detail）：
// 左栏分组步骤列表 + 右栏详情/生成/编辑面板。
// 点步骤 → 右栏展开详情（不直接生成）→ 点生成 → 编辑 → 落盘。
import { ref, computed, onMounted } from 'vue'
import { TriangleAlert, Check, Sparkles, FileText, Loader2, RotateCcw, BookOpen } from 'lucide-vue-next'
import {
  onboardAi, onboardSave,
  STEP_LABEL, STEP_PATH, STEP_DESC, type OnboardStep,
} from '../api/onboard'
import { useUiStore } from '../stores/ui'
import { useTreeStore } from '../stores/tree'

const props = defineProps<{ bookName: string }>()
const ui = useUiStore()
const tree = useTreeStore()

// ── 步骤分组（语义层次，非平铺）──
const STEP_GROUPS: { label: string; steps: OnboardStep[] }[] = [
  { label: '设定基础', steps: ['synopsis', 'characters', 'world', 'realm'] },
  { label: '大纲规划', steps: ['volume', 'leads-seed'] },
  { label: '文风校准', steps: ['style-sample', 'style-rules', 'style-quotes'] },
  { label: '短篇专属', steps: ['collection-pitch', 'first-outline'] },
]

const ALL_STEPS = STEP_GROUPS.flatMap((g) => g.steps)

const stepIndex = computed(() => {
  const m = new Map<OnboardStep, number>()
  let n = 0
  for (const g of STEP_GROUPS) for (const s of g.steps) m.set(s, ++n)
  return m
})

function isGenerated(step: OnboardStep): boolean {
  return tree.byPath.has(STEP_PATH[step])
}

const generatedCount = computed(() => ALL_STEPS.filter((s) => isGenerated(s)).length)
const progressPct = computed(() => Math.round((generatedCount.value / ALL_STEPS.length) * 100))

const active = ref<OnboardStep | null>(null)
const phase = ref<'detail' | 'loading' | 'result'>('detail')
const content = ref('')
const saving = ref(false)
const err = ref<string | null>(null)
const lastWords = ref(0)

function selectStep(step: OnboardStep): void {
  if (phase.value === 'loading') return
  active.value = step
  phase.value = 'detail'
  content.value = ''
  err.value = null
}

async function gen(): Promise<void> {
  if (!active.value) return
  phase.value = 'loading'
  err.value = null
  content.value = ''
  try {
    const r = await onboardAi(props.bookName, { step: active.value })
    content.value = r.content
    lastWords.value = r.words
    phase.value = 'result'
    ui.toast(`${STEP_LABEL[active.value]} 生成（${r.words} 字）`, 'success')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
    phase.value = 'detail'
  }
}

async function save(): Promise<void> {
  if (!active.value) return
  saving.value = true
  try {
    await onboardSave(props.bookName, { step: active.value, content: content.value })
    ui.toast('已落盘', 'success')
    void tree.load(props.bookName)
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
    ui.toast(err.value, 'error')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  await tree.load(props.bookName)
  const first = ALL_STEPS.find((s) => !isGenerated(s))
  if (first) selectStep(first)
})
</script>

<template>
  <div class="onboard">
    <div v-if="ui.aiAvailable === false" class="ai-warn">
      AI 驱动不可用（claude CLI 未就绪），开书对话暂不可用。
    </div>

    <!-- Hero（渐变头，与总览页同语言） -->
    <section class="ob-hero">
      <div class="hero-top">
        <div class="hero-left">
          <h1 class="hero-title">开书对话</h1>
          <span class="hero-sub">分步 AI 生成设定 · 逐确认后落盘</span>
        </div>
        <div class="hero-progress">
          <div class="prog-track">
            <div class="prog-fill" :style="{ width: progressPct + '%' }"></div>
          </div>
          <span class="prog-text">{{ generatedCount }}/{{ ALL_STEPS.length }} 已完成</span>
        </div>
      </div>
      <div class="hero-warn"><TriangleAlert :size="13" /> 各步会覆盖对应设定文件，已开的书慎用。</div>
    </section>

    <!-- 主体两栏 -->
    <div class="ob-layout">
      <!-- 左栏：分组步骤列表 -->
      <nav class="ob-rail">
        <div v-for="g in STEP_GROUPS" :key="g.label" class="rail-group">
          <div class="rail-group-label">{{ g.label }}</div>
          <button
            v-for="s in g.steps"
            :key="s"
            class="rail-item"
            :class="{ on: active === s }"
            :disabled="phase === 'loading'"
            @click="selectStep(s)"
          >
            <span class="rail-no">{{ stepIndex.get(s) }}</span>
            <span class="rail-label">{{ STEP_LABEL[s] }}</span>
            <span v-if="isGenerated(s)" class="rail-dot" title="已生成"></span>
          </button>
        </div>
      </nav>

      <!-- 右栏：详情 / 生成 / 编辑 -->
      <section class="ob-panel">
        <!-- 空状态 -->
        <div v-if="!active" class="panel-empty">
          <BookOpen :size="28" />
          <p>选择左侧步骤开始</p>
        </div>

        <template v-else>
          <!-- ① 详情确认 -->
          <div v-if="phase === 'detail'" class="phase-detail">
            <div class="panel-head">
              <FileText :size="14" />
              <span class="ph-title">{{ STEP_LABEL[active] }}</span>
              <span v-if="isGenerated(active)" class="status done"><Check :size="11" /> 已生成</span>
              <span v-else class="status">未生成</span>
            </div>

            <p class="detail-desc">{{ STEP_DESC[active] }}</p>

            <div class="detail-meta">
              <div class="meta-row">
                <span class="meta-k">落盘路径</span>
                <code class="meta-v">{{ STEP_PATH[active] }}</code>
              </div>
              <div v-if="isGenerated(active)" class="meta-warn">
                <TriangleAlert :size="12" /> 该文件已存在，重新生成将覆盖已有内容。
              </div>
            </div>

            <div class="detail-actions">
              <button class="btn primary" :disabled="ui.aiAvailable === false" @click="gen">
                <Sparkles :size="14" />
                <span>{{ isGenerated(active) ? '重新生成' : '生成' }}</span>
              </button>
            </div>
          </div>

          <!-- ② 生成中 -->
          <div v-else-if="phase === 'loading'" class="phase-loading">
            <Loader2 :size="22" class="spin" />
            <div class="loading-text">
              <span class="loading-title">{{ STEP_LABEL[active] }} 生成中…</span>
              <span class="loading-hint">AI 阻塞数十秒，请耐心等待</span>
            </div>
          </div>

          <!-- ③ 编辑 + 落盘 -->
          <div v-else class="phase-result">
            <div class="panel-head">
              <span class="ph-title">{{ STEP_LABEL[active] }}</span>
              <span class="status done">完成 · {{ lastWords }} 字</span>
            </div>
            <textarea
              v-model="content"
              class="content-edit"
              placeholder="可编辑后落盘"
            ></textarea>
            <div class="actions">
              <button class="btn primary" :disabled="saving" @click="save">
                {{ saving ? '保存中…' : '落盘' }}
              </button>
              <button class="btn" @click="gen">
                <RotateCcw :size="13" /><span>重新生成</span>
              </button>
            </div>
          </div>
        </template>

        <div v-if="err" class="err-msg">{{ err }}</div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.onboard {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-5) var(--size-4-6) var(--size-4-8);
  max-width: 880px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
}

/* ══ 面板基础（与总览页同语言）══ */
.ob-rail,
.ob-panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-s);
  animation: fade-up var(--dur-fast) var(--ease-out) both;
}
.ob-panel { animation-delay: 60ms; }
@keyframes fade-up {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}

/* panel-head（与总览页同模式：图标 + 标题，muted 色） */
.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: var(--size-4-4);
  padding: var(--size-4-4) var(--size-4-5) 0;
}
.panel-head svg {
  opacity: 0.5;
  flex-shrink: 0;
}
.ph-title {
  font-size: var(--font-size-l);
  font-weight: 700;
  color: var(--text-normal);
  letter-spacing: -0.01em;
}

/* ══ Hero ══ */
.ob-hero {
  background:
    radial-gradient(ellipse 70% 100% at 100% 0%,
      color-mix(in srgb, var(--interactive-accent) 12%, transparent), transparent 65%),
    linear-gradient(135deg,
      color-mix(in srgb, var(--interactive-accent) 5%, var(--background-primary)),
      var(--background-primary));
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 22px 26px 16px;
  overflow: hidden;
  animation: fade-up 0.5s var(--ease-out) both;
}
.hero-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--size-4-4);
}
.hero-left {
  display: flex;
  align-items: baseline;
  gap: var(--size-4-3);
}
.hero-title {
  margin: 0;
  font-size: var(--font-size-2xl);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-normal);
}
.hero-sub {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.hero-progress {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-shrink: 0;
}
.prog-track {
  width: 120px;
  height: 4px;
  border-radius: 99px;
  background: var(--background-modifier-border);
  overflow: hidden;
}
.prog-fill {
  height: 100%;
  border-radius: 99px;
  background: var(--dv-good);
  transition: width var(--dur-slow) var(--ease-out);
}
.prog-text {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.hero-warn {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: var(--size-4-3);
  font-size: var(--font-size-xs);
  color: var(--text-warning);
}

/* ══ 主体两栏 ══ */
.ob-layout {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: var(--size-4-4);
  align-items: start;
}

/* ── 左栏 ── */
.ob-rail {
  position: sticky;
  top: var(--size-4-5);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-1);
  padding: var(--size-4-3);
}
.rail-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rail-group:not(:first-child) {
  margin-top: var(--size-4-2);
  padding-top: var(--size-4-2);
  border-top: 1px solid var(--background-modifier-border);
}
.rail-group-label {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: var(--size-4-1) 6px var(--size-4-2);
  font-size: var(--font-size-s);
  font-weight: 700;
  color: var(--text-normal);
}
.rail-group-label::before {
  content: '';
  width: 3px;
  height: 13px;
  border-radius: 2px;
  background: var(--interactive-accent);
  opacity: 0.6;
}
.rail-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-left: 2px solid transparent;
  border-radius: 0 var(--radius-s) var(--radius-s) 0;
  background: none;
  font-size: var(--font-size-s);
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  transition: all var(--dur-fast) var(--ease-out);
}
.rail-item:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.rail-item.on {
  background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
  border-left-color: var(--interactive-accent);
  color: var(--text-accent);
  font-weight: 600;
}
.rail-item:disabled {
  opacity: 0.5;
  cursor: default;
}
.rail-no {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  min-width: 16px;
}
.rail-item.on .rail-no {
  color: var(--text-accent);
}
.rail-label {
  flex: 1;
}
.rail-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dv-good);
  flex-shrink: 0;
}

/* ── 右栏 ── */
.ob-panel {
  min-height: 340px;
  padding-bottom: var(--size-4-5);
}

/* 空状态 */
.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--size-4-2);
  min-height: 280px;
  color: var(--text-faint);
}
.panel-empty p {
  margin: 0;
  font-size: var(--font-size-s);
}

/* 状态标签 */
.status {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: 99px;
  font-size: var(--font-size-xs);
  font-weight: 500;
  color: var(--text-muted);
  background: var(--background-modifier-hover);
}
.status.done {
  color: var(--dv-good);
  background: color-mix(in srgb, var(--dv-good) 12%, transparent);
}

/* ① 详情 */
.phase-detail {
  padding: 0 var(--size-4-5) var(--size-4-2);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
}
.detail-desc {
  margin: 0;
  font-size: var(--font-size-m);
  line-height: 1.8;
  color: var(--text-muted);
}
.detail-meta {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-2);
  padding: var(--size-4-3);
  background: var(--background-secondary);
  border-radius: var(--radius-m);
}
.meta-row {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}
.meta-k {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
}
.meta-v {
  font-family: var(--font-monospace);
  font-size: var(--font-size-s);
  color: var(--text-normal);
  background: var(--background-primary);
  padding: 2px 8px;
  border-radius: var(--radius-s);
}
.meta-warn {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--font-size-xs);
  color: var(--text-warning);
}
.detail-actions {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
}

/* ② 生成中 */
.phase-loading {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  padding: var(--size-4-8) var(--size-4-5);
}
.loading-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.loading-title {
  font-size: var(--font-size-m);
  font-weight: 600;
  color: var(--text-normal);
}
.loading-hint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}

/* ③ 结果 */
.phase-result {
  padding: 0 var(--size-4-5) var(--size-4-2);
  display: flex;
  flex-direction: column;
  gap: var(--size-4-3);
}
.content-edit {
  width: 100%;
  min-height: 300px;
  box-sizing: border-box;
  padding: var(--size-4-3);
  font-family: var(--prose-font);
  font-size: var(--prose-size);
  line-height: var(--prose-lh);
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  resize: vertical;
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.content-edit:focus {
  border-color: var(--interactive-accent);
  background: var(--background-primary);
}
.actions {
  display: flex;
  gap: var(--size-4-2);
}

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 16px;
  font-size: var(--font-size-m);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  background: var(--background-primary);
  color: var(--text-normal);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease-out);
}
.btn.primary {
  background: var(--interactive-accent);
  border-color: transparent;
  color: var(--text-on-accent);
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.btn:hover:not(:disabled) {
  border-color: var(--background-modifier-border-hover);
}
.btn.primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}

.spin {
  animation: cw-spin 0.9s linear infinite;
  color: var(--text-accent);
}
@keyframes cw-spin {
  to { transform: rotate(360deg); }
}

.err-msg {
  margin-top: var(--size-4-3);
  padding: 0 var(--size-4-5);
  font-size: var(--font-size-s);
  color: var(--text-error);
}
.ai-warn {
  padding: 8px 14px;
  font-size: var(--font-size-s);
  color: var(--text-warning);
  background: color-mix(in srgb, var(--text-warning) 10%, transparent);
  border-radius: var(--radius-m);
}
</style>
