<script lang="ts">
/** 菜单项（FileTree 与本组件共用）。
 *  separator=true 渲染分割线；submenu 非空时作为父级（hover 展开 ▸，此时自身 key 无意义）。 */
export interface MenuItem {
  key: string
  label: string
  /** 删除类：cinnabar 红字。 */
  danger?: boolean
  /** 分割线（独立渲染）。 */
  separator?: boolean
  /** 子菜单（非空时该项作父级，hover 展开；子项 key 为实际动作）。 */
  submenu?: MenuItem[]
}
</script>

<script setup lang="ts">
// 文件树右键上下文菜单（块1）——纯展示组件，菜单项由 FileTree 按节点类型生成后传入。
// fixed 定位到鼠标坐标；透明遮罩捕获外部点击 + Esc 关闭；Teleport 到 body 避免 sider overflow 裁剪。
// 支持 submenu（hover ▸ 展开）与 separator 分组（Obsidian 式）。
// 视觉复用 .kind-menu/.kind-item（v5-components.css）：--panel 底 + --border 线 + --flat-hover hover。
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

/** 当前展开的子菜单父项 key（null = 无）。 */
const openSub = ref<string | null>(null)
// 菜单关闭时重置子菜单态（下次打开不残留）
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

/** 选中一项 → emit select + 关闭（子菜单子项与普通项共用）。 */
function onSelect(key: string): void {
  emit('select', key)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="cm-mask" @click="emit('close')" @contextmenu.prevent="emit('close')">
      <div
        class="cm-menu"
        :style="{ left: x + 'px', top: y + 'px' }"
        @click.stop
        @contextmenu.prevent.stop
      >
        <template v-for="(item, i) in items" :key="item.key || `sep-${i}`">
          <div v-if="item.separator" class="cm-sep"></div>
          <!-- 子菜单父项：hover 展开右侧浮层 -->
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
          <button v-else class="cm-item" :class="{ danger: item.danger }" @click="onSelect(item.key)">
            {{ item.label }}
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 遮罩：全屏透明，捕获外部点击/右键 → 关闭。z-index 高于 sider/content 浮层。 */
.cm-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
/* 菜单容器：复用 .kind-menu 变量（--panel/--border），补 fixed + 阴影。 */
.cm-menu {
  position: fixed;
  min-width: 168px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 7px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
  user-select: none;
}
/* 菜单项：复用 .kind-item 变量与过渡。 */
.cm-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 12px;
  font-size: 13px;
  color: var(--text-2);
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.cm-item:hover {
  background: var(--flat-hover);
  color: var(--ink);
}
.cm-item.danger {
  color: var(--cinnabar);
}
.cm-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--border);
}
/* 子菜单父项：label + ▸ 两端对齐；relative 承载子浮层。 */
.cm-sub-wrap {
  position: relative;
  padding-right: 4px; /* 透明桥接子菜单 gap，避免慢速 hover 移到子菜单时抖动 */
}
.cm-has-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.cm-caret {
  font-size: 10px;
  color: var(--text-3);
}
/* 子菜单浮层：父项右侧展开，同款 --panel/--border + 阴影。 */
.cm-submenu {
  position: absolute;
  left: 100%;
  top: -4px;
  min-width: 140px;
  padding: 4px;
  margin-left: 2px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 7px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.12);
}
</style>
