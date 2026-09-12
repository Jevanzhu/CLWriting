<script setup lang="ts">
// F1-P5 审计视图：事件重放 + 遮蔽差异（模型可见 vs 人类可见）+ 工作流链路。
// 只读审计——展示「模型看到的 vs 人类看到的」差异，以及每本书的事件流与血缘引用。
// AA-P2-1：长书 >500 条事件分页续页——后端按 limit/offset 截断，前端「加载更多」累积追加
// 并显式提示「已显示 X / N」（此前无翻页入口，>500 条旧事件结构上永远不可见）。
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { ScrollText, EyeOff, GitBranch, RefreshCw, AlertCircle } from 'lucide-vue-next'
import { getAudit, clearAudit, type AuditConversationFE, type AuditEventFE, type GoalFE, type TodoFE } from '../api/audit'
import { friendlyError } from '../shared/error'
import AuditDiffPanel from '../components/audit/AuditDiffPanel.vue'
import AuditGoalTodoPanel from '../components/audit/AuditGoalTodoPanel.vue'
// R0911b-C2-P3-1：对话/工作流两段事件列表模板近复制（行 + 空态 + 分页/截断行），
// 抽 AuditEventList 子组件两处以 props/事件消费（纯结构去重零行为变更）
import AuditEventList from '../components/audit/AuditEventList.vue'

const props = defineProps<{ bookName: string }>()

const loading = ref(true)
const err = ref<string | null>(null)
/** 对话审计头部（投影/遮蔽差异；每页响应同源——foldSurface 全量计算，各页一致） */
const conversation = ref<AuditConversationFE | null>(null)
/** 累积的对话事件（跨页追加，按 seq 去重） */
const convoEvents = ref<AuditEventFE[]>([])
const convoTotal = ref(0)
const convoLoadingMore = ref(false)
/** 已载条数（= 下页 offset 起点） */
const convoOffset = ref(0)
/** 累积的工作流事件 */
const workflowEvents = ref<AuditEventFE[]>([])
const workflowTotal = ref(0)
const workflowLoadingMore = ref(false)
const workflowOffset = ref(0)
const goals = ref<GoalFE[]>([])
const todos = ref<TodoFE[]>([])
/** 事件重放展开的 seq 集合（点开看 data / 血缘）；load/doClear 重置——重取后旧展开态不残留 */
const expanded = ref<Set<number>>(new Set())
/** 工作流 tab：'convo' | 'workflow' */
const tab = ref<'convo' | 'workflow'>('convo')

/** 每页上限（与服务端 DEFAULT_PAGE_LIMIT 对齐） */
const PAGE_LIMIT = 500

/** 渲染累积上限（ii-2）：「加载更多」跨页无界累积会让 DOM 线性膨胀（content-visibility
 *  只省绘制不省节点）；到顶停载并提示——完整数据仍在事件库，可清史/换库后再查。 */
const RENDER_CAP = 2000

const hasMoreConvo = computed(() => convoEvents.value.length < convoTotal.value && convoEvents.value.length < RENDER_CAP)
const hasMoreWorkflow = computed(() => workflowEvents.value.length < workflowTotal.value && workflowEvents.value.length < RENDER_CAP)
const convoCapHit = computed(() => !hasMoreConvo.value && convoEvents.value.length >= RENDER_CAP && convoEvents.value.length < convoTotal.value)
const workflowCapHit = computed(() => !hasMoreWorkflow.value && workflowEvents.value.length >= RENDER_CAP && workflowEvents.value.length < workflowTotal.value)

// R36-25（三十六轮）：script 层代守卫——load/loadMore 的 await 回调当前被模板禁用态
// （:disabled="loading"）封死（刷新在途时按钮不可点），但禁用态只是 UI 耦合；实例卸载
// 后迟到的响应仍会回写 refs。置 unmounted 标记，异步回调落点前复检吞掉（对将来
// 模板移除禁用态/新增自动刷新均不失守）。
let alive = true
onUnmounted(() => {
  alive = false
})

// R48-23（四十八轮）：共享代数守卫（库内 loadGen 惯例）——「加载更多」在途时点「刷新」，
// load() 清列表归零 offset，迟到续页此前按旧 offset push 进已重置列表且 offset 漂移
//（原注释自称不失守恰恰失守：alive 只护卸载不护刷新）。续页开工时拍代数，回写前
// 复核；load 开工递增代数使全部在途续页作废。
let loadGen = 0

async function load(): Promise<void> {
  const gen = ++loadGen
  loading.value = true
  err.value = null
  conversation.value = null
  convoEvents.value = []
  convoTotal.value = 0
  convoOffset.value = 0
  workflowEvents.value = []
  workflowTotal.value = 0
  workflowOffset.value = 0
  goals.value = []
  todos.value = []
  expanded.value = new Set()
  // R0912-FE-P3-11（mac 线）：「放行全量 JSON」集合原在此随 load 清空；并合后懒展开状态
  // 随 AuditEventList 子组件持有，子组件 watch events 数组换代即复位（load 换新数组、
  // loadMore 原地 push——语义与原父侧 clear 等价），此处不再直清。
  try {
    const v = await getAudit(props.bookName, { limit: PAGE_LIMIT, offset: 0 })
    if (!alive || gen !== loadGen) return // R36-25：卸载后迟到响应不回写；R48-23：被更新刷新作废
    conversation.value = v.conversation
    convoEvents.value = v.conversation?.events ?? []
    convoTotal.value = v.conversation?.eventsTotal ?? 0
    convoOffset.value = convoEvents.value.length
    workflowEvents.value = v.workflowEvents ?? []
    workflowTotal.value = v.workflowTotal ?? 0
    workflowOffset.value = workflowEvents.value.length
    goals.value = v.goals ?? []
    todos.value = v.todos ?? []
  } catch (e) {
    if (!alive || gen !== loadGen) return // R36-25
    err.value = friendlyError(e)
  } finally {
    if (!alive || gen !== loadGen) return // R36-25：卸载后不再回写 loading
    loading.value = false
  }
}

/** 追加下一页对话事件（offset = 已载条数；seq 去重防 sync/重复请求混入） */
async function loadMoreConvo(): Promise<void> {
  if (convoLoadingMore.value || !hasMoreConvo.value) return
  const gen = loadGen // R48-23：拍代数——开工后发生刷新则本页作废
  convoLoadingMore.value = true
  err.value = null
  try {
    const v = await getAudit(props.bookName, { limit: PAGE_LIMIT, offset: convoOffset.value })
    if (!alive) return // R36-25：卸载后迟到续页不回写
    if (gen !== loadGen) return // R48-23：刷新已重置列表，旧 offset 续页不得拼入
    if (conversation.value === null) conversation.value = v.conversation
    const seen = new Set(convoEvents.value.map((e) => e.seq))
    const fresh = (v.conversation?.events ?? []).filter((e) => !seen.has(e.seq))
    // R62-50：整页撞重复（sync/重复请求混入整页全被去重）→ fresh 空但页非空——offset 若
    // 仍按已载条数算会原地空转（每轮拉同页）。页非空即按服务端返回条数推进，跳过重复段。
    const pageLen = v.conversation?.events.length ?? 0
    convoEvents.value.push(...fresh)
    convoOffset.value += fresh.length > 0 ? fresh.length : pageLen
  } catch (e) {
    // R57-F-1（五十七轮）：catch 补上方成功路径同款代数复检——续页在途时点刷新，
    // load() 递增代数并清列表后，迟到失败此前仍会把错误态（err 回写）写到已被
    // 新刷新取代的视图上（新代成功数据顶着旧错误横幅）。
    if (!alive || gen !== loadGen) return // R36-25：卸载后不回写；R48-23：被刷新作废的续页不得置错
    err.value = friendlyError(e)
  } finally {
    convoLoadingMore.value = false
  }
}

/** 追加下一页工作流事件（对称实现；长自愈批的链路事件也可能超 500） */
async function loadMoreWorkflow(): Promise<void> {
  if (workflowLoadingMore.value || !hasMoreWorkflow.value) return
  const gen = loadGen // R48-23：同 convo——开工后发生刷新则本页作废
  workflowLoadingMore.value = true
  err.value = null
  try {
    const v = await getAudit(props.bookName, { limit: PAGE_LIMIT, offset: workflowOffset.value })
    if (!alive) return // R36-25：卸载后迟到续页不回写
    if (gen !== loadGen) return // R48-23：刷新已重置列表，旧 offset 续页不得拼入
    const seen = new Set(workflowEvents.value.map((e) => e.seq))
    const fresh = (v.workflowEvents ?? []).filter((e) => !seen.has(e.seq))
    // R62-50：同 convo——整页撞重复时 fresh 空、页非空，按返回条数强制推进防空转。
    const pageLen = v.workflowEvents?.length ?? 0
    workflowEvents.value.push(...fresh)
    workflowOffset.value += fresh.length > 0 ? fresh.length : pageLen
  } catch (e) {
    // R57-F-1（五十七轮）：同 loadMoreConvo——catch 补代数复检，被刷新作废的续页
    // 迟到失败不把错误态回写到新代视图。
    if (!alive || gen !== loadGen) return // R36-25：卸载后不回写；R48-23：被刷新作废的续页不得置错
    err.value = friendlyError(e)
  } finally {
    workflowLoadingMore.value = false
  }
}

onMounted(load)

function toggle(seq: number): void {
  const s = new Set(expanded.value)
  if (s.has(seq)) s.delete(seq)
  else s.add(seq)
  expanded.value = s
}

// R0911b-C2-P3-1：typeLabel/dataSummary/事件行渲染随模板迁 AuditEventList.vue；
// R0912-FE-P3-11（mac 线，merge 2026-09-12 并入）：事件 data JSON 懒展开同样下沉子组件
// （展开态 pre 渲染在子组件行模板内），父视图不再持有相关状态。

// ── 事件保留定版（2026-08-16 拍板：全量保留 + 手动清理）──────────────
// 事件史默认 append-only 全量保留；此处是每书唯一清理入口，两步确认（销毁不可撤销）。
const clearing = ref(false)
const confirmClear = ref(false)

async function doClear(): Promise<void> {
  if (clearing.value) return
  clearing.value = true
  err.value = null
  const gen = loadGen // 重评2-P3-6：入口拍代数（loadMoreConvo R48-23 同款——开工后发生刷新则本操作作废）
  try {
    await clearAudit(props.bookName)
    confirmClear.value = false
    await load()
  } catch (e) {
    // 重评2-P3-6（2026-09-09 全量重评 GLM-5.3）：catch 补存活/代数复检（R57-F-1 先例同款）
    // ——清除在途时卸载/点刷新，迟到失败此前仍会把错误态写到已卸载实例或已被新刷新
    // 取代的新代视图上（旧错误横幅顶在新数据上）。
    if (!alive || gen !== loadGen) return // R36-25：卸载后不回写；R48-23：被刷新作废的清除不得置错
    err.value = friendlyError(e)
  } finally {
    // 只守存活不守代数：clearing 仅由本操作持有，代数作废分支若不复位会把「确认清除」
    // 按钮永久吊在禁用态（对照 loading 由取代方 load() 自己接管收尾，两处口径并不相同）
    if (alive) clearing.value = false
  }
}
</script>

<template>
  <div class="audit-scroll">
    <header class="audit-head">
      <div class="head-left">
        <h1 class="audit-title">事件审计</h1>
        <span v-if="conversation" class="shadow-hint">
          <EyeOff :size="13" /> 遮蔽 {{ conversation.shadowedCount }} · 可见
          {{ conversation.modelVisible.length }} / 人类 {{ conversation.humanVisible.length }}
        </span>
        <span v-else-if="!loading && !err" class="shadow-hint">本库尚无对话事件</span>
      </div>
      <div class="head-actions">
        <!-- 事件保留定版：每书事件史清理入口（两步确认——销毁不可撤销） -->
        <button v-if="!confirmClear" class="reload-btn danger" :disabled="loading || clearing" @click="confirmClear = true">
          清除事件史…
        </button>
        <template v-else>
          <span class="clear-hint">清除本书全部事件（对话+工作流），不可撤销？</span>
          <button class="reload-btn danger" :disabled="clearing" @click="doClear">{{ clearing ? '清除中…' : '确认清除' }}</button>
          <button class="reload-btn" :disabled="clearing" @click="confirmClear = false">取消</button>
        </template>
        <button class="reload-btn" :disabled="loading" @click="load">
          <RefreshCw :size="14" :class="{ spin: loading }" /> 刷新
        </button>
      </div>
    </header>

    <p v-if="err" class="audit-err"><AlertCircle :size="14" /> {{ err }}</p>

    <template v-if="!loading">
      <!-- tab 切换 -->
      <div class="tabbar">
        <button :class="{ on: tab === 'convo' }" @click="tab = 'convo'">
          <ScrollText :size="14" /> 对话审计
          <span v-if="convoTotal > 0" class="tab-total">{{ convoEvents.length }}/{{ convoTotal }}</span>
        </button>
        <button :class="{ on: tab === 'workflow' }" @click="tab = 'workflow'">
          <GitBranch :size="14" /> 工作流链路（{{ workflowEvents.length }}{{ hasMoreWorkflow ? '/' + workflowTotal : '' }}）
        </button>
      </div>

      <!-- 对话审计：重放 + 遮蔽差异 -->
      <template v-if="tab === 'convo'">
        <template v-if="conversation">
          <!-- 遮蔽差异：模型可见 vs 人类可见 对照 -->
          <AuditDiffPanel :conversation="conversation" />

          <!-- 事件重放（分页累积，含遮蔽标记 + 血缘） -->
          <section class="sec">
            <h2 class="sec-title">事件重放（{{ convoEvents.length }}{{ hasMoreConvo ? ' / 共 ' + convoTotal : '' }}）</h2>
            <!-- R0911b-C2-P3-1：行模板/空态/分页截断行抽 AuditEventList（detailed=对话段专有：遮蔽/血缘列）。
                 R0912-FE-P3-11（mac 线，merge 2026-09-12 并入）：事件 JSON 懒展开随行模板在子组件内生效 -->
            <AuditEventList
              :events="convoEvents"
              :total="convoTotal"
              :loading-more="convoLoadingMore"
              :has-more="hasMoreConvo"
              :cap-hit="convoCapHit"
              :render-cap="RENDER_CAP"
              :expanded="expanded"
              empty-text="暂无事件"
              detailed
              cap-hint-suffix="——更早日志仍在事件库，可清除本库事件史后重查"
              @toggle="toggle"
              @load-more="loadMoreConvo"
            />
          </section>
        </template>
        <!-- R0912-3 #18：加载失败后不再渲染「本库尚无对话事件」空态文案（与上方错误
             横幅同屏自相矛盾；头部 shadow-hint :211 同款 !err 守卫先例） -->
        <div v-else-if="!err" class="empty big">本库尚无对话事件（先发一条对话消息）</div>
      </template>

      <!-- 工作流链路 -->
      <template v-else>
        <!-- F5：当前目标 / 任务清单（goal/todo 重放快照） -->
        <AuditGoalTodoPanel :goals="goals" :todos="todos" />

        <!-- R0912-3 #18：同上——加载失败后不渲染「暂无工作流事件」空态与 (0) 标题；
             有数据时（续页失败/清除失败）仍照常渲染，错误只走横幅 -->
        <section v-if="!err || workflowEvents.length > 0" class="sec">
          <h2 class="sec-title">工作流事件（{{ workflowEvents.length }}{{ hasMoreWorkflow ? ' / 共 ' + workflowTotal : '' }}）</h2>
          <!-- R0911b-C2-P3-1：同上——工作流段无遮蔽/血缘列（不传 detailed），文案以 props 区分；
               R0912-FE-P3-11 懒展开同随子组件生效 -->
          <AuditEventList
            :events="workflowEvents"
            :total="workflowTotal"
            :loading-more="workflowLoadingMore"
            :has-more="hasMoreWorkflow"
            :cap-hit="workflowCapHit"
            :render-cap="RENDER_CAP"
            :expanded="expanded"
            empty-text="暂无工作流事件（运行一次 AI 写作后可见）"
            @toggle="toggle"
            @load-more="loadMoreWorkflow"
          />
        </section>
      </template>
    </template>

    <div v-else-if="loading" class="empty big">加载中…</div>
  </div>
</template>

<style scoped>
/* 变量纪律：只引 tokens.css 既有 token（此前 --text-dim/--bg-elev/--border/--bg/--text
 * 等短名变量全库无定义，静默回退 initial——已按语义映射到 Obsidian 命名体系）。
 * R42-27（四十二轮）：style 段硬编码 rem 字号全部就近映射 UI 字号档（tokens.css
 * --font-size-*）——≤0.75rem→xs、0.76-0.85rem→s、0.86-1.0rem→m、>1.0rem→l
 * （1.35rem 标题→l）；只换字号变量，间距/圆角等布局度量不动。 */
.audit-scroll {
  max-width: 980px;
  margin: 0 auto;
  padding: var(--size-4-4) var(--size-4-4) var(--size-4-6);
}
.audit-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--size-4-4);
  flex-wrap: wrap;
  gap: var(--size-4-3);
}
.head-left {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  flex-wrap: wrap;
}
.audit-title {
  font-size: var(--font-size-l);
  margin: 0;
}
.shadow-hint {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  font-size: var(--font-size-s);
}
.reload-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 7px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-normal);
  cursor: pointer;
  font-size: var(--font-size-s);
}
.reload-btn:disabled { opacity: 0.5; cursor: default; }
.head-actions {
  display: inline-flex;
  align-items: center;
  gap: var(--size-4-2);
  flex-wrap: wrap;
}
/* 事件保留定版：销毁动作红色 + 确认提示 */
.reload-btn.danger { color: var(--text-error); border-color: var(--text-error); }
.clear-hint {
  color: var(--text-error);
  font-size: var(--font-size-s);
}
.spin { animation: clw-spin 0.8s linear infinite; }

.audit-err {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-error);
  margin-bottom: var(--size-4-3);
}
.tabbar {
  display: flex;
  gap: 6px;
  margin-bottom: var(--size-4-4);
}
.tabbar button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--background-modifier-border);
  background: var(--background-secondary);
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--font-size-s);
}
.tabbar button.on {
  background: var(--interactive-accent);
  color: var(--text-on-accent);
}
.tab-total {
  margin-left: 5px;
  font-size: var(--font-size-xs);
  opacity: 0.85;
}
.sec { margin-bottom: var(--size-4-5); }
.sec-title {
  display: flex;
  align-items: center;
  gap: var(--size-4-3);
  font-size: var(--font-size-m);
  margin: 0 0 var(--size-4-3);
  flex-wrap: wrap;
}
/* R0911b-C2-P3-1：ev-list/ev-row/pager 等事件列表样式随模板迁 AuditEventList.vue
 * （scoped 隔离，子组件同名类不与本视图互相泄漏）；.empty/.empty.big 本视图仍用，保留。
 * R0912-FE-P3-11（mac 线，merge 2026-09-12 并入）：.ev-full-btn 放行钮样式随懒展开逻辑
 * 同迁子组件。 */
.empty { color: var(--text-muted); font-size: var(--font-size-s); padding: 8px; }
.empty.big { padding: 40px; text-align: center; }
</style>
