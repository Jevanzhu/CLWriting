<script setup lang="ts">
// 新建书（newbook）：段 1 表单 + 段 2 AI 填设定。对齐 mockup v5 renderNbForm / renderNbOnboard。
// 表单/段 2 态走 useNewbookStore；currentLib（desktop 书库）留 page。
import { ref, computed, onMounted } from 'vue'
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

// 当前书库（段 1 副标题显示所属书库；desktop getCurrentLibrary 取，浏览器版 fallback）
const currentLib = ref('当前书库')
onMounted(async () => {
  try {
    const p = await window.clwritingDesktop?.getCurrentLibrary()
    if (p) currentLib.value = p
  } catch {
    /* 浏览器版无 desktop IPC */
  }
})

// actions 直接从 store 取（Pinia 已绑 this）；表单态 + 段 2 步骤集已内聚进 store
const { submit, onboardRun, onboardSave, toggleLead } = newbook

const EXTENDED_LEADS = ['局线', '设定线', '成长线', '关系债']

/** 完成 → 进单书（路由跳转留 page，状态不进 store） */
function finishOnboard(): void {
  router.push(`/books/${encodeURIComponent(createdName.value)}`)
}

// kind 切换实时预览长/短篇目录结构差异
const dirPreview = computed(() =>
  kind.value === 'short'
    ? ['篇/NNN-标题/正文.md（每篇独立）', '定稿/设定/（角色·境界·集子定位）', '文风/（样章·铁律·金句，整集共享）', '工作区/']
    : ['定稿/正文/章号-标题.md（每章一文件）', '大纲/（总纲·卷纲·账本类）', '定稿/设定/（角色·境界·世界观）', '文风/（样章·铁律·金句）', '工作区/'],
)
const canSubmit = computed(() => name.value.trim().length > 0 && !submitting.value)
</script>

<template>
  <div class="workspace full">
    <!-- 段 1：init 表单 -->
    <div v-if="phase === 'form'" class="shelf-inner" style="max-width:720px">
      <button class="btn" style="margin-bottom:18px" @click="router.push('/shelf')">← 返回</button>
      <div class="shelf-title">新建书籍</div>
      <div class="panel-sub" style="margin:6px 0 22px">所属书库：{{ currentLib }}</div>

      <form class="card" style="padding:18px 20px" @submit.prevent="submit">
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
          <div class="nb-leads">
            <label v-for="l in EXTENDED_LEADS" :key="l" class="nb-lead">
              <input type="checkbox" :checked="leads.includes(l)" @change="toggleLead(l)" /> {{ l }}
            </label>
          </div>
        </div>
        <div class="sfield">
          <label>AI 宿主</label>
          <div class="nb-host">
            <span class="host-on">⚡ Claude Code (cc)</span>
            <span class="host-off" title="首版暂不支持">Codex（暂未支持）</span>
          </div>
        </div>
      </form>

      <p v-if="error" style="color:var(--cinnabar);font-size:13px;margin:12px 0">{{ error }}</p>
      <div class="btn-row" style="justify-content:flex-end">
        <button class="btn primary" :disabled="!canSubmit" @click="submit">
          {{ submitting ? '创建中…' : '创建 → 进段 2' }}
        </button>
      </div>
    </div>

    <!-- 段 2：AI 填设定 -->
    <div v-else class="shelf-inner" style="max-width:780px">
      <button class="btn" style="margin-bottom:18px" @click="router.push('/shelf')">← 返回书架</button>
      <div class="shelf-title">段 2 · AI 填设定</div>
      <div class="panel-sub" style="margin:6px 0 22px">
        《{{ createdName }}》已创建 · 让 AI 据题材填设定（每步可生成 / 编辑 / 重生成 / 跳过）
      </div>

      <div v-for="s in onboardSteps" :key="s.key" class="card nb-step" :class="{ skipped: s.skipped }">
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
          <textarea v-model="s.result.content" class="result-edit" rows="6"></textarea>
          <div class="step-foot">
            <span class="result-path">{{ s.result.path }} · {{ s.result.words }} 字</span>
            <button class="btn primary" @click="onboardSave(s)">💾 保存编辑</button>
          </div>
        </template>
      </div>

      <p v-if="error" style="color:var(--cinnabar);font-size:13px;margin:12px 0">{{ error }}</p>
      <p v-if="savedMsg" style="color:var(--ink-cyan);font-size:13px;margin:8px 0">{{ savedMsg }}</p>
      <div class="btn-row" style="justify-content:flex-end">
        <button class="btn primary" @click="finishOnboard">完成 → 进单书</button>
      </div>
    </div>
  </div>
</template>
