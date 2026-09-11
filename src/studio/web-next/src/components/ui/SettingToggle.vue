<script setup lang="ts">
/**
 * 设置行开关形态：SettingItem 外壳 + label.switch 全套（checkbox + switch-slider，
 * 样式在 settings-shared.css）。原 15 处手写 switch 块收敛；checked 直传、change
 * 事件以 boolean 载荷发出（调用方原 `(e.target as HTMLInputElement).checked`
 * 解包收进本件）。aria-label 逐字保留由调用方传入；desc 含插值时同 SettingItem
 * 用 #desc 插槽透传。
 */
import SettingItem from './SettingItem.vue'

defineProps<{
  name: string
  desc?: string
  sub?: boolean
  /** 开关选中态（单向数据流：本件不自行翻转，由调用方 setter 决定去向） */
  checked: boolean
  /** 开关 input 的 aria-label（逐字保留原手写文案） */
  ariaLabel: string
}>()
const emit = defineEmits<{ (e: 'change', v: boolean): void }>()

function onToggle(e: Event): void {
  emit('change', (e.target as HTMLInputElement).checked)
}
</script>

<template>
  <SettingItem :name="name" :desc="desc" :sub="sub">
    <template v-if="$slots.desc" #desc><slot name="desc" /></template>
    <label class="switch">
      <input type="checkbox" :aria-label="ariaLabel" :checked="checked" @change="onToggle" />
      <span class="switch-slider"></span>
    </label>
  </SettingItem>
</template>
