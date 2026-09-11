<script setup lang="ts">
// 单张档位卡（R0912-C2-P3-2，2026-09-12 独立重评修复批：自 TierSection 三处逐字同构
// 模板收敛，纯结构去重——DOM 结构/类名/样式值/事件语义逐像素不变，差异面经 props 传）。
// 卡内控件语言（图标 chip + 药丸开关 + 单行字段）与停用回落语义见 TierSection 头注。
// 草稿对象与父层共享引用，v-model 直接写属性（原实现同语义）；超时输入 @change 失焦
// 校验（低-5）与 ms→分钟换算自 TierSection 原样搬入。
import type { Component } from 'vue'
import type { TierSlot } from '../../api/providers'
import type { ModelOption } from '../../stores/provider'

// withDefaults 的 switchOn: undefined 先例同 CollapseSection 的 open: undefined——
// 显式 default undefined 抑制 Vue 对缺省 Boolean prop 的 false cast（resolveProps
// isAbsent && !hasDefault → false），保住「未传 = 常开档（无开关）」的三态语义。
withDefaults(
  defineProps<{
    /** 档位名（创作档 / 助手档 / 对话档） */
    title: string
    /** 标题行图标（PenLine / Sparkles / MessageCircle，由父层传组件） */
    icon: Component
    /** 描述文案（启停态相关的文案由父层算好传入） */
    desc: string
    /** 创作档 = true：标题行图标 accent 强调（三卡唯一强调位） */
    primary?: boolean
    /** 档位开关态；undefined = 无开关（创作档常开，不渲染 switch、无 off/dim/disabled）；
     *  false = 已停用（卡片 off + 字段 dim + 控件 disabled，回落创作档） */
    switchOn?: boolean | undefined
    /** 档位草稿（父层对象引用，v-model 直接写属性）；null = 未配置 → 回落「沿用创作档」 */
    tier: TierSlot | null
    /** 当前供应商的模型清单（= 已配置模型行，value=id/label=显示名） */
    models: ModelOption[]
  }>(),
  { primary: false, switchOn: undefined },
)

const emit = defineEmits<{
  toggle: [on: boolean]
}>()

/** P10：ms → 分钟输入显示（空 = 未设；非整分保留 1 位小数） */
function msToMinInput(ms: number | undefined | null): string {
  if (!ms) return ''
  const min = ms / 60000
  return Number.isInteger(min) ? String(min) : String(Math.round(min * 10) / 10)
}
/** P10：分钟输入 → ms（空/非法 = 清除该档超时，回落全局默认）。
 *  低-5（第十轮）：绑定 @change（失焦/回车才校验）——原来 @input 逐键触发，输入
 *  小数/删改中间态（如 "0.5" 敲到 "0."）当场被当非法清空，几乎无法直接输入小数值 */
function onTimeout(slot: TierSlot, ev: Event): void {
  const v = (ev.target as HTMLInputElement).value.trim()
  if (!v) {
    delete slot.timeoutMs
    return
  }
  const min = Number(v)
  if (!Number.isFinite(min) || min <= 0) {
    // 非法输入不落值（等价于清空），下次合法输入再写
    ev.target instanceof HTMLInputElement && (ev.target.value = '')
    delete slot.timeoutMs
    return
  }
  slot.timeoutMs = Math.round(min * 60000)
}
</script>

<template>
  <div class="tier-card" :class="{ primary, off: switchOn === false }">
    <div class="tier-head">
      <span class="tier-icon"><component :is="icon" :size="14" /></span>
      <span class="tier-name">{{ title }}</span>
      <span class="tier-desc">{{ desc }}</span>
      <label v-if="switchOn !== undefined" class="switch tier-switch">
        <input type="checkbox" :checked="switchOn" @change="emit('toggle', ($event.target as HTMLInputElement).checked)" />
        <span class="switch-slider"></span>
      </label>
    </div>
    <div class="tier-fields" :class="{ dim: switchOn === false }">
      <span class="tier-field-label">模型</span>
      <template v-if="tier">
        <select v-model="tier.model" class="tier-select" :disabled="switchOn === false">
          <option value="" disabled>{{ models.length ? '选择模型' : '请先在提供方中添加模型' }}</option>
          <option v-for="m in models" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
        <div class="tier-side">
          <label class="tier-timeout">
            <span class="tier-timeout-label">超时</span>
            <input
              :value="msToMinInput(tier.timeoutMs)"
              type="text"
              inputmode="decimal"
              placeholder="默认"
              class="tier-timeout-input"
              :disabled="switchOn === false"
              @change="onTimeout(tier, $event)"
            />
            <span class="tier-timeout-suffix">分</span>
          </label>
          <label class="tier-effort">
            <span class="tier-field-hint">推理</span>
            <select v-model="tier.effort" class="tier-effort-select" :disabled="switchOn === false">
              <option value="max">max</option>
              <option value="xhigh">xhigh</option>
              <option value="high">high</option>
              <option value="medium">medium</option>
              <option value="low">low</option>
            </select>
          </label>
        </div>
      </template>
      <select v-else class="tier-select" disabled>
        <option>沿用创作档</option>
      </select>
    </div>
  </div>
</template>

<style scoped>
/* 卡片族样式（R0912-C2-P3-2 自 TierSection 原样搬入，纯搬家）：白色小卡与
 * 提供方行卡同语言；.switch/.switch-slider 复用 SettingsModal 全局样式。 */
.tier-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-l);
  background: var(--background-primary);
}
/* 停用档：边框退淡 + 标题行黯淡（字段收起、露出回落说明） */
.tier-card.off {
  border-color: color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
}
.tier-card.off .tier-head {
  opacity: 0.55;
}

.tier-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
/* 图标 chip：与行卡头像同语言（圆角块 + 淡底） */
.tier-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-m);
  flex-shrink: 0;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  color: var(--text-muted);
}
/* 创作档：唯一的 accent 强调位 */
.tier-card.primary .tier-icon {
  background: color-mix(in srgb, var(--interactive-accent) 13%, transparent);
  border-color: transparent;
  color: var(--text-accent);
}
.tier-name {
  font-size: var(--font-size-s);
  font-weight: 700;
  line-height: 17px;
  color: var(--text-normal);
  white-space: nowrap;
}
/* 描述并进标题行：占位伸缩 + 截断，开关始终贴右 */
.tier-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 16px;
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
}
.tier-switch {
  margin-left: auto;
  flex-shrink: 0;
}

/* ── 字段行：永不换行（模型收缩兜底）；三控件统一 28px 高 + 同描边 ──
 * 满配行（创作档）四件最小合计须 ≤ 两列卡内容区 ~320px：模型下拉 100 +
 * 超时组 ~85 + 推理组 ~80 + 标签 26 + 三个 gap 5×3——超 1px 即推理组
 * （flex-shrink:0）被顶出卡右缘截字，压缩时以「占位文字完整显示」为下限。 */
.tier-fields {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 5px;
}
/* 停用档字段：整组退灰不可点——开关开/关一眼有别 */
.tier-fields.dim {
  opacity: 0.55;
  filter: grayscale(0.3);
  pointer-events: none;
}
/* 字段名「模型」——正式标签，不用灰色说明文字的淡色 */
.tier-field-label {
  font-size: var(--font-size-xxs);
  font-weight: 500;
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}
/* 组内前缀说明（推理，与「超时」同语言的淡色） */
.tier-field-hint {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  white-space: nowrap;
}
/* 右侧组：超时 + 推理等级贴右缘，与模型下拉之间留弹性空隙 */
.tier-side {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
}
/* appearance:none + 自绘箭头：原生控件文字位置由系统绘制、行高只能部分干预，
 * 去掉原生外观后文字定位完全归 CSS——水平垂直都能精确居中 */
.tier-select {
  appearance: none;
  -webkit-appearance: none;
  height: 24px;
  line-height: 22px;
  box-sizing: border-box;
  /* 空间不够时模型下拉自己收缩（推理等级不缩），二者保持并排 */
  /* 文字水平居中的基准 = 左边框到箭头左缘：箭头 10px 宽、距右缘 7px，
   * 故右内边距 = 左内边距 + 17px，两侧视觉间距严格相等 */
  flex: 0 1 auto;
  width: auto;
  min-width: 100px;
  max-width: 100%;
  padding: 0 25px 0 8px;
  text-align: center;
  text-align-last: center;
  font-size: var(--font-size-xs);
  color: var(--text-normal);
  background-color: var(--background-secondary);
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 7px center;
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.tier-select:focus {
  outline: none;
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
/* ── P10 超时输入：与下拉同语言的描边控件（超时 [输入] 分），行尾 ── */
.tier-timeout {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 6px;
  flex-shrink: 0;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.tier-timeout:focus-within {
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.tier-timeout-label,
.tier-timeout-suffix {
  font-size: var(--font-size-xxs);
  color: var(--text-faint);
  white-space: nowrap;
}
.tier-timeout-input {
  width: 32px;
  height: 22px;
  line-height: 22px;
  padding: 0;
  border: none;
  text-align: center;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-normal);
  background: transparent;
}
.tier-timeout-input:focus {
  outline: none;
}
/* ── 推理等级：与超时同语言的描边组，紧挨模型下拉右侧 ── */
.tier-effort {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 2px 0 6px;
  flex-shrink: 0;
  background: var(--background-secondary);
  border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-m);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.tier-effort:focus-within {
  border-color: var(--interactive-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 18%, transparent);
}
.tier-effort-select {
  appearance: none;
  -webkit-appearance: none;
  height: 22px;
  line-height: 22px;
  /* 同模型下拉：居中基准到箭头左缘（箭头 10px 贴右），右内边距 = 左 + 9 */
  padding: 0 11px 0 2px;
  font-size: var(--font-size-xs);
  color: var(--text-normal);
  background-color: transparent;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right center;
  border: none;
  text-align: center;
  text-align-last: center;
  cursor: pointer;
}
.tier-effort-select:focus {
  outline: none;
}
</style>
