<script setup lang="ts">
// 文风定标卡（StyleView 拆分 P2-5 ① 定标段）：检测标准 chips + 基准建立/重建 + 参考强度 + 铁律原文编辑。
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
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

// R28-25（二十八轮）：armed 门——书名守卫读 style.bookName 依赖 store.load 入口同步置位，
// 而路由变更 → StyleView :key 重建 → setup → onMounted 才 load 之间存在一个渲染 tick
// 窗口：窗口内 store.bookName 仍滞留旧书，死实例在途动作恰在该窗口 settle 时
// 「bookName 匹配」放行，A 书 toast 落 B 书界面。armed 以路由活书名为代次源即时判定
// （等价代次比对）：路由切书瞬间即变、且是全局响应式对象，死实例闭包读到的也是活值，
// 窗口期动作直接吞掉；store.bookName 匹配照旧保留（armed && bookName 双门）。
const route = useRoute()
function armed(book: string): boolean {
  return String(route.params.name ?? '') === book
}

function fmtDate(iso: string): string {
  return iso.slice(0, 10)
}
async function onFreeze(): Promise<void> {
  if (freezing.value) return
  // M-4（第八轮）：M-8 类收敛——await 前捕获书名，弹窗滞留跨窗切书后确认不落 B 书
  //（store 的 freeze() 在调用时刻读 bookName，此前空书名 400 或替换 B 书基准）
  const book = props.bookName
  const ok = await ui.ask({
    title: baseline.value ? '重新建立文风基准' : '建立文风基准',
    message: '以当前样章按场景重新提取你的文风特征，替换之前的基准。后续偏差检测将以新基准为准。',
    confirmText: '建立',
  })
  if (!ok) return
  // R28-25：armed 门 + 书名门（原 capture 改 props.bookName——与 saveRules 同源，store
  // 滞留窗口内捕获到旧书名会假性匹配）
  if (!armed(book) || style.bookName !== book) return // 弹窗期间已切书：中止
  freezing.value = true
  try {
    await style.freeze()
    if (!armed(book) || style.bookName !== book) return // R72-11（二十轮 E-6）：await 后切书，提示不落 B 书
    ui.toast('文风基准已建立', 'success')
  } catch (e) {
    // R26-69（二十六轮）：catch 补书名复检——成功路径（上方）有门，catch 漏配：
    // 建基准在途（特征提取可达数十秒）切书后，A 书的失败 toast 会弹在 B 书界面上
    if (!armed(book) || style.bookName !== book) return
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
  // R36-22（三十六轮）：await 前捕获书名（同文件 onFreeze/saveRules 的 M-4/R72-11 模式，
  // 与 R28-25 的 armed+bookName 双门同口径）——铁律读取在途切书后，旧书内容不得
  // 回填表单状态、失败 toast 不得落 B 书界面（原状态更新与 toast 均无复检）
  const book = props.bookName
  rulesMissing.value = false
  try {
    const r = await getContentRevisioned(props.bookName, RULES_PATH)
    if (!armed(book) || style.bookName !== book) return // R36-22：在途切书 → 不回填
    rulesText.value = r.content
    rulesOrig.value = r.content
    rulesBaseRev.value = r.revision
  } catch (e) {
    if (!armed(book) || style.bookName !== book) return // R36-22：在途切书 → 不 toast/不置缺失态
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
  // R26-70（二十六轮）：入口捕获书名 + await 后复检（对齐同文件 onFreeze 的 M-4/R72-11
  // 模式）——铁律保存在途切书后（StyleView :key 重建，本死实例 props 冻结在旧书），
  // A 书的保存结果 toast 与 style.load(旧书) 会落 B 书界面/把 A 书定标数据写进共享 store
  const book = props.bookName
  rulesSaving.value = true
  try {
    // dd-P3：去首次空写——putContent 本身可创建文件，空写多余
    rulesMissing.value = false
    const r = await putContent(book, RULES_PATH, rulesText.value, rulesBaseRev.value ?? undefined)
    if (!armed(book) || style.bookName !== book) return // 保存期间已切书：旧书结果不落地（R28-25：armed 门补 store 滞留窗口）
    rulesOrig.value = rulesText.value
    rulesBaseRev.value = r.revision
    ui.toast('文风铁律已保存', 'success')
    await style.load(book) // 阈值可能已改，重拉定标数据
    if (!armed(book) || style.bookName !== book) return // style.load 期间再切书（二次门，同 onAnalyze）
  } catch (e) {
    if (!armed(book) || style.bookName !== book) return // R26-70：切书后旧书失败提示不落 B 书界面（R28-25：含 store 滞留窗口）
    if (e instanceof ApiError && e.code === 'REVISION_CONFLICT') {
      // 双出路取「重载」：铁律是低频配置，重拉最新版让作者比对重写，比静默覆盖稳妥
      ui.toast('铁律已在其他窗口修改——已为你重新加载最新版，请比对后再保存', 'error')
      try {
        const remote = await getContentRevisioned(book, RULES_PATH)
        if (!armed(book) || style.bookName !== book) return // 重拉在途切书：旧书内容不回填死实例 UI
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
        <div class="sb-seg">
          <button class="sb-seg-btn" :class="{ on: injection === 'light' }" @click="onInjection('light')">轻</button>
          <button class="sb-seg-btn" :class="{ on: injection === 'heavy' }" @click="onInjection('heavy')">重</button>
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
  animation: clw-fade-up var(--dur-fast) var(--ease-out) both;
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
/* 与 settings-shared 全局 .seg 药丸同名异形，改名隔离防全局规则渗入 */
.sb-seg {
  display: inline-flex;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s);
  overflow: hidden;
}
.sb-seg-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  padding: 3px 14px;
  cursor: pointer;
}
.sb-seg-btn.on {
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

</style>
