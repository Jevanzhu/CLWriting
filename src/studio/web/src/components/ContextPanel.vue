<script setup lang="ts">
// 编辑态右栏：当前文件上下文（对齐 mockup renderEditRight，按文件类型分支照搬结构）。
// 篇文件：getPiece 富数据（本篇/情绪曲线/反转线索/伏笔提醒）；
// 章文件：字数 + 当前章相关账本提醒（getLeads）；scene/pov/hook 等无 API 的 kv 不画（避免空占位）。
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { getPiece, getLeads, getConfig } from '../api/books'
import type { PieceDetailData, LeadsData, Lead } from '../types'

const route = useRoute()
const router = useRouter()
const file = computed(() => (typeof route.query.file === 'string' ? route.query.file : ''))
const bookName = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const enc = computed(() => (bookName.value ? encodeURIComponent(bookName.value) : ''))

/** 文件类型（决定渲染哪套右栏结构）。按真实 EDIT_DIRS 路径前缀判断：
 *  定稿/正文/ → chapter（长篇）或 piece（短篇 spN/篇N）；定稿/设定/ → setting；大纲/ → outline */
const fileType = computed<'piece' | 'chapter' | 'doc'>(() => {
  const p = file.value
  if (!p) return 'doc'
  if (/sp\d/i.test(p) || /篇[\\/]\d/.test(p)) return 'piece'
  if (/定稿[\/\\]正文[\/\\]/.test(p)) return 'chapter'
  return 'doc'
})

const pieceNo = computed(() => {
  const m = file.value.match(/sp(\d+)/i) ?? file.value.match(/篇[\\/](\d+)/)
  return m ? Number(m[1]) : 0
})

const piece = ref<PieceDetailData | null>(null)
const words = ref(0)
const targetWords = ref(0)
const loading = ref(false)
const leads = ref<LeadsData | null>(null)

// 章元数据 + 出场角色：core 补 chapterMeta API 后填充（暂空，模板用 || '—' 降级）
const chapterMeta = ref<{ 场景?: string; 视角?: string; 钩子?: string; 情绪?: string }>({})
const chapterRoles = ref<{ 名字: string; 角色: string; cls?: 'cyan' | 'ochre' | '' }[]>([])
// 设定元数据 + 人物关系：core 补 settingMeta API 后填充
const settingMeta = ref<{ 出场章节?: number; 账本引用?: number }>({})
const settingRelations = ref<{ 名字: string; 关系: string; cls?: 'cyan' | '' }[]>([])
// 大纲统计：core 补 outlineMeta API 后填充
const outlineMeta = ref<{ 结构?: string; 预计章节?: number; 已写?: number; 总章节?: number; 进度?: number }>({})

async function loadPiece(): Promise<void> {
  if (!bookName.value || !pieceNo.value) {
    piece.value = null
    return
  }
  try {
    piece.value = await getPiece(bookName.value, pieceNo.value)
  } catch {
    piece.value = null
  }
}

async function loadWords(): Promise<void> {
  if (!file.value || !enc.value) {
    words.value = 0
    return
  }
  loading.value = true
  try {
    const r = await fetch(`/api/books/${enc.value}/file?file=${encodeURIComponent(file.value)}`)
    if (r.ok) {
      const d = (await r.json()) as { content?: string }
      words.value = String(d.content ?? '').replace(/\s+/g, '').length
    } else {
      words.value = 0
    }
  } catch {
    words.value = 0
  } finally {
    loading.value = false
  }
}

async function loadLeads(): Promise<void> {
  if (!bookName.value) {
    leads.value = null
    return
  }
  try {
    leads.value = await getLeads(bookName.value)
  } catch {
    leads.value = null
  }
}

/** 篇：伏笔回收统计 + 情绪曲线 */
const pieceRecv = computed(() =>
  piece.value ? piece.value.list.伏笔回收.filter((e) => !e.未回收).length : 0,
)
const piecePayoffs = computed(() => (piece.value?.list.伏笔回收 ?? []).slice(0, 3))
const pieceEmo = computed(() => piece.value?.list.情绪曲线 ?? [])

/** 章：当前章相关账本提醒（开启章或履历命中当前章；无则取前 3） */
const chapterLeads = computed<Lead[]>(() => {
  if (!leads.value || leads.value.kind !== 'long') return []
  const chNo = Number(file.value.match(/ch(\d+)/i)?.[1] ?? 0)
  const all = leads.value.leads ?? []
  const rel = chNo ? all.filter((l) => l.开启章 === chNo || l.履历?.some((e) => e.章号 === chNo)) : []
  return (rel.length ? rel : all).slice(0, 3)
})

async function loadConfig(): Promise<void> {
  if (!bookName.value) return
  try {
    const cfg = await getConfig(bookName.value)
    targetWords.value = Number(cfg.book?.target_words) || 0
  } catch {
    targetWords.value = 0
  }
}

/** 字数进度（vs 全书 target_words；对齐 mockup renderEditRight .progress） */
const piecePct = computed(() =>
  piece.value && targetWords.value > 0 ? Math.min(Math.round((piece.value.meta.字数 / targetWords.value) * 100), 100) : 0,
)
const chapterPct = computed(() =>
  targetWords.value > 0 ? Math.min(Math.round((words.value / targetWords.value) * 100), 100) : 0,
)

function gotoPiece(): void {
  if (pieceNo.value) router.push(`/books/${enc.value}/piece/${pieceNo.value}`)
}
function gotoLeads(): void {
  router.push(`/books/${enc.value}/leads`)
}

watch(
  [file, bookName],
  () => {
    piece.value = null
    leads.value = null
    if (fileType.value === 'piece') {
      void loadPiece()
    } else {
      void loadWords()
      if (fileType.value === 'chapter') void loadLeads()
    }
    void loadConfig()
  },
  { immediate: true },
)
</script>

<template>
  <!-- 篇文件：本篇 + 情绪曲线 + 反转线索 + 伏笔提醒（数据源 getPiece，全真实） -->
  <template v-if="fileType === 'piece' && piece">
    <div class="card">
      <div class="card-title">
        本篇 <span style="color: var(--ink-cyan)">● {{ targetWords && piece.meta.字数 >= targetWords ? '达标' : '草稿' }}</span>
      </div>
      <div class="kv"><span class="k">字数</span><span class="v">{{ piece.meta.字数.toLocaleString() }}</span></div>
      <div class="progress"><div :style="{ width: piecePct + '%' }"></div></div>
      <div class="kv"><span class="k">目标</span><span class="v">{{ targetWords ? targetWords.toLocaleString() + ' · ' + piecePct + '%' : '—' }}</span></div>
      <div class="kv"><span class="k">目标情绪</span><span class="v cyan">{{ piece.meta.目标情绪 || '—' }}</span></div>
      <div class="kv"><span class="k">核心反转</span><span class="v">{{ piece.meta.核心反转 || '—' }}</span></div>
      <div class="kv"><span class="k">伏笔回收</span><span class="v">{{ pieceRecv }}/{{ piece.list.伏笔回收.length }}</span></div>
    </div>

    <div v-if="pieceEmo.length" class="card">
      <div class="card-title">情绪曲线</div>
      <!-- mockup 顶部情绪流：emo.map(e=>e[0]).join(' → ')，展示情绪流转顺序 -->
      <div class="emo-flow" style="font-size: 12px; color: var(--text-2); margin-bottom: 8px">
        {{ pieceEmo.map((e) => e.情绪).join(' → ') }}
      </div>
      <div class="emo-bars">
        <div
          v-for="(e, i) in pieceEmo"
          :key="i"
          class="emo-bar"
          :style="{ height: Math.max(e.强度 * 10, 6) + '%', background: e.强度 >= 8 ? 'var(--cinnabar)' : 'var(--ink-cyan)' }"
          :title="`${e.情绪} ${e.强度}/10`"
        ></div>
      </div>
      <div class="emo-labels"><span v-for="(e, i) in pieceEmo" :key="i">{{ e.情绪.slice(0, 2) }}</span></div>
    </div>

    <div class="card">
      <div class="card-title">反转线索</div>
      <div class="reversal-text">{{ piece.list.反转线索表.核心反转 || '（待补）' }}</div>
      <div class="btn-row">
        <button class="btn primary" style="font-size: 11px; padding: 4px 10px" @click="gotoPiece">看篇详情 →</button>
      </div>
    </div>

    <div v-if="piecePayoffs.length" class="card">
      <div class="card-title">伏笔提醒 <span style="color: var(--text-3)">{{ piecePayoffs.length }}</span></div>
      <div v-for="(e, i) in piecePayoffs" :key="i" class="ledger-item click" @click="gotoLeads">
        <span class="dot" :class="e.未回收 ? 'red' : 'green'"></span>
        <div>
          <b>{{ e.伏笔 }}</b>
          <div class="desc">{{ e.未回收 ? '未回收' : `回收于 ${e.回收位置}` }}</div>
        </div>
      </div>
    </div>
  </template>

  <!-- 章文件：本章（场景/视角/钩子/情绪 kv）+ 账本提醒 + 出场角色（对齐 mockup renderEditRight 章分支） -->
  <template v-else-if="fileType === 'chapter'">
    <div class="card">
      <div class="card-title">本章 <span style="color: var(--ink-cyan)">● 草稿</span></div>
      <div class="kv"><span class="k">字数</span><span class="v">{{ loading ? '…' : words.toLocaleString() }}</span></div>
      <div class="progress"><div :style="{ width: chapterPct + '%' }"></div></div>
      <div class="kv"><span class="k">目标</span><span class="v">{{ targetWords ? targetWords.toLocaleString() + ' · ' + chapterPct + '%' : '—' }}</span></div>
      <!-- 场景 / 视角 / 钩子 / 情绪：core 补 chapterMeta 后填真实值，暂降级 — -->
      <div class="kv"><span class="k">场景</span><span class="v cyan">{{ chapterMeta.场景 || '—' }}</span></div>
      <div class="kv"><span class="k">视角</span><span class="v">{{ chapterMeta.视角 || '—' }}</span></div>
      <div class="kv"><span class="k">钩子</span><span class="v">{{ chapterMeta.钩子 || '—' }}</span></div>
      <div class="kv"><span class="k">情绪</span><span class="v">{{ chapterMeta.情绪 || '—' }}</span></div>
    </div>

    <!-- 账本提醒：mockup 固定渲染（card-title 标题 + 计数 + 看全部链接），无条目时空列表占位 -->
    <div class="card">
      <div class="card-title">
        账本提醒 <span style="color: var(--text-3)">{{ chapterLeads.length }}</span>
        <span style="color: var(--ink-cyan); cursor: pointer; text-transform: none; font-weight: 500" @click="gotoLeads">看全部 →</span>
      </div>
      <template v-if="chapterLeads.length">
        <div v-for="l in chapterLeads" :key="l.编号" class="ledger-item click" @click="gotoLeads">
          <span class="dot" :class="l.状态 === '已收尾' ? 'green' : l.状态 === '进行中' ? 'yellow' : 'gray'"></span>
          <div>
            <b>{{ l.类型 }}·{{ l.标题 }}</b>
            <div class="desc">{{ l.状态 }} · 开启第 {{ l.开启章 }} 章</div>
          </div>
        </div>
      </template>
      <div v-else style="font-size: 12px; color: var(--text-3)">—</div>
    </div>

    <!-- 出场角色：对齐 mockup renderEditRight 章分支（kv：角色名 → 主视角/在场/双视角） -->
    <!-- core 补 chapterRoles API 后填真实角色；暂空则显示 — -->
    <div class="card">
      <div class="card-title">出场角色</div>
      <div v-for="(r, i) in chapterRoles" :key="i" class="kv">
        <span class="k">{{ r.名字 }}</span>
        <span class="v" :class="r.cls">{{ r.角色 }}</span>
      </div>
      <div v-if="!chapterRoles.length" class="kv"><span class="k" style="color:var(--text-3)">—</span><span class="v" style="color:var(--text-3)">—</span></div>
    </div>
  </template>

  <!-- 设定文件：关联 / 人物关系 / 提示（定稿/设定/ 下的文档） -->
  <template v-else-if="fileType === 'doc' && /定稿[\/\\]设定[\/\\]/.test(file)">
    <div class="card">
      <div class="card-title">关联</div>
      <div class="kv"><span class="k">出场章节</span><span class="v cyan">{{ settingMeta.出场章节 ?? '—' }}</span></div>
      <div class="kv"><span class="k">账本引用</span><span class="v">{{ settingMeta.账本引用 ?? '—' }}</span></div>
    </div>
    <div class="card">
      <div class="card-title">人物关系</div>
      <!-- core 补 settingRelations API 后填真实关联角色；暂空则显示 — -->
      <div v-for="(r, i) in settingRelations" :key="i" class="kv">
        <span class="k">{{ r.名字 }}</span>
        <span class="v" :class="r.cls">{{ r.关系 }}</span>
      </div>
      <div v-if="!settingRelations.length" class="kv"><span class="k" style="color:var(--text-3)">—</span><span class="v" style="color:var(--text-3)">—</span></div>
    </div>
    <div class="card">
      <div class="card-title">提示</div>
      <div style="font-size: 12px; color: var(--text-2); line-height: 1.7">设定保存后，相关章节的元数据会提示更新。</div>
    </div>
  </template>

  <!-- 大纲文件：大纲统计 / 提示（大纲/ 下的文档） -->
  <template v-else-if="fileType === 'doc' && /^大纲[\/\\]/.test(file)">
    <div class="card">
      <div class="card-title">大纲统计</div>
      <div class="kv"><span class="k">结构</span><span class="v">{{ outlineMeta.结构 || '—' }}</span></div>
      <div class="kv"><span class="k">预计章节</span><span class="v cyan">{{ outlineMeta.预计章节 ?? '—' }}</span></div>
      <div class="kv"><span class="k">已写</span><span class="v">{{ outlineMeta.已写 != null ? outlineMeta.已写 + (outlineMeta.总章节 ? ' / ' + outlineMeta.总章节 : '') : '—' }}</span></div>
      <div class="progress"><div :style="{ width: (outlineMeta.进度 ?? 0) + '%' }"></div></div>
    </div>
    <div class="card">
      <div class="card-title">提示</div>
      <div style="font-size: 12px; color: var(--text-2); line-height: 1.7">大纲条目可直接点选编辑。完成后可生成章节占位。</div>
    </div>
  </template>

  <!-- 未选文件：回退到文件信息卡 -->
  <div v-else class="card">
    <div class="card-title">当前文件</div>
    <div class="kv"><span class="k">文件</span><span class="v cyan" style="word-break: break-all">{{ file || '（未选）' }}</span></div>
    <div class="kv"><span class="k">类型</span><span class="v">{{ file ? '设定 / 大纲' : '—' }}</span></div>
    <div v-if="file" class="kv"><span class="k">字数</span><span class="v">{{ loading ? '…' : words.toLocaleString() }}</span></div>
  </div>
</template>

<style scoped>
/* mockup 覆盖 .card/.card-title/.kv/.ledger-item/.btn-row；仅补情绪曲线柱图容器（mockup 内联，抽类更清晰）。 */
.emo-bars{display:flex;align-items:flex-end;gap:6px;height:50px;margin-bottom:4px}
.emo-bar{flex:1;border-radius:3px 3px 0 0;min-height:4px}
.emo-labels{display:flex;gap:6px;font-size:10px;color:var(--text-3)}
.emo-labels > span{flex:1;text-align:center}
.reversal-text{font-size:12px;color:var(--ink);line-height:1.7}
/* mockup 右栏反转线索卡的 btn-row 用 margin-top:8px（比全局 14px 更紧凑）。 */
.btn-row{margin-top:8px}
</style>
