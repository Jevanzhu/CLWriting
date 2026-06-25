<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import type { EChartsOption } from 'echarts'
import EChart from '../components/EChart.vue'
import type { CharacterCard, RealmSystem, SettingsData } from '../types'
import { getSettings, updateCharacter, updateRealm } from '../api/books'

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const data = ref<SettingsData | null>(null)
const loading = ref(true)
const error = ref('')

async function load(n: string): Promise<void> {
  loading.value = true
  error.value = ''
  data.value = null
  try {
    data.value = await getSettings(n)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// P2 角色卡编辑
const editingChar = ref<string | null>(null)
const charForm = ref<CharacterCard>({ file: '', 姓名: '', 身份: '', 目标: '', 境界: '', 关系: '', 正文: '' })
const charSaving = ref(false)

function startEditChar(c: CharacterCard): void {
  editingChar.value = c.file
  charForm.value = { ...c }
}

async function saveCharacter(c: CharacterCard, i: number): Promise<void> {
  if (!name.value) return
  if (!charForm.value.姓名.trim()) {
    alert('姓名必填')
    return
  }
  charSaving.value = true
  try {
    await updateCharacter(name.value, charForm.value)
    if (data.value && data.value.characters[i]) {
      data.value.characters[i] = { ...charForm.value, file: c.file }
    }
    editingChar.value = null
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
  charSaving.value = false
}

// P2 境界体系编辑
interface RealmSysForm {
  名称: string
  _seqText: string
}
const editingRealm = ref(false)
const realmForm = ref<{ 体系: RealmSysForm[]; 正文: string }>({ 体系: [], 正文: '' })
const realmSaving = ref(false)

function startEditRealm(): void {
  if (!data.value?.realm) return
  editingRealm.value = true
  realmForm.value = {
    体系: data.value.realm.体系.map((s) => ({ 名称: s.名称, _seqText: s.序列.join(', ') })),
    正文: data.value.realm.正文 ?? '',
  }
}

function addRealmSys(): void {
  realmForm.value.体系.push({ 名称: '', _seqText: '' })
}

function removeRealmSys(i: number): void {
  realmForm.value.体系.splice(i, 1)
}

async function saveRealm(): Promise<void> {
  if (!name.value) return
  realmSaving.value = true
  const 体系 = realmForm.value.体系
    .filter((s) => s.名称.trim() !== '')
    .map((s) => ({
      名称: s.名称.trim(),
      序列: s._seqText.split(/[,，]/).map((x) => x.trim()).filter(Boolean),
    }))
  const 正文 = realmForm.value.正文.trim()
  try {
    const payload: { 体系: RealmSystem[]; 正文?: string } = { 体系, ...(正文 ? { 正文 } : {}) }
    await updateRealm(name.value, payload)
    if (data.value) {
      data.value.realm = payload
    }
    editingRealm.value = false
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
  realmSaving.value = false
}

/** 关系图:角色 + 角色关系 + 关系债网络(力导向布局,#7.5) */
const graphOption = computed<EChartsOption | null>(() => {
  if (!data.value) return null
  const names = new Set<string>()
  data.value.characters.forEach((c) => names.add(c.姓名))
  data.value.debtGraph.forEach((d) => {
    if (d.欠方) names.add(d.欠方)
    if (d.债主) names.add(d.债主)
  })
  data.value.characterRelations.forEach((r) => {
    if (r.from) names.add(r.from)
    if (r.to) names.add(r.to)
  })
  if (names.size === 0) return null
  // 关系债边(红,label 欠) + 角色关系边(绿,label 关系类型)
  const debtLinks = data.value.debtGraph
    .filter((d) => d.欠方 && d.债主)
    .map((d) => ({ source: d.欠方, target: d.债主, label: { show: true, formatter: '欠' }, lineStyle: { color: 'var(--cinnabar)' } }))
  const relLinks = data.value.characterRelations
    .filter((r) => r.from && r.to)
    .map((r) => ({ source: r.from, target: r.to, label: { show: true, formatter: r.type }, lineStyle: { color: 'var(--ink-cyan)' } }))
  return {
    tooltip: {},
    series: [
      {
        type: 'graph',
        layout: 'force',
        force: { repulsion: 340, edgeLength: 140, gravity: 0.1 },
        roam: true,
        label: { show: true, position: 'right', fontSize: 12 },
        edgeLabel: {
          show: true,
          fontSize: 11,
          formatter: (params) => String((params as { data?: { label?: string } }).data?.label ?? ''),
        },
        data: [...names].map((n) => ({ name: n, symbolSize: 40 })),
        links: [...debtLinks, ...relLinks],
        lineStyle: { width: 2, curveness: 0.2 },
        itemStyle: { color: 'var(--ink-cyan)' },
      },
    ],
  }
})

watch(
  () => route.params.name,
  (n) => {
    if (typeof n === 'string') load(n)
  },
  { immediate: true },
)
</script>

<template>
  <section class="settings-page">
    <div class="panel-pad">
      <div class="panel-title">设定</div>
      <div class="panel-sub">境界 · 角色 · 时间线 · 关系</div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error" class="hint error">加载失败：{{ error }}</p>
      <template v-else-if="data && data.kind === 'long'">
        <!-- 境界体系（P2 可编辑） -->
        <article class="card">
          <div class="card-title">境界体系<span class="title-hint">· 点击编辑</span></div>
          <template v-if="data.realm">
            <template v-if="!editingRealm">
              <div v-if="data.realm.体系.length">
                <div v-for="sys in data.realm.体系" :key="sys.名称" class="realm-system">
                  <div class="realm-name">{{ sys.名称 }}</div>
                  <div class="realm-chain">
                    <template v-for="(r, i) in sys.序列" :key="r + i">
                      <span class="realm-chip">{{ r }}</span>
                      <span v-if="i < sys.序列.length - 1" class="realm-arrow">→</span>
                    </template>
                  </div>
                </div>
                <p v-if="data.realm.正文" class="realm-note">{{ data.realm.正文 }}</p>
              </div>
              <p v-else class="hint">暂无体系（点编辑添加一个）</p>
              <div class="btn-row"><button class="btn" @click="startEditRealm">✍ 编辑</button></div>
            </template>
            <div v-else class="realm-edit">
              <div v-for="(sys, si) in realmForm.体系" :key="si" class="realm-sys-edit">
                <input v-model="sys.名称" class="char-input" placeholder="体系名（如 修真境界）" />
                <input v-model="sys._seqText" class="char-input" placeholder="序列（逗号分隔：炼气, 筑基, 金丹）" />
                <button class="btn danger" @click="removeRealmSys(si)">删除体系</button>
              </div>
              <button class="btn" @click="addRealmSys">+ 添加体系</button>
              <textarea v-model="realmForm.正文" class="char-textarea" placeholder="境界说明（正文，人话描述，不参与机检）" rows="3"></textarea>
              <div class="char-edit-btns">
                <button class="btn primary" :disabled="realmSaving" @click="saveRealm">{{ realmSaving ? '保存中…' : '💾 保存' }}</button>
                <button class="btn" :disabled="realmSaving" @click="editingRealm = false">取消</button>
              </div>
            </div>
          </template>
          <p v-else class="hint">暂无境界体系（定稿/设定/境界体系.md）</p>
        </article>

        <!-- 角色卡片（P2 结构化可编辑） -->
        <article class="card">
          <div class="card-title">角色<span class="title-hint">· 点击编辑</span></div>
          <div v-if="data.characters.length" class="card-grid">
            <div v-for="(c, i) in data.characters" :key="c.file" class="char-card">
              <template v-if="editingChar !== c.file">
                <div class="free-title">{{ c.姓名 }}</div>
                <p v-if="c.身份" class="char-meta"><span>身份</span>{{ c.身份 }}</p>
                <p v-if="c.目标" class="char-meta"><span>目标</span>{{ c.目标 }}</p>
                <p v-if="c.境界" class="char-meta"><span>境界</span>{{ c.境界 }}</p>
                <p class="free-summary">{{ c.正文.slice(0, 100) }}{{ c.正文.length > 100 ? '…' : '' }}</p>
                <button class="btn" @click="startEditChar(c)">✍ 编辑</button>
              </template>
              <div v-else class="char-edit">
                <input v-model="charForm.姓名" class="char-input" placeholder="姓名（必填）" />
                <input v-model="charForm.身份" class="char-input" placeholder="身份" />
                <input v-model="charForm.目标" class="char-input" placeholder="目标" />
                <input v-model="charForm.境界" class="char-input" placeholder="境界" />
                <input v-model="charForm.关系" class="char-input" placeholder="关系（如 林远(师徒);赵衡(仇敌)）" />
                <textarea v-model="charForm.正文" class="char-textarea" placeholder="性格 / 外貌 / 履历…（正文，自由描述）" rows="5"></textarea>
                <div class="char-edit-btns">
                  <button class="btn primary" :disabled="charSaving" @click="saveCharacter(c, i)">{{ charSaving ? '保存中…' : '💾 保存' }}</button>
                  <button class="btn" :disabled="charSaving" @click="editingChar = null">取消</button>
                </div>
              </div>
            </div>
          </div>
          <p v-else class="hint">暂无角色（定稿/设定/角色/*.md）</p>
        </article>

        <!-- 时间线 -->
        <article class="card">
          <div class="card-title">时间线</div>
          <div v-if="data.timeline.length" class="card-grid">
            <div v-for="(t, i) in data.timeline" :key="i" class="free-card">
              <div class="free-title">{{ t.标题 }}</div>
              <pre class="free-summary pre">{{ t.摘要 }}</pre>
            </div>
          </div>
          <p v-else class="hint">暂无时间线（定稿/设定/时间线/*.md）</p>
        </article>

        <!-- 关系图（P2 角色 + 关系债网络） -->
        <article v-if="data.debtGraph.length || data.characterRelations.length" class="card">
          <div class="card-title">关系图<span class="title-hint">· 角色关系（绿）+ 关系债（红），可拖拽 / 缩放</span></div>
          <EChart v-if="graphOption" :option="graphOption" />
          <ul class="debt-list">
            <li v-for="d in data.debtGraph" :key="d.编号">
              <span class="debt-party">{{ d.欠方 || '—' }}</span>
              <span class="debt-arrow">欠</span>
              <span class="debt-party">{{ d.债主 || '—' }}</span>
              <span class="debt-meta">{{ d.编号 }} · {{ d.标题 }} · {{ d.状态 }}</span>
            </li>
          </ul>
        </article>
      </template>
    </div>
  </section>
</template>

<style scoped>
.settings-page {
  margin: 0 auto;
}
.title-hint {
  font-weight: 400;
  color: var(--text-3);
  font-size: 11px;
}
.realm-system {
  margin-bottom: 12px;
}
.realm-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 6px;
}
.realm-chain {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.realm-chip {
  padding: 2px 10px;
  background: var(--warn-bg);
  color: var(--ochre);
  border-radius: 10px;
  font-size: 13px;
}
.realm-arrow {
  color: var(--ochre);
  font-size: 12px;
}
.realm-note {
  margin: 8px 0 0;
  padding: 8px 12px;
  background: var(--paper);
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.free-card,
.char-card {
  padding: 12px 14px;
  background: var(--paper);
  border-radius: 8px;
}
.free-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 6px;
}
.free-summary {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.5;
}
.free-summary.pre {
  white-space: pre-wrap;
  font-family: inherit;
}
.char-meta {
  margin: 2px 0;
  font-size: 13px;
  color: var(--text-2);
}
.char-meta span {
  display: inline-block;
  min-width: 36px;
  color: var(--text-3);
  font-size: 12px;
}
.char-edit,
.realm-edit {
  display: grid;
  gap: 8px;
}
.char-input {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.char-input:focus {
  border-color: var(--ink-cyan);
}
.char-textarea {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.char-textarea:focus {
  border-color: var(--ink-cyan);
}
.char-edit-btns {
  display: flex;
  gap: 8px;
}
.realm-sys-edit {
  display: grid;
  gap: 6px;
  padding: 10px;
  background: var(--paper);
  border-radius: 6px;
}
.debt-list {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 8px;
}
.debt-list li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 8px 12px;
  background: var(--paper);
  border-radius: 6px;
  font-size: 13px;
}
.debt-party {
  font-weight: 600;
  color: var(--ink);
}
.debt-arrow {
  color: var(--cinnabar);
  font-size: 12px;
}
.debt-meta {
  margin-left: auto;
  color: var(--text-2);
  font-size: 12px;
}
.settings-page :deep(.echart) {
  height: 320px;
}
.settings-page .hint {
  color: var(--text-2);
  padding: 16px 0;
}
.settings-page .hint.error {
  color: var(--cinnabar);
}
</style>
