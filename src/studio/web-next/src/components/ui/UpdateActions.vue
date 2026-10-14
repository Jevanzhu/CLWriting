<script setup lang="ts">
// 更新动作组（状态行 + 按钮组单一来源）：顶栏角标的弹层与「设置·关于」页共用——
// 标签/出口只有这里一份，两处渲染面不再各写一套按钮（防漂移）。
// 数据与动作全在 stores/update，本件零 props。
import { X } from 'lucide-vue-next'
import { useUpdateStore } from '../../stores/update'

const u = useUpdateStore()
</script>

<template>
  <div class="ua">
    <p v-if="u.showAttempt && u.attemptText" class="ua-attempt">
      <span>{{ u.attemptText }}</span>
      <button class="ua-attempt-x" title="知道了" aria-label="知道了" @click="u.hideAttempt()">
        <X :size="12" />
      </button>
    </p>
    <p v-if="u.statusText" class="ua-status">{{ u.statusText }}</p>
    <div class="ua-btns">
      <button v-if="u.primaryAction" class="ua-primary" @click="u.primaryAction.run()">
        {{ u.primaryAction.label }}
      </button>
      <button v-if="u.showDownloadLink" class="ua-open" @click="u.openDownload()">
        {{ u.copied ? '链接已复制' : '去下载' }}
      </button>
      <button v-if="u.showDismiss" class="ua-dismiss" @click="u.dismissUpdate()">忽略此版本</button>
    </div>
  </div>
</template>

<style scoped>
.ua {
  display: flex;
  flex-direction: column;
  gap: var(--size-4-1);
}
.ua-attempt {
  display: flex;
  align-items: flex-start;
  gap: var(--size-4-1);
  margin: 0;
  font-size: var(--font-size-s);
  color: var(--text-warning);
}
.ua-attempt-x {
  flex: none;
  display: flex;
  align-items: center;
  padding: 1px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.ua-attempt-x:hover {
  background: var(--background-modifier-hover);
}
.ua-status {
  margin: 0;
  font-size: var(--font-size-s);
  color: var(--text-muted);
}
.ua-btns {
  display: flex;
  align-items: center;
  gap: var(--size-4-2);
  margin-top: 2px;
}
.ua-btns button {
  flex: none;
  padding: 4px 10px;
  font-size: var(--font-size-s);
  border-radius: var(--radius-s);
  cursor: pointer;
}
.ua-primary {
  border: 1px solid var(--text-accent);
  background: var(--text-accent);
  color: var(--text-on-accent);
}
.ua-primary:hover {
  filter: brightness(1.08);
}
.ua-open {
  border: 1px solid var(--text-accent);
  background: var(--background-primary);
  color: var(--text-accent);
}
.ua-open:hover {
  background: var(--background-modifier-hover);
}
.ua-dismiss {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
}
.ua-dismiss:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
</style>
