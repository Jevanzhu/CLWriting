<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useNewbookStore } from '../stores/newbook'

const router = useRouter()
const newbook = useNewbookStore()
// 建书表单 + 段 2 态走 store（storeToRefs 双向绑到 store state）
const {
  name,
  kind,
  genre,
  brief,
  leads,
  target: targetWords,
  steps: onboardSteps,
  phase,
  createdName,
  submitting,
  error,
  savedMsg,
} = storeToRefs(newbook)

// actions 直接从 store 取（Pinia 已绑 this）
const { submit, onboardRun, onboardSave, toggleLead } = newbook

const EXTENDED_LEADS = ['局线', '设定线', '成长线', '关系债']

/** 完成 → 进单书（路由跳转留 page，状态不进 store） */
function finishOnboard(): void {
  router.push(`/books/${encodeURIComponent(createdName.value)}`)
}

// kind 切换实时预览长/短篇目录结构差异（5.1 三点增强③）
const dirPreview = computed(() =>
  kind.value === 'short'
    ? ['篇/NNN-标题/正文.md（每篇独立）', '定稿/设定/（角色·境界·集子定位）', '文风/（样章·铁律·金句，整集共享）', '工作区/']
    : ['定稿/正文/章号-标题.md（每章一文件）', '大纲/（总纲·卷纲·账本类）', '定稿/设定/（角色·境界·世界观）', '文风/（样章·铁律·金句）', '工作区/'],
)
const canSubmit = computed(() => name.value.trim().length > 0 && !submitting.value)
</script>

<template>
  <section class="book-new">
    <div class="panel-pad" style="max-width:680px">
      <button class="btn" style="margin-bottom:18px" @click="router.push('/')">← 返回书架</button>

      <!-- 段 1：init 表单 -->
      <template v-if="phase === 'form'">
        <div class="panel-title">新建书籍</div>
        <div class="panel-sub">建书后可让 AI 据题材自动填设定（段 2）</div>

        <form class="card book-new-form" @submit.prevent="submit">
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
            <div class="leads">
              <label v-for="l in EXTENDED_LEADS" :key="l" class="lead">
                <input type="checkbox" :checked="leads.includes(l)" @change="toggleLead(l)" /> {{ l }}
              </label>
            </div>
          </div>
          <div class="sfield">
            <label>AI 宿主</label>
            <div class="host">
              <span class="host-active">Claude Code (cc)</span>
              <span class="host-disabled" title="首版暂不支持（决策 22）">Codex（暂未支持）</span>
            </div>
          </div>
        </form>

        <p v-if="error" class="error">{{ error }}</p>
        <div class="btn-row" style="justify-content:flex-end">
          <button class="btn primary" :disabled="!canSubmit" @click="submit">
            {{ submitting ? '创建中…' : '创建' }}
          </button>
        </div>
      </template>

      <!-- 段 2：AI 填设定 -->
      <template v-else>
        <div class="panel-title">段 2 · AI 填设定</div>
        <div class="panel-sub">《{{ createdName }}》已创建 · 让 AI 据题材填设定（每步可生成 / 编辑 / 重生成 / 跳过）</div>

        <div v-for="s in onboardSteps" :key="s.key" class="card" :class="{ skipped: s.skipped }">
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
            <textarea v-model="s.result.content" class="result-edit" rows="8"></textarea>
            <div class="step-foot">
              <span class="result-path"><span class="mono">{{ s.result.path }}</span> · {{ s.result.words }} 字</span>
              <button class="btn primary" @click="onboardSave(s)">💾 保存编辑</button>
            </div>
          </template>
        </div>

        <p v-if="error" class="error">{{ error }}</p>
        <p v-if="savedMsg" class="saved-msg">{{ savedMsg }}</p>
        <div class="btn-row" style="justify-content:flex-end">
          <button class="btn primary" @click="finishOnboard">完成 → 进单书</button>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.book-new {
  margin: 0 auto;
}
.book-new-form {
  padding: 4px 16px;
  display: block;
}
.book-new .sfield input,
.book-new .sfield textarea {
  width: 100%;
}
.seg {
  display: inline-flex;
  gap: 6px;
  flex: 1;
}
.seg button {
  padding: 6px 16px;
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
.dir-preview {
  flex: 1;
  margin: 0;
  padding: 8px 10px;
  background: var(--paper);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--text-2);
  line-height: 1.7;
  white-space: pre-wrap;
}
.leads {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  flex: 1;
}
.lead {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  cursor: pointer;
  color: var(--ink);
}
.lead input {
  accent-color: var(--ink-cyan);
}
.host {
  display: flex;
  gap: 16px;
  font-size: 13px;
  flex: 1;
  align-items: center;
}
.host-active {
  color: var(--ink-cyan);
  font-weight: 600;
}
.host-disabled {
  color: var(--text-3);
}
.error {
  color: var(--cinnabar);
  font-size: 13px;
  margin: 12px 0;
}
.saved-msg {
  color: var(--ink-cyan);
  font-size: 13px;
  margin: 8px 0;
}
.step-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.step-label {
  font-weight: 600;
  font-size: 13px;
  color: var(--ink);
}
.step-ops {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.result-edit {
  width: 100%;
  box-sizing: border-box;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  font-family: inherit;
  resize: vertical;
  background: var(--paper);
  color: var(--ink);
}
.step-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}
.result-path {
  font-size: 11px;
  color: var(--text-3);
}
.mono {
  font-family: ui-monospace, monospace;
}
.card.skipped {
  opacity: 0.55;
}
</style>
