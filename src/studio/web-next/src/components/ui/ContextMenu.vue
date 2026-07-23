<script lang="ts">
/** 通用右键菜单项（移植旧 TreeContextMenu，web-next token）。
 *  separator=true 分割线；submenu 非空时父级 hover 展开 ▸。 */
export interface MenuItem {
  key: string
  label: string
  danger?: boolean
  separator?: boolean
  submenu?: MenuItem[]
}
</script>

<script setup lang="ts">
// 纯展示：fixed 定位到坐标；透明遮罩捕获外部点击 + Esc 关闭；Teleport body 避免裁剪。
import { ref, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  visible: boolean
  x: number
  y: number
  items: MenuItem[]
}>()
const emit = defineEmits<{
  select: [key: string]
  close: []
}>()

const openSub = ref<string | null>(null)
watch(
  () => props.visible,
  (v) => {
    if (!v) openSub.value = null
  },
)

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

function onSelect(key: string): void {
  emit('select', key)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="cm-mask"
      @click="emit('close')"
      @contextmenu.prevent="emit('close')"
    >
      <div
        class="cm-menu"
        :style="{ left: x + 'px', top: y + 'px' }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <template v-for="(item, i) in items" :key="item.key || `sep-${i}`">
          <div v-if="item.separator" class="cm-sep"></div>
          <div
            v-else-if="item.submenu"
            class="cm-sub-wrap"
            @mouseenter="openSub = item.key"
            @mouseleave="openSub = null"
          >
            <button class="cm-item cm-has-sub">
              <span>{{ item.label }}</span>
              <span class="cm-caret">▸</span>
            </button>
            <div v-if="openSub === item.key" class="cm-submenu">
              <button
                v-for="sub in item.submenu"
                :key="sub.key"
                class="cm-item"
                :class="{ danger: sub.danger }"
                @click="onSelect(sub.key)"
              >
                {{ sub.label }}
              </button>
            </div>
          </div>
          <button
            v-else
            class="cm-item"
            :class="{ danger: item.danger }"
            @click="onSelect(item.key)"
          >
            {{ item.label }}
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cm-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.cm-menu {
  position: fixed;
  min-width: 168px;
  padding: 4px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  user-select: none;
}
.cm-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: var(--radius-s);
  cursor: pointer;
}
.cm-item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-normal);
}
.cm-item.danger {
  color: var(--text-error);
}
.cm-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--background-modifier-border);
}
.cm-sub-wrap {
  position: relative;
  padding-right: 4px;
}
.cm-has-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.cm-caret {
  font-size: 10px;
  color: var(--text-faint);
}
.cm-submenu {
  position: absolute;
  left: 100%;
  top: -4px;
  min-width: 140px;
  padding: 4px;
  margin-left: 2px;
  background: var(--background-primary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
}
</style>
