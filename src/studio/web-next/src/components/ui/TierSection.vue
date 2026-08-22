<script setup lang="ts">
// 任务档位区（阶段 14 + P10 超时 ms 输入）。
// 档位草稿/启停开关由父层持有（refresh 会整体重置），本组件只做受控渲染 + 事件上抛；
// 模型下拉选项 = 已配置模型行（本地声明，不打上游网关）；保存在父层编排。
// 卡片视觉：纯大间距与上方提供方列表分区（不画线不加底色）；白色小卡与行卡同语言——
// 图标 chip + 药丸开关（复用 SettingsModal 全局 .switch 语言）；描述并进标题行；
// 字段单行（永不换行，模型下拉可收缩兜底）：模型居左，超时 + 推理等级贴右缘；
// 停用 = 字段置灰不可选 + 描述换「已停用 · 沿用创作档」（保存写 null，运行回落创作档）。
// 保存按钮在分组标题行右侧（卡片群右上角，providers.css 共享 .save-btn 胶囊）。
import { Loader2, PenLine, Sparkles, MessageCircle } from 'lucide-vue-next'
import type { TierSlot } from '../../api/providers'
import type { ModelOption } from '../../stores/provider'

defineProps<{
  /** 档位草稿（对象引用与父层共享，v-model 直接写属性——原实现同语义） */
  tierForm: { creative: TierSlot; assistant: TierSlot | null; chat: TierSlot | null }
  assistantEnabled: boolean
  chatTierEnabled: boolean
  /** 当前供应商的模型清单（= 已配置模型行，value=id/label=显示名；不打上游网关） */
  currentModels: ModelOption[]
  tierSaving: boolean
}>()

const emit = defineEmits<{
  'toggle-assistant': [on: boolean]
  'toggle-chat': [on: boolean]
  'save-tiers': []
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
  <div class="tier-section">
    <div class="tier-head-block">
      <div>
        <div class="group-title">
          <span class="group-title-text">任务档位</span>
        </div>
        <p class="group-intro">按任务类型分档选模型；停用或未配置的档位自动沿用创作档。</p>
      </div>
      <button class="save-btn" :disabled="tierSaving" @click="emit('save-tiers')">
        <Loader2 v-if="tierSaving" :size="14" class="spin" /> 保存档位
      </button>
    </div>

    <div class="tier-grid">
      <!-- 创作档：常开，accent 图标 -->
      <div class="tier-card primary">
        <div class="tier-head">
          <span class="tier-icon"><PenLine :size="14" /></span>
          <span class="tier-name">创作档</span>
          <span class="tier-desc">写正文 / 改写 / 大纲</span>
        </div>
        <div class="tier-fields">
          <span class="tier-field-label">模型</span>
          <select v-model="tierForm.creative.model" class="tier-select">
            <option value="" disabled>{{ currentModels.length ? '选择模型' : '请先在提供方中添加模型' }}</option>
            <option v-for="m in currentModels" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
          <div class="tier-side">
            <label class="tier-timeout">
              <span class="tier-timeout-label">超时</span>
              <input
                :value="msToMinInput(tierForm.creative.timeoutMs)"
                type="text"
                inputmode="decimal"
                placeholder="默认"
                class="tier-timeout-input"
                @change="onTimeout(tierForm.creative, $event)"
              />
              <span class="tier-timeout-suffix">分</span>
            </label>
            <label class="tier-effort">
              <span class="tier-field-hint">推理</span>
              <select v-model="tierForm.creative.effort" class="tier-effort-select">
                <option value="max">max</option>
                <option value="xhigh">xhigh</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      <!-- 助手档：可停用（关 = 字段置灰不可选，回落创作档） -->
      <div class="tier-card" :class="{ off: !assistantEnabled }">
        <div class="tier-head">
          <span class="tier-icon"><Sparkles :size="14" /></span>
          <span class="tier-name">助手档</span>
          <span class="tier-desc">{{ assistantEnabled ? '三审 / 分析' : '已停用 · 沿用创作档' }}</span>
          <label class="switch tier-switch">
            <input type="checkbox" :checked="assistantEnabled" @change="emit('toggle-assistant', ($event.target as HTMLInputElement).checked)" />
            <span class="switch-slider"></span>
          </label>
        </div>
        <div class="tier-fields" :class="{ dim: !assistantEnabled }">
          <span class="tier-field-label">模型</span>
          <template v-if="tierForm.assistant">
            <select v-model="tierForm.assistant.model" class="tier-select" :disabled="!assistantEnabled">
              <option value="" disabled>{{ currentModels.length ? '选择模型' : '请先在提供方中添加模型' }}</option>
              <option v-for="m in currentModels" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <div class="tier-side">
              <label class="tier-timeout">
                <span class="tier-timeout-label">超时</span>
                <input
                  :value="msToMinInput(tierForm.assistant.timeoutMs)"
                  type="text"
                  inputmode="decimal"
                  placeholder="默认"
                  class="tier-timeout-input"
                  :disabled="!assistantEnabled"
                  @change="onTimeout(tierForm.assistant, $event)"
                />
                <span class="tier-timeout-suffix">分</span>
              </label>
              <label class="tier-effort">
                <span class="tier-field-hint">推理</span>
                <select v-model="tierForm.assistant.effort" class="tier-effort-select" :disabled="!assistantEnabled">
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

      <!-- 对话档：可停用（关 = 字段置灰不可选，回落创作档） -->
      <div class="tier-card" :class="{ off: !chatTierEnabled }">
        <div class="tier-head">
          <span class="tier-icon"><MessageCircle :size="14" /></span>
          <span class="tier-name">对话档</span>
          <span class="tier-desc">{{ chatTierEnabled ? '对话助手' : '已停用 · 沿用创作档' }}</span>
          <label class="switch tier-switch">
            <input type="checkbox" :checked="chatTierEnabled" @change="emit('toggle-chat', ($event.target as HTMLInputElement).checked)" />
            <span class="switch-slider"></span>
          </label>
        </div>
        <div class="tier-fields" :class="{ dim: !chatTierEnabled }">
          <span class="tier-field-label">模型</span>
          <template v-if="tierForm.chat">
            <select v-model="tierForm.chat.model" class="tier-select" :disabled="!chatTierEnabled">
              <option value="" disabled>{{ currentModels.length ? '选择模型' : '请先在提供方中添加模型' }}</option>
              <option v-for="m in currentModels" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <div class="tier-side">
              <label class="tier-timeout">
                <span class="tier-timeout-label">超时</span>
                <input
                  :value="msToMinInput(tierForm.chat.timeoutMs)"
                  type="text"
                  inputmode="decimal"
                  placeholder="默认"
                  class="tier-timeout-input"
                  :disabled="!chatTierEnabled"
                  @change="onTimeout(tierForm.chat, $event)"
                />
                <span class="tier-timeout-suffix">分</span>
              </label>
              <label class="tier-effort">
                <span class="tier-field-hint">推理</span>
                <select v-model="tierForm.chat.effort" class="tier-effort-select" :disabled="!chatTierEnabled">
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
    </div>
  </div>
</template>

<style scoped>
/* 共享控件语言（group-title/add-btn/save-btn 胶囊/spin）在 styles/providers.css；
 * 药丸开关 .switch/.switch-slider 复用 SettingsModal 全局样式。 */

/* ── 分区：不加底色不画线——纯大间距与上方提供方列表区分 ── */
.tier-section {
  display: grid;
  gap: var(--size-4-2);
  margin-top: 140px;
}

/* 头部区：左侧「标题 + 灰色说明」成列，保存按钮贴右——底沿对齐说明文字底沿 */
.tier-head-block {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--size-4-2);
}
/* 本组标题/说明去掉共享样式的 4px 光学内缩——与卡片网格共用同一边缘线，
 * 保存按钮右缘即与卡片右缘严格对齐 */
.tier-section .group-title,
.tier-section .group-intro {
  padding-left: 0;
  padding-right: 0;
}

/* ── 档位网格：白色小卡（与提供方行卡同卡片语言）；列宽下限 300 保证单行放得下 ── */
.tier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: var(--size-4-3) var(--size-4-4);
}
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

/* ── 字段行：永不换行（模型收缩兜底）；三控件统一 28px 高 + 同描边 ── */
.tier-fields {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
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
  min-width: 120px;
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
  gap: 5px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 8px;
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
  width: 36px;
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
  gap: 4px;
  height: 24px;
  box-sizing: border-box;
  padding: 0 2px 0 7px;
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
  /* 同模型下拉：居中基准到箭头左缘（箭头 10px 贴右），右内边距 = 左 + 10 */
  padding: 0 12px 0 2px;
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
