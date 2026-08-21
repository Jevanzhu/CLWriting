<script setup lang="ts">
// 文风定标卡（StyleView 拆分 P2-5 ① 定标段）：检测标准 chips + 基准建立/重建 + 参考强度 + 铁律原文编辑。
import { computed, ref } from 'vue'
import { SlidersHorizontal, Snowflake } from 'lucide-vue-next'
import { useStyleStore } from '../../stores/style'
import { usePrefsStore } from '../../stores/prefs'
import { useUiStore } from '../../stores/ui'
import { getContentRevisioned, putContent } from '../../api/documents'
import { ApiError } from '../../api/client'
import { friendlyError } from '../../shared/error'
import BetaBadge from '../ui/BetaBadge.vue'

const props = defineProps<{ bookName: string }>()
const style = useStyleStore()
const ui = useUiStore()
// 文风注入强度 2026-08-19 起只走全局：与设置「AI 写作」页同源（prefs store），不再写书级
const prefs = usePrefsStore()

const rules = computed(() => style.config?.rules ?? {})
const baseline = computed(() => style.config?.baseline ?? null)
const freezing = ref(false)

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}
async function onFreeze(): Promise<void> {
  if (freezing.value) return
  // M-4（第八轮）：M-8 类收敛——await 前捕获书名，弹窗滞留跨窗切书后确认不落 B 书
  //（store 的 freeze() 在调用时刻读 bookName，此前空书名 400 或替换 B 书基准）
  const book = style.bookName
  const ok = await ui.ask({
    title: baseline.value ? '重新建立文风基准' : '建立文风基准',
    message: '以当前样章按场景重新提取你的文风特征，替换之前的基准。后续偏差检测将以新基准为准。',
    confirmText: '建立',
  })
  if (!ok) return
  if (style.bookName !== book) return // 弹窗期间已切书：中止
  freezing.value = true
  try {
    await style.freeze()
    ui.toast('文风基准已建立', 'success')
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  } finally {
    freezing.value = false
  }
}

// 注入强度：只走全局（prefs store），与设置「AI 写作」页同源——文风页和设置页显示同一值。
// 2026-08-19 决策：砍掉书级覆盖，一律跟随 global.json styleInjection。
const injection = computed(() => prefs.styleInjection)
async function onInjection(v: 'light' | 'heavy'): Promise<void> {
  if (injection.value === v) return
  prefs.setStyleInjection(v)
  ui.toast('参考强度已保存', 'success')
}

// 铁律原文编辑（文风/文风铁律.md 纯配置；折叠展开，保存后重拉阈值）
const RULES_PATH = '文风/文风铁律.md'
const editingRules = ref(false)
const rulesText = ref('')
const rulesOrig = ref('')
// M-3（第六轮）：读时取走字节指纹、存时回传——双窗口并发编辑铁律不再静默后写覆盖先写
const rulesBaseRev = ref<string | null>(null)
const rulesMissing = ref(false)
const rulesSaving = ref(false)
const rulesDirty = computed(() => rulesText.value !== rulesOrig.value)
async function toggleRulesEdit(): Promise<void> {
  if (editingRules.value) {
    editingRules.value = false
    return
  }
  rulesMissing.value = false
  try {
    const r = await getContentRevisioned(props.bookName, RULES_PATH)
    rulesText.value = r.content
    rulesOrig.value = r.content
    rulesBaseRev.value = r.revision
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      rulesMissing.value = true
      rulesText.value = ''
      rulesOrig.value = ''
      rulesBaseRev.value = null
    } else {
      ui.toast(friendlyError(e), 'error')
      return
    }
  }
  editingRules.value = true
}
async function saveRules(): Promise<void> {
  if (rulesSaving.value) return
  rulesSaving.value = true
  try {
    // dd-P3：去首次空写——putContent 本身可创建文件，空写多余
    rulesMissing.value = false
    const r = await putContent(props.bookName, RULES_PATH, rulesText.value, rulesBaseRev.value ?? undefined)
    rulesOrig.value = rulesText.value
    rulesBaseRev.value = r.revision
    ui.toast('文风铁律已保存', 'success')
    await style.load(props.bookName) // 阈值可能已改，重拉定标数据
  } catch (e) {
    if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
      // 双出路取「重载」：铁律是低频配置，重拉最新版让作者比对重写，比静默覆盖稳妥
      ui.toast('铁律已在其他窗口修改——已为你重新加载最新版，请比对后再保存', 'error')
      try {
        const remote = await getContentRevisioned(props.bookName, RULES_PATH)
        rulesText.value = remote.content
        rulesOrig.value = remote.content
        rulesBaseRev.value = remote.revision
      } catch {
        /* 重拉失败保留本地编辑，作者可再试 */
      }
    } else {
      ui.toast(friendlyError(e), 'error')
    }
  } finally {
    rulesSaving.value = false
  }
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <SlidersHorizontal :size="14" /> <span>定标 <BetaBadge /></span>
      <span class="head-note">检测标准与参考方式</span>
    </div>
    <div class="anchor-body">
      <div class="anchor-chips">
        <span class="a-chip">单句 ≤{{ rules.maxSentenceLen ?? '—' }} 字</span>
        <span class="a-chip">形容词堆叠 ≤{{ rules.maxAdjStack ?? '—' }}</span>
        <span class="a-chip">
          对话标签 ≤{{ rules.maxDialogueTagRatio !== undefined ? Math.round(rules.maxDialogueTagRatio * 100) + '%' : '—' }}
        </span>
        <span class="a-chip">排比连续 ≤{{ rules.maxParallelStreak ?? '—' }}</span>
        <span class="a-chip">结尾总结体 {{ rules.avoidSummaryEnding ? '避免' : '不检' }}</span>
      </div>
      <div class="anchor-line">
        <Snowflake :size="13" class="al-icon" />
        <template v-if="baseline">
          <span>文风基准建立于 {{ fmtDate(baseline.frozenAt) }} · 覆盖{{ baseline.scenes.length }}个场景</span>
          <button class="btn-ghost" :disabled="freezing" @click="onFreeze">重新建立</button>
        </template>
        <template v-else>
          <span class="al-faint">尚未建立文风基准——偏差检测暂无对照，收录样章后即可建立</span>
          <button class="btn-ghost" :disabled="freezing || style.kindCounts['样章'] === 0" @click="onFreeze">
            建立基准
          </button>
        </template>
      </div>
      <div class="anchor-line">
        <span class="al-label">参考强度</span>
        <div class="seg">
          <button class="seg-btn" :class="{ on: injection === 'light' }" @click="onInjection('light')">轻</button>
          <button class="seg-btn" :class="{ on: injection === 'heavy' }" @click="onInjection('heavy')">重</button>
        </div>
        <span class="al-faint">{{ injection === 'light' ? '每章带入1段样章参考' : '每章带入3段样章参考' }}</span>
        <button class="btn-ghost rules-toggle" @click="toggleRulesEdit">
          {{ editingRules ? '收起铁律原文' : '编辑铁律原文' }}
        </button>
      </div>
      <div v-if="editingRules" class="rules-edit">
        <textarea
          v-model="rulesText"
          class="rules-textarea"
          rows="12"
          spellcheck="false"
          :placeholder="rulesMissing ? '尚无铁律——留空新建。检测标准、删除分级等规则配置。' : ''"
        ></textarea>
        <div class="af-actions">
          <span v-if="rulesDirty" class="al-faint">未保存</span>
          <button class="btn-primary" :disabled="rulesSaving || !rulesDirty" @click="saveRules">
            {{ rulesSaving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* ══ 面板基础（对齐 OverviewView 卡片语言）══ */
.panel {
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  padding: 18px 20px;
  animation: fade-up var(--dur-fast) var(--ease-out) both;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-s);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 14px;
}
.panel-head svg {
  opacity: 0.5;
  flex-shrink: 0;
}
.head-note {
  font-weight: 400;
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ══ 通用按钮 ══ */
.btn-ghost,
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  padding: 4px 10px;
  border-radius: var(--radius-s);
  cursor: pointer;
  border: 1px solid var(--background-modifier-border);
  background: transparent;
  color: var(--text-muted);
  white-space: nowrap;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.btn-primary {
  border-color: transparent;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--interactive-accent-hover);
}
.btn-ghost:disabled,
.btn-primary:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ══ ① 定标 ══ */
.anchor-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.anchor-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.a-chip {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  padding: 3px 10px;
}
.anchor-line {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--font-size-s);
  color: var(--text-normal);
}
.al-icon {
  color: var(--text-faint);
  flex-shrink: 0;
}
.al-label {
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.al-faint {
  font-size: var(--font-size-xs);
  color: var(--text-faint);
}
.seg {
  display: inline-flex;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  overflow: hidden;
}
.seg-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  padding: 3px 14px;
  cursor: pointer;
}
.seg-btn.on {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.rules-toggle {
  margin-left: auto;
}
.rules-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rules-textarea {
  width: 100%;
  resize: vertical;
  padding: 10px 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--text-normal);
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  outline: none;
}
.rules-textarea:focus {
  border-color: var(--interactive-accent);
}
.af-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

@keyframes fade-up {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
