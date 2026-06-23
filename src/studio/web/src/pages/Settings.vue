<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useRoute } from 'vue-router'
import BookTabs from '../components/BookTabs.vue'

interface RealmSystem {
  名称: string
  序列: string[]
}
interface FreeCard {
  标题: string
  摘要: string
}
interface CharacterCard {
  file: string
  姓名: string
  身份: string
  目标: string
  境界: string
  正文: string
}
interface DebtEdge {
  编号: string
  标题: string
  状态: string
  欠方: string
  债主: string
}
interface SettingsData {
  kind: 'long'
  realm: { 体系: RealmSystem[]; 正文?: string } | null
  characters: CharacterCard[]
  timeline: FreeCard[]
  debtGraph: DebtEdge[]
}

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
    const r = await fetch(`/api/books/${encodeURIComponent(n)}/settings`)
    if (!r.ok) {
      const e = (await r.json().catch(() => ({}))) as { error?: string }
      throw new Error(e.error ?? `HTTP ${r.status}`)
    }
    data.value = (await r.json()) as SettingsData
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// P2 角色卡编辑
const editingChar = ref<string | null>(null)
const charForm = ref<CharacterCard>({ file: '', 姓名: '', 身份: '', 目标: '', 境界: '', 正文: '' })
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
    const r = await fetch(`/api/books/${encodeURIComponent(name.value)}/settings/character`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(charForm.value),
    })
    const d = (await r.json()) as { ok?: boolean; error?: string }
    if (r.ok && d.ok) {
      if (data.value && data.value.characters[i]) {
        data.value.characters[i] = { ...charForm.value, file: c.file }
      }
      editingChar.value = null
    } else {
      alert(d.error ?? `HTTP ${r.status}`)
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e))
  }
  charSaving.value = false
}

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
    <BookTabs :name="name" active="settings" />

    <p v-if="loading" class="hint">加载中…</p>
    <p v-else-if="error" class="hint error">加载失败:{{ error }}</p>
    <template v-else-if="data && data.kind === 'long'">
      <!-- 境界体系(强结构化,核心) -->
      <article class="card">
        <h3 class="block-title">境界体系</h3>
        <div v-if="data.realm && data.realm.体系.length">
          <div v-for="sys in data.realm.体系" :key="sys.名称" class="realm-system">
            <div class="realm-name">{{ sys.名称 }}</div>
            <div class="realm-chain">
              <template v-for="(r, i) in sys.序列" :key="r">
                <span class="realm-chip">{{ r }}</span>
                <span v-if="i < sys.序列.length - 1" class="realm-arrow">→</span>
              </template>
            </div>
          </div>
          <p v-if="data.realm.正文" class="realm-note">{{ data.realm.正文 }}</p>
        </div>
        <p v-else class="hint">暂无境界体系(定稿/设定/境界体系.md)</p>
      </article>

      <!-- 角色卡片(P2 结构化可编辑) -->
      <article class="card">
        <h3 class="block-title">角色 <span class="title-hint">· 点击编辑</span></h3>
        <div v-if="data.characters.length" class="card-grid">
          <div v-for="(c, i) in data.characters" :key="c.file" class="char-card">
            <template v-if="editingChar !== c.file">
              <div class="free-title">{{ c.姓名 }}</div>
              <p v-if="c.身份" class="char-meta"><span>身份</span>{{ c.身份 }}</p>
              <p v-if="c.目标" class="char-meta"><span>目标</span>{{ c.目标 }}</p>
              <p v-if="c.境界" class="char-meta"><span>境界</span>{{ c.境界 }}</p>
              <p class="free-summary">{{ c.正文.slice(0, 100) }}{{ c.正文.length > 100 ? '…' : '' }}</p>
              <button class="btn-edit" @click="startEditChar(c)">✍ 编辑</button>
            </template>
            <div v-else class="char-edit">
              <input v-model="charForm.姓名" class="char-input" placeholder="姓名(必填)" />
              <input v-model="charForm.身份" class="char-input" placeholder="身份" />
              <input v-model="charForm.目标" class="char-input" placeholder="目标" />
              <input v-model="charForm.境界" class="char-input" placeholder="境界" />
              <textarea v-model="charForm.正文" class="char-textarea" placeholder="性格/外貌/履历…(正文,自由描述)" rows="5"></textarea>
              <div class="char-edit-btns">
                <button class="btn-save-char" :disabled="charSaving" @click="saveCharacter(c, i)">
                  {{ charSaving ? '保存中…' : '💾 保存' }}
                </button>
                <button class="btn-cancel-char" :disabled="charSaving" @click="editingChar = null">取消</button>
              </div>
            </div>
          </div>
        </div>
        <p v-else class="hint">暂无角色(定稿/设定/角色/*.md)</p>
      </article>

      <!-- 时间线 -->
      <article class="card">
        <h3 class="block-title">时间线</h3>
        <div v-if="data.timeline.length" class="card-grid">
          <div v-for="(t, i) in data.timeline" :key="i" class="free-card">
            <div class="free-title">{{ t.标题 }}</div>
            <pre class="free-summary pre">{{ t.摘要 }}</pre>
          </div>
        </div>
        <p v-else class="hint">暂无时间线(定稿/设定/时间线/*.md)</p>
      </article>

      <!-- 关系债子图 -->
      <article v-if="data.debtGraph.length" class="card">
        <h3 class="block-title">关系债子图</h3>
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
  </section>
</template>

<style scoped>
.settings-page {
  max-width: 1040px;
  margin: 0 auto;
}
.card {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px 20px;
}
.card + .card {
  margin-top: 16px;
}
.block-title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7280;
  letter-spacing: 0.04em;
}
.hint {
  color: #6b7280;
}
.hint.error {
  color: #dc2626;
}

/* 境界体系 */
.realm-system {
  margin-bottom: 12px;
}
.realm-name {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
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
  background: #ede9fe;
  color: #5b21b6;
  border-radius: 10px;
  font-size: 13px;
}
.realm-arrow {
  color: #c4b5fd;
  font-size: 12px;
}
.realm-note {
  margin: 8px 0 0;
  padding: 8px 12px;
  background: #f9fafb;
  border-radius: 6px;
  font-size: 13px;
  color: #4b5563;
}

/* 角色卡片网格 */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.free-card {
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
}
.free-title {
  font-size: 14px;
  font-weight: 600;
  color: #111827;
  margin-bottom: 6px;
}
.free-summary {
  margin: 0;
  font-size: 13px;
  color: #4b5563;
  line-height: 1.5;
}
.free-summary.pre {
  white-space: pre-wrap;
  font-family: inherit;
}

/* P2 角色卡编辑 */
.title-hint {
  font-weight: 400;
  color: #9ca3af;
  font-size: 12px;
}
.char-card {
  padding: 12px;
  background: #f9fafb;
  border-radius: 6px;
}
.char-meta {
  margin: 2px 0;
  font-size: 13px;
  color: #4b5563;
}
.char-meta span {
  display: inline-block;
  min-width: 36px;
  color: #9ca3af;
  font-size: 12px;
}
.btn-edit {
  margin-top: 8px;
  padding: 3px 10px;
  border: 1px solid #3b82f6;
  border-radius: 4px;
  background: #fff;
  color: #3b82f6;
  font-size: 12px;
  cursor: pointer;
}
.char-edit {
  display: grid;
  gap: 6px;
}
.char-input {
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 13px;
}
.char-textarea {
  padding: 6px 8px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  font-size: 13px;
  resize: vertical;
  font-family: inherit;
}
.char-edit-btns {
  display: flex;
  gap: 8px;
}
.btn-save-char {
  padding: 4px 12px;
  border: none;
  border-radius: 4px;
  background: #059669;
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.btn-save-char:disabled {
  background: #9ca3af;
  cursor: not-allowed;
}
.btn-cancel-char {
  padding: 4px 12px;
  border: 1px solid #d1d5db;
  border-radius: 4px;
  background: #fff;
  color: #6b7280;
  font-size: 12px;
  cursor: pointer;
}

/* 关系债 */
.debt-list {
  margin: 0;
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
  background: #f9fafb;
  border-radius: 6px;
  font-size: 14px;
}
.debt-party {
  font-weight: 600;
  color: #111827;
}
.debt-arrow {
  color: #dc2626;
  font-size: 13px;
}
.debt-meta {
  margin-left: auto;
  color: #6b7280;
  font-size: 12px;
}
</style>
