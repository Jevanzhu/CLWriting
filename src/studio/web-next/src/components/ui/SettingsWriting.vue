<script setup lang="ts">
// 设置 · 写作默认页（全局）：题材/每卷章数/目标字数/每章字数的全局默认。
// IA 重组后从「本书」页的书籍与目标子页拆出独立成页——本页只承载全局默认组（不依赖当前书），
// 本书独立设定在「本书」页的写作默认组；生效链 book.yaml book 段对应键 → 此处 → 硬编码回落。
import { LibraryBig } from 'lucide-vue-next'
import { usePrefsStore } from '../../stores/prefs'
import { parseNumericInput } from '../../shared/numeric-input'

// 全局默认值来自 prefs store（main.ts 在 mount 前 await init()，设置打开时必已就绪）
const prefs = usePrefsStore()

// ── 全局默认控件：直写 prefs store（clamp 在 store setter，防抖落 global.json）──

function onGlobalGenreInput(e: Event): void {
  prefs.setDefaultGenre((e.target as HTMLInputElement).value)
}
// R75-E-P3a：每卷章数改共享 helper——此前 `Number('')===0` 穿过 isFinite 闸，
// setDefaultVolumeSize(0) 被 store clamp 静默钳成 5（清空输入框反而落 5）；
// 空串/非数字不写。目标字数/每章字数不在此列：0 本身是「未设」合法语义
function onGlobalVolumeSizeInput(e: Event): void {
  const v = parseNumericInput(e)
  if (v !== null) prefs.setDefaultVolumeSize(v)
}
function onGlobalTargetWordsInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(raw)) prefs.setDefaultTargetWords(raw)
}
function onGlobalChapterTargetInput(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(raw)) prefs.setDefaultChapterTargetWords(raw)
}
</script>

<template>
  <!-- 单根包裹：多根 fragment 在 <Transition> 下无法动画（Vue warn） -->
  <div class="settings-tab">
    <div class="cfg-card-head">写作默认</div>
    <section class="cfg-card">
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">题材</div>
          <div class="setting-item-desc">未单独设定的书使用此默认题材，用于 AI 设定生成与总览回显</div>
        </div>
        <div class="setting-item-control">
          <label class="genre-field">
            <LibraryBig :size="14" aria-hidden="true" />
            <input class="text-input" type="text" placeholder="如：东方玄幻、都市异能" aria-label="题材（全局默认）" :value="prefs.defaultGenre" @change="onGlobalGenreInput($event)" />
          </label>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">每卷章数</div>
          <div class="setting-item-desc">每卷容纳的章节数量，影响节奏预测；仅长篇使用</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="5" max="500" step="1" aria-label="每卷章数（全局默认）" :value="prefs.defaultVolumeSize" @change="onGlobalVolumeSizeInput($event)" />
          <span class="val-suffix">章</span>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">目标字数</div>
          <div class="setting-item-desc">全书完稿目标，用于进度追踪；0 = 未设</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="0" step="1000" aria-label="目标字数（全局默认）" :value="prefs.defaultTargetWords" @change="onGlobalTargetWordsInput($event)" />
          <span class="val-suffix">字</span>
        </div>
      </div>
      <div class="setting-item">
        <div class="setting-item-info">
          <div class="setting-item-name">每章字数</div>
          <div class="setting-item-desc">写作进度目标 + 新章表单默认值，并作为 AI 写稿字数区间基准（±20%）；0 = 未设</div>
        </div>
        <div class="setting-item-control">
          <input class="num-input" type="number" min="0" step="100" aria-label="每章字数（全局默认）" :value="prefs.defaultChapterTargetWords" @change="onGlobalChapterTargetInput($event)" />
          <span class="val-suffix">字</span>
        </div>
      </div>
    </section>
  </div>
</template>
