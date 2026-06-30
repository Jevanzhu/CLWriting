<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import CodeEditor from '../components/CodeEditor.vue'
import type { BookConfigLoose } from '../types'
import {
  commitLearnedStyle,
  enableRag,
  exportBook,
  getConfig,
  importBook,
  knowledgeCheck,
  learnStyle,
  putConfig,
  readFile,
  writeFile,
  type LearnCandidates,
} from '../api/books'

const route = useRoute()
const name = computed(() => (typeof route.params.name === 'string' ? route.params.name : ''))
const config = ref<BookConfigLoose | null>(null)
const loading = ref(true)
const saving = ref(false)
const savedMsg = ref('')
const error = ref('')

const styleContent = ref('')
const styleOriginal = ref('')
const styleMissing = ref(false)
const styleSaving = ref(false)

const EXTENDED_LEADS = ['局线', '设定线', '成长线', '关系债']

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    config.value = await getConfig(name.value)
    try {
      const content = await readFile(name.value, '文风/文风铁律.md')
      styleContent.value = content
      styleOriginal.value = content
      styleMissing.value = false
    } catch {
      styleMissing.value = true
      styleContent.value = ''
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

function toggleLead(l: string): void {
  if (!config.value) return
  const arr = config.value.leads.enabled
  const i = arr.indexOf(l)
  if (i >= 0) arr.splice(i, 1)
  else arr.push(l)
}

async function saveConfig(): Promise<void> {
  if (!config.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await putConfig(name.value, config.value)
    savedMsg.value = '配置已保存'
    setTimeout(() => (savedMsg.value = ''), 2000)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function saveStyle(): Promise<void> {
  if (styleSaving.value || styleMissing.value) return
  styleSaving.value = true
  error.value = ''
  try {
    await writeFile(name.value, '文风/文风铁律.md', styleContent.value)
    styleOriginal.value = styleContent.value
    savedMsg.value = '文风铁律已保存'
    setTimeout(() => (savedMsg.value = ''), 2000)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    styleSaving.value = false
  }
}

const styleDirty = computed(() => styleContent.value !== styleOriginal.value)

// 8.4 导入 / 导出 / RAG
const EXPORT_FORMATS = ['merged', 'split', 'both'] as const
const PLATFORMS = ['generic', 'wechat', 'zhihu-salt', 'fanqie', 'xiaohongshu'] as const
const exportFormat = ref<'merged' | 'split' | 'both'>('both')
const exportPlatform = ref<string>('generic')
const exportRunning = ref(false)
const exportResult = ref('')
const importPath = ref('')
const importName = ref('')
const importKind = ref<'long' | 'short' | ''>('')
const importGenre = ref('')
const importRunning = ref(false)
const importResult = ref('')
const ragEndpoint = ref('')
const ragModel = ref('')
const ragKey = ref('')
const ragUseEnv = ref(false)
const ragRunning = ref(false)
const ragResult = ref('')

async function doExport(): Promise<void> {
  if (exportRunning.value || !name.value) return
  exportRunning.value = true
  exportResult.value = ''
  try {
    const d = await exportBook(name.value, { format: exportFormat.value, platform: exportPlatform.value })
    exportResult.value = (d.stdout || '').trim()
  } catch (e) {
    exportResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  }
  exportRunning.value = false
}

async function doImport(): Promise<void> {
  if (importRunning.value || !importPath.value.trim()) return
  importRunning.value = true
  importResult.value = ''
  try {
    const body: Record<string, unknown> = { sourcePath: importPath.value.trim() }
    if (importName.value.trim()) body['name'] = importName.value.trim()
    if (importKind.value) body['kind'] = importKind.value
    if (importGenre.value.trim()) body['genre'] = importGenre.value.trim()
    const d = await importBook(body)
    importResult.value = (d.stdout || '').trim()
  } catch (e) {
    importResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  }
  importRunning.value = false
}

async function doEnableRag(): Promise<void> {
  if (ragRunning.value || !ragEndpoint.value.trim() || !ragModel.value.trim() || !name.value) return
  ragRunning.value = true
  ragResult.value = ''
  try {
    const body: Record<string, unknown> = { endpoint: ragEndpoint.value.trim(), model: ragModel.value.trim() }
    if (ragUseEnv.value) body['useEnv'] = true
    else if (ragKey.value) body['key'] = ragKey.value
    const d = await enableRag(name.value, body)
    ragResult.value = (d.stdout || '').trim()
    ragKey.value = '' // 已落盘 rag.secret，清空输入
  } catch (e) {
    ragResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  }
  ragRunning.value = false
}

// 8.3 知识层校验 + learn 文风收割
const knowledgeRunning = ref(false)
const knowledgeResult = ref('')
const learnRunning = ref(false)
const learnCandidates = ref<LearnCandidates | null>(null)
const pickedSamples = ref<boolean[]>([])
const pickedQuotes = ref<boolean[]>([])
const learnCommitRunning = ref(false)
const learnResult = ref('')
const anyPicked = computed(() => pickedSamples.value.some(Boolean) || pickedQuotes.value.some(Boolean))

async function doKnowledgeCheck(): Promise<void> {
  if (knowledgeRunning.value || !name.value) return
  knowledgeRunning.value = true
  knowledgeResult.value = ''
  try {
    const d = await knowledgeCheck(name.value)
    knowledgeResult.value = (d.stdout || '').trim()
  } catch (e) {
    knowledgeResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  }
  knowledgeRunning.value = false
}

async function doLearn(): Promise<void> {
  if (learnRunning.value || !name.value) return
  learnRunning.value = true
  learnCandidates.value = null
  learnResult.value = ''
  try {
    const d = await learnStyle(name.value)
    learnCandidates.value = d
    // 默认全选（机检已过滤≥60），作者可取消不想要的
    pickedSamples.value = new Array(d.samples.length).fill(true)
    pickedQuotes.value = new Array(d.quotes.length).fill(true)
  } catch (e) {
    learnResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  }
  learnRunning.value = false
}

async function doLearnCommit(): Promise<void> {
  if (learnCommitRunning.value || !learnCandidates.value || !name.value) return
  learnCommitRunning.value = true
  learnResult.value = ''
  const samples = learnCandidates.value.samples.filter((_, i) => pickedSamples.value[i])
  const quotes = learnCandidates.value.quotes.filter((_, i) => pickedQuotes.value[i])
  try {
    const d = await commitLearnedStyle(name.value, { samples, quotes })
    learnResult.value = `✓ 入库 ${(d.sampleFiles ?? []).length} 样章 + ${(d.quoteFiles ?? []).length} 金句`
    learnCandidates.value = null
  } catch (e) {
    learnResult.value = `✗ ${e instanceof Error ? e.message : String(e)}`
  }
  learnCommitRunning.value = false
}

onMounted(load)
</script>

<template>
  <section class="cfg-page">
    <div class="bento-wrap" style="max-width:840px">
      <div class="bento-head">
        <h1 class="bento-title">配置</h1>
        <div class="bento-sub"><span class="meta-chip">book.yaml</span><span class="meta-chip">文风</span><span class="meta-chip">导入导出</span><span class="meta-chip">RAG</span><span class="meta-chip">知识层</span><span class="meta-chip">文风收割</span></div>
      </div>

      <p v-if="loading" class="hint">加载中…</p>
      <p v-else-if="error && !config" class="error">{{ error }}</p>
      <template v-else-if="config">
        <article class="card">
          <div class="card-title">配置 · book.yaml</div>
          <div class="form">
            <label class="field">书名 <input v-model="config.book.title" /></label>
            <label class="field">题材 <input v-model="config.book.genre" placeholder="玄幻 / 悬疑 / 言情…" /></label>
            <label class="field">目标字数（book.target_words） <input type="number" v-model.number="config.book.target_words" placeholder="如：300000" /></label>
            <div class="field">
              <span class="lbl">类型</span>
              <div class="seg">
                <button type="button" :class="{ active: (config.kind ?? 'long') === 'long' }" @click="config.kind = 'long'">长篇</button>
                <button type="button" :class="{ active: config.kind === 'short' }" @click="config.kind = 'short'">短篇集</button>
              </div>
            </div>
            <div v-if="(config.kind ?? 'long') === 'long'" class="field">
              <span class="lbl">扩展账本类</span>
              <div class="leads">
                <label v-for="l in EXTENDED_LEADS" :key="l" class="lead">
                  <input type="checkbox" :checked="config.leads.enabled.includes(l)" @change="toggleLead(l)" /> {{ l }}
                </label>
              </div>
            </div>
            <label class="field">每章调用上限（budget.calls_per_chapter） <input type="number" v-model.number="config.budget.calls_per_chapter" /></label>
            <div class="field">
              <span class="lbl">文风注入（style.injection）</span>
              <div class="seg">
                <button type="button" :class="{ active: config.style.injection === 'light' }" @click="config.style.injection = 'light'">light</button>
                <button type="button" :class="{ active: config.style.injection === 'heavy' }" @click="config.style.injection = 'heavy'">heavy</button>
              </div>
            </div>
            <label class="field check">
              <input type="checkbox" v-model="config.auto.confirm_outline" /> 自动确认细纲（auto.confirm_outline）
            </label>
            <label class="field">批量大小（auto.batch_size） <input type="number" v-model.number="config.auto.batch_size" /></label>
            <label class="field">跃迁跨度上限（growth.realm_span_max） <input type="number" v-model.number="config.growth.realm_span_max" /></label>
            <p v-if="error" class="error">{{ error }}</p>
            <div class="actions">
              <span v-if="savedMsg" class="saved">{{ savedMsg }}</span>
              <button class="btn primary" :disabled="saving" @click="saveConfig">{{ saving ? '保存中…' : '保存配置' }}</button>
            </div>
          </div>
        </article>

        <article class="card">
          <div class="card-title">文风铁律 · 文风/文风铁律.md</div>
          <p v-if="styleMissing" class="hint">这本书没有 文风/文风铁律.md（可在编辑器创建后回来编辑）。</p>
          <template v-else>
            <CodeEditor :model-value="styleContent" mode="md" @update:model-value="styleContent = $event" />
            <div class="actions">
              <button class="btn primary" :disabled="!styleDirty || styleSaving" @click="saveStyle">{{ styleSaving ? '保存中…' : '保存文风铁律' }}</button>
            </div>
          </template>
        </article>

        <article class="card">
          <div class="card-title">导出定稿 · 8.4</div>
          <p class="io-tip">干净导出（剥 front matter），产物落 工作区/导出/。长篇按章，短篇按篇 + 投稿视图。</p>
          <div class="io-row">
            <label class="io-field">格式
              <select v-model="exportFormat">
                <option v-for="f in EXPORT_FORMATS" :key="f" :value="f">{{ f }}</option>
              </select>
            </label>
            <label class="io-field">投稿模板（短篇）
              <select v-model="exportPlatform">
                <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
              </select>
            </label>
            <button class="btn primary" :disabled="exportRunning" @click="doExport">{{ exportRunning ? '导出中…' : '📦 导出' }}</button>
          </div>
          <pre v-if="exportResult" class="io-result">{{ exportResult }}</pre>
        </article>

        <article class="card">
          <div class="card-title">导入 v0.2 正文 · 8.4</div>
          <p class="io-tip">导入旧版正文，length-routing 自动分流长短篇，建新书。</p>
          <div class="io-row">
            <input v-model="importPath" placeholder="v0.2 正文路径（本机 .md）" class="io-input-wide" />
          </div>
          <div class="io-row">
            <input v-model="importName" placeholder="书名（可选）" />
            <select v-model="importKind"><option value="">自动判定</option><option value="long">长篇</option><option value="short">短篇</option></select>
            <input v-model="importGenre" placeholder="题材（可选）" />
            <button class="btn primary" :disabled="importRunning || !importPath.trim()" @click="doImport">{{ importRunning ? '导入中…' : '📥 导入' }}</button>
          </div>
          <pre v-if="importResult" class="io-result">{{ importResult }}</pre>
        </article>

        <article class="card">
          <div class="card-title">RAG 插件 · 8.4</div>
          <p class="io-tip">启用外部 embedding 召回（可选）。key 落本地 .clwriting/rag.secret（不进 git）。</p>
          <div class="io-row">
            <input v-model="ragEndpoint" placeholder="embedding 端点（OpenAI 兼容）" class="io-input-wide" />
          </div>
          <div class="io-row">
            <input v-model="ragModel" placeholder="模型名" />
            <input v-if="!ragUseEnv" v-model="ragKey" type="password" placeholder="api_key（落 rag.secret）" />
            <label class="io-check"><input type="checkbox" v-model="ragUseEnv" /> 用环境变量</label>
            <button class="btn primary" :disabled="ragRunning || !ragEndpoint.trim() || !ragModel.trim()" @click="doEnableRag">{{ ragRunning ? '配置中…' : '🔌 启用' }}</button>
          </div>
          <pre v-if="ragResult" class="io-result">{{ ragResult }}</pre>
        </article>

        <article class="card">
          <div class="card-title">知识层校验 · 8.3</div>
          <p class="io-tip">校验知识层 manifest（references 完整性 / source · license）。</p>
          <button class="btn primary" :disabled="knowledgeRunning" @click="doKnowledgeCheck">{{ knowledgeRunning ? '校验中…' : '🔍 校验' }}</button>
          <pre v-if="knowledgeResult" class="io-result">{{ knowledgeResult }}</pre>
        </article>

        <article class="card">
          <div class="card-title">文风收割 learn · 8.3（长篇）</div>
          <p class="io-tip">扫定稿正文产样章 / 金句候选（机检打分 ≥60），作者勾选后入样章库 / 金句库。短篇无此结构。</p>
          <button class="btn primary" :disabled="learnRunning" @click="doLearn">{{ learnRunning ? '产候选中…' : '🌾 产候选' }}</button>
          <template v-if="learnCandidates">
            <div v-if="learnCandidates.samples.length" class="cand-block">
              <h4>样章候选（{{ learnCandidates.samples.length }}）</h4>
              <label v-for="(s, i) in learnCandidates.samples" :key="'s' + i" class="cand-item">
                <input type="checkbox" v-model="pickedSamples[i]" />
                <span class="cand-meta">[{{ s.场景 }}] <b>{{ s.打分 }}</b> 分 · {{ s.出处 }}</span>
                <span class="cand-text">{{ s.正文.slice(0, 80) }}{{ s.正文.length > 80 ? '…' : '' }}</span>
              </label>
            </div>
            <div v-if="learnCandidates.quotes.length" class="cand-block">
              <h4>金句候选（{{ learnCandidates.quotes.length }}）</h4>
              <label v-for="(q, i) in learnCandidates.quotes" :key="'q' + i" class="cand-item">
                <input type="checkbox" v-model="pickedQuotes[i]" />
                <span class="cand-meta">[{{ q.场景 }}]</span>
                <span class="cand-text">{{ q.正文 }}</span>
              </label>
            </div>
            <p v-if="!learnCandidates.samples.length && !learnCandidates.quotes.length" class="hint">无候选（定稿正文少或打分都低于 60）。</p>
            <div class="actions">
              <button class="btn primary" :disabled="learnCommitRunning || !anyPicked" @click="doLearnCommit">{{ learnCommitRunning ? '入库中…' : '📥 入库选中' }}</button>
            </div>
          </template>
          <pre v-if="learnResult" class="io-result">{{ learnResult }}</pre>
        </article>
      </template>
    </div>
  </section>
</template>

<style scoped>
.cfg-page {
  margin: 0 auto;
  text-align: left;
}
.form {
  display: grid;
  gap: 14px;
}
.field {
  display: grid;
  gap: 4px;
  font-size: 13px;
  color: var(--ink);
}
.field .lbl {
  color: var(--ink);
}
.field input:not([type='checkbox']) {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 14px;
  background: var(--paper);
  color: var(--ink);
  outline: none;
}
.field input:not([type='checkbox']):focus {
  border-color: var(--ink-cyan);
}
.field.check {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.seg {
  display: inline-flex;
  gap: 8px;
}
.seg button {
  padding: 5px 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  cursor: pointer;
  font-size: 13px;
  color: var(--ink);
}
.seg button.active {
  border-color: var(--ink-cyan);
  background: var(--active-bg);
  color: var(--ink-cyan);
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
  font-size: 13px;
  cursor: pointer;
  color: var(--ink);
}
.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}
.saved {
  color: var(--ink-cyan);
  font-size: 13px;
}
.error {
  color: var(--cinnabar);
  font-size: 13px;
}
.hint {
  color: var(--text-2);
  font-size: 13px;
  padding: 12px 0;
}
.io-tip {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
.io-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  margin-bottom: 8px;
}
.io-row input,
.io-row select {
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
.io-input-wide {
  flex: 1;
  min-width: 240px;
}
.io-field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
}
.io-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--ink);
  white-space: nowrap;
}
.io-result {
  margin: 8px 0 0;
  padding: 10px;
  background: var(--paper);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink);
  white-space: pre-wrap;
  max-height: 180px;
  overflow-y: auto;
}
.cand-block {
  margin-top: 12px;
}
.cand-block h4 {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ink);
}
.cand-item {
  display: grid;
  grid-template-columns: 20px auto 1fr;
  gap: 8px;
  align-items: start;
  padding: 8px 10px;
  background: var(--paper);
  border-radius: 6px;
  margin-bottom: 6px;
  font-size: 13px;
  cursor: pointer;
}
.cand-item input {
  margin-top: 3px;
  cursor: pointer;
  accent-color: var(--ink-cyan);
}
.cand-meta {
  color: var(--text-2);
  font-size: 12px;
  white-space: nowrap;
}
.cand-meta b {
  color: var(--ink-cyan);
}
.cand-text {
  color: var(--ink);
  line-height: 1.5;
}
</style>
