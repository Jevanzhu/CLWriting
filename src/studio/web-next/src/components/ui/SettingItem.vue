<script setup lang="ts">
/**
 * 设置行共享壳（settings-shared.css 的 .setting-item 族的模板面收敛）：
 * 10 个 Settings*.vue 里 55 处手写 setting-item 块的 DOM 外壳逐字搬入——
 * 结构/类名/层级与原模板一致（setting-item [sub] > setting-item-info >
 * setting-item-name / setting-item-desc + setting-item-control），控件本体
 * 经默认插槽进 setting-item-control（seg/num-input/select/FontPicker/chips 等原样）。
 * desc 为纯文本直传 prop；含模板插值的 desc 用 #desc 插槽透传（无 desc 的行
 * 不渲染 desc div，与原手写一致）。开关形态用 SettingToggle（本壳 + label.switch 全套）。
 */
defineProps<{
  /** 行名（setting-item-name 文本） */
  name: string
  /** 行描述（setting-item-desc 文本；纯文本——含插值时改用 #desc 插槽） */
  desc?: string
  /** 子选项行（追加 .sub 类：卡片内更大缩进，层级靠缩进表达） */
  sub?: boolean
}>()
</script>

<template>
  <div class="setting-item" :class="{ sub }">
    <div class="setting-item-info">
      <div class="setting-item-name">{{ name }}</div>
      <div v-if="desc || $slots.desc" class="setting-item-desc"><slot name="desc">{{ desc }}</slot></div>
    </div>
    <div class="setting-item-control">
      <slot />
    </div>
  </div>
</template>
