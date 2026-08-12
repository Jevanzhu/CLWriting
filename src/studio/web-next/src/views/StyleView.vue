<script setup lang="ts">
// 文风视图（StyleView 拆分 P2-5 编排壳）：定标 / 条目库 / 候选箱 / 验收 四段式。
// 四段拆为独立子组件（StyleBaselineCard / StyleEntryPanel / StyleCandidateBox / StyleAcceptancePanel），
// 通过 style store 共享数据；本文件只留加载编排 + 四段布局。
import { onMounted, watch } from 'vue'
import { useStyleStore } from '../stores/style'
import { useUiStore } from '../stores/ui'
import { friendlyError } from '../shared/error'
import StyleBaselineCard from '../components/style/StyleBaselineCard.vue'
import StyleEntryPanel from '../components/style/StyleEntryPanel.vue'
import StyleCandidateBox from '../components/style/StyleCandidateBox.vue'
import StyleAcceptancePanel from '../components/style/StyleAcceptancePanel.vue'

const props = defineProps<{ bookName: string }>()
const style = useStyleStore()
const ui = useUiStore()

// ── 加载（切书/进视图；迁移发生时 toast 告知）──
async function load(): Promise<void> {
  try {
    const migration = await style.load(props.bookName)
    if (migration) {
      ui.toast(`文风库已升级：${migration.migrated}项旧数据迁入条目库`, 'success')
    }
  } catch (e) {
    ui.toast(friendlyError(e), 'error')
  }
}
onMounted(load)
watch(() => props.bookName, load)
</script>

<template>
  <div class="sv-scroll">
    <div class="sv">
      <StyleBaselineCard :book-name="bookName" />
      <StyleEntryPanel />
      <StyleCandidateBox />
      <StyleAcceptancePanel :book-name="bookName" />
    </div>
  </div>
</template>

<style scoped>
.sv-scroll {
  height: 100%;
  overflow: auto;
  padding: var(--size-4-5) var(--size-4-6);
}
.sv {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-4);
  max-width: 940px;
  margin: 0 auto;
}
</style>
