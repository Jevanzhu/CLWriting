<script setup lang="ts">
// 开书对话（重设计 · 向导式 master-detail）：
// 左栏分组步骤列表 + 右栏详情/生成/编辑面板。
// 点步骤 → 右栏展开详情（不直接生成）→ 点生成 → 编辑 → 落盘。
// 巨石批 7c 拆分：梗概卡 → onboard/OnboardPremise、步骤列表 → OnboardStepRail、
// 步骤面板 → OnboardStepPanel；本文件留 Hero 进度、书型过滤（isShort/isGrowthBook）
// 与步骤状态机（active/phase/content 的 gen/save 编排）。
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { TriangleAlert } from 'lucide-vue-next'
import { onboardAi, onboardSave, STEP_LABEL, STEP_PATH, type OnboardStep } from '../api/onboard'
import { getConfig } from '../api/books'
import { useUiStore } from '../stores/ui'
import { useTreeStore } from '../stores/tree'
import BetaBadge from '../components/ui/BetaBadge.vue'
import OnboardPremise from '../components/onboard/OnboardPremise.vue'
import OnboardStepRail from '../components/onboard/OnboardStepRail.vue'
import OnboardStepPanel from '../components/onboard/OnboardStepPanel.vue'
import { friendlyError } from '../shared/error'

const props = defineProps<{ bookName: string }>()
const route = useRoute()
const ui = useUiStore()
const tree = useTreeStore()

// M-4（第十轮）：路由活书名复检——OnboardView 挂 :key=bookName，切书时本实例被重建、
// 死续体的 props 冻结在旧书（比 props 恒等），await 后只有比路由才能识别已切书
function stillOn(book: string): boolean {
  return String(route.params.name ?? '') === book
}

// ── 故事梗概（作者设想，AI 据其开书；localStorage 持久化在 OnboardPremise 卡内）──
const storyPremise = ref('')

// ── 步骤分组（语义层次，非平铺）──
const STEP_GROUPS: { label: string; steps: OnboardStep[] }[] = [
  { label: '设定基础', steps: ['synopsis', 'characters', 'world', 'realm'] },
  { label: '大纲规划', steps: ['volume', 'leads-seed'] },
  { label: '文风校准', steps: ['style-sample', 'style-rules', 'style-quotes'] },
  { label: '短篇专属', steps: ['first-outline'] },
]

// 非成长线书隐藏 realm（境界体系）步骤
const isGrowthBook = ref(true)
// 短篇集：无卷纲（精简布局），隐藏「卷纲」步骤；线索种子/角色/世界观保留（短篇也有设定层/布线）
const isShort = ref(false)
const visibleStepGroups = computed(() =>
  STEP_GROUPS
    // 短篇显示「短篇专属」组；长篇隐藏之
    .filter((g) => (isShort.value ? true : g.label !== '短篇专属'))
    .map((g) => ({
      ...g,
      steps: g.steps
        // 短篇无卷纲（默认一卷），隐藏卷纲步骤；线索种子/角色/世界观放开
        .filter((s) => !(isShort.value && s === 'volume'))
        .filter((s) => s !== 'realm' || isGrowthBook.value),
    }))
    .filter((g) => g.steps.length > 0),
)

const ALL_STEPS = computed<OnboardStep[]>(() => visibleStepGroups.value.flatMap((g) => g.steps))

function isGenerated(step: OnboardStep): boolean {
  return tree.byPath.has(STEP_PATH[step])
}

const generatedCount = computed(() => ALL_STEPS.value.filter((s) => isGenerated(s)).length)
const progressPct = computed(() => Math.round((generatedCount.value / ALL_STEPS.value.length) * 100))

const active = ref<OnboardStep | null>(null)
const phase = ref<'detail' | 'loading' | 'result'>('detail')
const content = ref('')
// R70-27（十八轮）：最近一次生成快照——「重新生成」脏检查用（手改未保存不静默丢稿）
const lastGenerated = ref('')
const saving = ref(false)
const err = ref<string | null>(null)
const lastWords = ref(0)
// R35-34：gen/save 函数级在途锁（域内 R69-29/R73-63 自设纪律）——双击在下一拍渲染
// 前仍可双触发，双生成双计费；loading 相位的按钮置换只覆盖渲染后的窗口
const genPending = ref(false)

function selectStep(step: OnboardStep): void {
  if (phase.value === 'loading') return
  active.value = step
  phase.value = 'detail'
  content.value = ''
  err.value = null
}

async function gen(): Promise<void> {
  if (genPending.value) return // R35-34：在途锁
  if (!active.value) return
  const step = active.value
  genPending.value = true
  try {
    await doGen(step)
  } finally {
    genPending.value = false
  }
}

async function doGen(step: OnboardStep): Promise<void> {
  // M-4（X-27 补齐）：同 save——入口捕获 + await 后复检，生成在途切书后死实例的
  // 迟到 toast/面板状态不再落到新书界面（旧书结果本就该作废）
  const book = props.bookName
  // R70-27（十八轮）：重新生成前脏检查——result 相位的手改内容（未保存）此前被
  // 无条件清空丢稿；与最近一次生成快照比对，有手改先确认
  if (content.value.trim() !== '' && content.value !== lastGenerated.value) {
    const okToRegen = await ui.ask({
      title: '重新生成',
      message: '当前内容有你未保存的修改，重新生成将覆盖——继续？',
      confirmText: '重新生成',
    })
    if (!okToRegen) return
  }
  phase.value = 'loading'
  err.value = null
  content.value = ''
  try {
    const r = await onboardAi(book, { step, premise: storyPremise.value })
    if (!stillOn(book)) return
    content.value = r.content
    lastGenerated.value = r.content
    lastWords.value = r.words
    phase.value = 'result'
    ui.toast(`${STEP_LABEL[step]} 生成（${r.words} 字）`, 'success')
  } catch (e) {
    if (!stillOn(book)) return
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
    phase.value = 'detail'
  }
}

async function save(): Promise<void> {
  if (saving.value) return // R35-34：函数级在途锁（按钮 disabled 之外的同拍双触发兜底）
  if (!active.value) return
  // M-4：入口捕获 + await 后复检——落盘在途切书后，死实例的 tree.load(旧书) 会把
  // 旧书目录写进共享 tree store（新书工作台显示旧书章节树）
  const book = props.bookName
  saving.value = true
  try {
    await onboardSave(book, { step: active.value, content: content.value })
    if (!stillOn(book)) return
    ui.toast('已保存', 'success')
    void tree.load(book)
  } catch (e) {
    if (!stillOn(book)) return // R64-34（十二轮）：切书后错误 toast 不落 B 书界面（对齐 gen() 的 catch）
    err.value = friendlyError(e)
    ui.toast(err.value, 'error')
  } finally {
    saving.value = false
  }
}

onMounted(async () => {
  // M-4：同 save——config/tree 加载在途切书后死实例放弃（新实例自会加载）
  const book = props.bookName
  try {
    const config = await getConfig(book)
    if (!stillOn(book)) return
    isShort.value = (config.kind ?? 'long') === 'short'
    const leadsEnabled = (config['leads'] as { enabled?: string[] } | undefined)?.enabled ?? []
    isGrowthBook.value = leadsEnabled.includes('成长线')
  } catch {
    // config 读取失败 → 默认显示 realm（不阻断）
  }
  if (!stillOn(book)) return
  await tree.load(book)
  const first = ALL_STEPS.value.find((s) => !isGenerated(s))
  if (first) selectStep(first)
})
</script>

<template>
  <div class="onboard">
    <div v-if="ui.aiAvailable === false" class="ai-warn">
      AI 服务暂不可用，请在设置中检查 AI 配置。
    </div>

    <!-- Hero（渐变头，与总览页同语言） -->
    <section class="ob-hero">
      <div class="hero-top">
        <div class="hero-left">
          <h1 class="hero-title">开书对话 <BetaBadge /></h1>
          <span class="hero-sub">分步 AI 生成设定 · 逐确认后保存</span>
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

    <!-- 故事梗概（作者设想，AI 据此开书） -->
    <OnboardPremise v-model="storyPremise" :book-name="bookName" />

    <!-- 主体两栏 -->
    <div class="ob-layout">
      <!-- 左栏：分组步骤列表 -->
      <OnboardStepRail
        :groups="visibleStepGroups"
        :active="active"
        :disabled="phase === 'loading'"
        @select="selectStep"
      />

      <!-- 右栏：详情 / 生成 / 编辑 -->
      <OnboardStepPanel
        v-model="content"
        :active="active"
        :phase="phase"
        :last-words="lastWords"
        :saving="saving"
        :err="err"
        @gen="gen"
        @save="save"
      />
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
  animation: clw-fade-up 0.5s var(--ease-out) both;
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

.ai-warn {
  padding: 8px 14px;
  font-size: var(--font-size-s);
  color: var(--text-warning);
  background: color-mix(in srgb, var(--text-warning) 10%, transparent);
  border-radius: var(--radius-m);
}
</style>
