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
// R0912-C2-P3-2（2026-09-12 独立重评修复批）：三张 tier-card 模板逐字同构 → 收敛为
// TierCard 子组件（差异面经 props 传：标题/图标/描述/开关态/草稿引用）。DOM 逐像素不变。
import TierCard from './TierCard.vue'

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
      <!-- 创作档：常开，accent 图标（无开关 → TierCard 不渲染 switch、无停用态） -->
      <TierCard
        title="创作档"
        :icon="PenLine"
        desc="写正文 / 改写 / 大纲"
        primary
        :tier="tierForm.creative"
        :models="currentModels"
      />
      <!-- 助手档：可停用（关 = 字段置灰不可选，回落创作档） -->
      <TierCard
        title="助手档"
        :icon="Sparkles"
        :desc="assistantEnabled ? '三审 / 分析' : '已停用 · 沿用创作档'"
        :switch-on="assistantEnabled"
        :tier="tierForm.assistant"
        :models="currentModels"
        @toggle="emit('toggle-assistant', $event)"
      />
      <!-- 对话档：可停用（关 = 字段置灰不可选，回落创作档） -->
      <TierCard
        title="对话档"
        :icon="MessageCircle"
        :desc="chatTierEnabled ? '对话助手' : '已停用 · 沿用创作档'"
        :switch-on="chatTierEnabled"
        :tier="tierForm.chat"
        :models="currentModels"
        @toggle="emit('toggle-chat', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
/* 共享控件语言（group-title/add-btn/save-btn 胶囊/spin）在 styles/providers.css；
 * 药丸开关 .switch/.switch-slider 复用 SettingsModal 全局样式。 */

/* ── 分区：不加底色不画线——纯大间距与上方提供方列表区分 ──
 * R72-12（二十轮 E-8）：140px 为刻意留白——任务档位区须在视觉上与「提供方列表」
 * 明确分离（上方列表高度随条数伸缩，无固定锚点可流式对齐），取整屏约 1/10 的
 * 固定间距。若未来上方改为可收起容器，应同步改成流式间距并删此注。 */
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

/* ── 档位网格：白色小卡（与提供方行卡同卡片语言）──
 * 列宽下限 340 = 满配行（创作档：模型标签 20 + 下拉收缩下限 100 + 超时/推理组
 * ~176 + gap 15 ≈ 311）+ 卡内边距 20 + 余量——低于此值行必然溢出卡缘（推理组
 * flex-shrink:0 顶破右缘）。容器不足两列（≥696）时 auto-fit 自然单列，宽容器
 * 仍两列且每列放得下满配行。 */
.tier-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: var(--size-4-3) var(--size-4-4);
}
/* 档位卡本体样式（tier-card/tier-head/字段行/下拉/超时/推理族）已随 R0912-C2-P3-2
 * 抽取搬入 TierCard.vue scoped 块（原样搬家，值不变）。 */
</style>
