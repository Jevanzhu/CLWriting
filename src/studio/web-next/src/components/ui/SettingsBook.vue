<script setup lang="ts">
// 设置 · 书籍 tab：书名/题材/每卷章数/写作模式/目标字数/书库目录。
import { ref, computed, watch, inject } from 'vue'
import { BookOpen } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { getConfig } from '../../api/books'
import { SAVE_CONFIG_KEY } from './settings-context'

const ui = useUiStore()
const ws = useWorkspaceStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)
const hasBook = computed(() => !!ws.bookName)

const bookTitle = ref('')
const bookGenre = ref('')
const bookKind = ref<'long' | 'short'>('long')
const volumeSize = ref<number | null>(null)
const targetWords = ref<number | null>(null)
const chapterTargetWords = ref<number | null>(null)
const workflow = ref<'free' | 'assist' | 'strict'>('free')

async function openBookDir(): Promise<void> {
  if (!ws.bookName) return
  await window.clwritingDesktop?.openBookDir(ws.bookName)
}

watch(
  () => [ui.settingsOpen, ws.bookName] as const,
  async ([open, name]) => {
    if (!open || !name) return
    try {
      const cfg = await getConfig(name)
      bookTitle.value = cfg.book?.title ?? ''
      bookGenre.value = cfg.book?.genre ?? ''
      bookKind.value = cfg.kind ?? 'long'
      volumeSize.value = cfg.book?.volume_size ?? null
      workflow.value = cfg.workflow ?? 'free'
      targetWords.value = cfg.book?.target_words ?? null
      chapterTargetWords.value = cfg.book?.chapter_target_words ?? null
    } catch {
      /* 读不到就用默认值展示 */
    }
  },
  { immediate: true },
)

function onBookTitleChange(): void {
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.title = bookTitle.value
  })
}
function onBookGenreChange(): void {
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.genre = bookGenre.value
  })
}
function onVolumeSizeInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  volumeSize.value = Number.isFinite(raw) && raw >= 5 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.volume_size = volumeSize.value ?? undefined
  })
}
function onTargetWordsInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  targetWords.value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.target_words = targetWords.value ?? undefined
  })
}
function onChapterTargetInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  chapterTargetWords.value = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null
  void saveConfig((c) => {
    if (!c.book) c.book = {}
    c.book.chapter_target_words = chapterTargetWords.value ?? undefined
  })
}
function setWorkflow(mode: 'free' | 'assist' | 'strict'): void {
  workflow.value = mode
  void saveConfig((c) => {
    c.workflow = mode
  })
}
</script>

<template>
  <div v-if="!hasBook" class="empty-tab">
    <BookOpen :size="28" />
    <p>请先打开一本书</p>
  </div>
  <template v-else>
    <div class="book-banner">
      <BookOpen :size="16" />
      <span>{{ ws.bookName }}</span>
    </div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">书名</div>
          <div class="setting-item-desc">显示在书架和标题栏</div>
        </div>
        <div class="setting-item-control">
          <input v-model="bookTitle" class="text-input" type="text" placeholder="书名" @change="onBookTitleChange" />
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">题材</div>
          <div class="setting-item-desc">影响 AI 写作风格和检查规则</div>
        </div>
        <div class="setting-item-control">
          <input v-model="bookGenre" class="text-input" type="text" placeholder="题材" @change="onBookGenreChange" />
        </div>
      </div>
      <div v-if="bookKind !== 'short'" class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">每卷章数</div>
          <div class="setting-item-desc">每卷容纳的章节数量，影响节奏预测</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="5" max="100" step="1" placeholder="未设" :value="volumeSize ?? ''" @change="onVolumeSizeInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">写作模式</div>
          <div class="setting-item-desc">控制 AI 辅助的门禁强度</div>
        </div>
        <div class="setting-item-control">
          <div class="seg">
            <button :class="{ on: workflow === 'free' }" @click="setWorkflow('free')">自由</button>
            <button :class="{ on: workflow === 'assist' }" @click="setWorkflow('assist')">辅助</button>
            <button :class="{ on: workflow === 'strict' }" @click="setWorkflow('strict')">严格</button>
          </div>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">目标字数</div>
          <div class="setting-item-desc">全书完稿目标，用于进度追踪</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="0" step="1000" placeholder="未设" :value="targetWords ?? ''" @change="onTargetWordsInput($event)" />
          <span class="val-suffix">字</span>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">每章字数</div>
          <div class="setting-item-desc">新建章节的默认字数目标；单章可单独覆盖</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="0" step="100" placeholder="未设" :value="chapterTargetWords ?? ''" @change="onChapterTargetInput($event)" />
          <span class="val-suffix">字</span>
        </div>
      </div>
      <div v-if="hasDesktop" class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">书库目录</div>
          <div class="setting-item-desc">在文件管理器中打开</div>
        </div>
        <div class="setting-item-control">
          <button class="link-btn" @click="openBookDir">打开</button>
        </div>
      </div>
    </section>
  </template>
</template>
