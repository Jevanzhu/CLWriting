<script setup lang="ts">
// 设置 · 书籍 tab：书名/题材/每卷章数/写作模式/目标字数/书库目录。
// 书名改动走全量改名（POST /rename：磁盘目录 + books.jsonl 登记 + active 指针 + book.yaml title 同步），
// 成功后路由切到新名——防「书名/文件夹/登记名」三分歧。
import { ref, computed, watch, inject } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen } from 'lucide-vue-next'
import { useWorkspaceStore } from '../../stores/workspace'
import { useUiStore } from '../../stores/ui'
import { useDocStore } from '../../stores/doc'
import { getConfig, renameBook } from '../../api/books'
import { friendlyError } from '../../shared/error'
import { SAVE_CONFIG_KEY } from './settings-context'

const ui = useUiStore()
const ws = useWorkspaceStore()
const router = useRouter()
const doc = useDocStore()
const saveConfig = inject(SAVE_CONFIG_KEY)!

const hasDesktop = computed(() => typeof window !== 'undefined' && !!window.clwritingDesktop)
const hasBook = computed(() => !!ws.bookName)

const bookTitle = ref('')
const bookGenre = ref('')
const bookKind = ref<'long' | 'short'>('long')
const volumeSize = ref<number | null>(null)
const targetWords = ref<number | null>(null)
const chapterTargetWords = ref<number | null>(null)
/** 短篇严格模式：把短篇专属黄项提升为红项（book.yaml short.strict） */
const shortStrict = ref(false)
/** 打开设置时读到的书名基线：判断是否真的改了名（防同名重存触发无谓改名）。 */
const titleBaseline = ref('')

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
      titleBaseline.value = bookTitle.value
      bookGenre.value = cfg.book?.genre ?? ''
      bookKind.value = cfg.kind ?? 'long'
      volumeSize.value = cfg.book?.volume_size ?? null
      shortStrict.value = cfg.short?.strict ?? false
      targetWords.value = cfg.book?.target_words ?? null
      chapterTargetWords.value = cfg.book?.chapter_target_words ?? null
    } catch {
      /* 读不到就用默认值展示 */
    }
  },
  { immediate: true },
)

async function onBookTitleChange(): Promise<void> {
  const name = ws.bookName
  if (!name) return
  const next = bookTitle.value.trim()
  // 空书名 → 回退显示当前名（book.yaml 校验非空）
  if (!next) {
    bookTitle.value = titleBaseline.value
    return
  }
  if (next === titleBaseline.value) return
  // 改名 = 磁盘目录+登记+active 一起搬；先落盘未保存的正文编辑，
  // 防目录搬家后旧名 URL 404 导致编辑丢失
  await doc.flushDirty()
  try {
    const res = await renameBook(name, next)
    titleBaseline.value = res.name
    ui.toast('已保存', 'success')
    if (res.renamed && res.name !== name) {
      // 全量切换：路由换新名 → Book.vue watch 统一清 store / 载 prefs / seed 对话
      router.replace(`/book/${encodeURIComponent(res.name)}`)
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
    // 失败回退输入框为当前书名
    bookTitle.value = titleBaseline.value
  }
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
function onShortStrictToggle(e: Event): void {
  shortStrict.value = (e.target as HTMLInputElement).checked
  void saveConfig((c) => {
    if (!c.short) c.short = {}
    c.short.strict = shortStrict.value
  })
}
</script>

<template>
  <!-- 单根包裹：多根 fragment 在 <Transition> 下无法动画（Vue warn），且并行过渡时无动画可播 -->
  <div class="settings-tab">
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
      <div v-if="bookKind === 'short'" class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">短篇严格模式</div>
          <div class="setting-item-desc">把短篇专属黄项（字数/身体部位词/比喻/五段节数/开头钩子/反转线索/情绪曲线）提升为红项——机检红项会打回重写，过不了不交稿</div>
        </div>
        <div class="setting-item-control">
          <label class="switch">
            <input type="checkbox" aria-label="短篇严格模式" :checked="shortStrict" @change="onShortStrictToggle($event)" />
            <span class="switch-slider"></span>
          </label>
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
  </div>
</template>
