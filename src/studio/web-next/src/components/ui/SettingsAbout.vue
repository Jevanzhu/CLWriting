<script setup lang="ts">
// 设置 · 关于页（全局）：当前版本 + 更新入口。
// 更新面与左栏角标同源（stores/update）——本页是「正统入口」：角标的「忽略此版本」
// 只静默角标，本页仍如实展示可更新状态与动作（预览通道开关将来的落点也在此页）。
import { useUpdateStore } from '../../stores/update'
import SettingItem from './SettingItem.vue'
import UpdateActions from './UpdateActions.vue'

const u = useUpdateStore()
</script>

<template>
  <div class="settings-tab">
    <div class="cfg-card-head">关于</div>
    <section class="cfg-card">
      <SettingItem name="当前版本" desc="应用版本号（更新检查与更新包按此比对）">
        <span class="about-version" data-testid="about-version">{{ u.version ?? '未知' }}</span>
      </SettingItem>
      <SettingItem
        name="更新"
        desc="有新版本时可在此下载；更新包就绪后，工作区左栏标题条「刷新目录」旁的角标可一键重启完成替换"
      >
        <div class="about-update">
          <UpdateActions />
          <span v-if="!u.latest && !u.showAttempt" class="about-idle">尚未发现新版本</span>
        </div>
      </SettingItem>
    </section>
  </div>
</template>

<style scoped>
.about-version {
  font-family: var(--font-monospace, ui-monospace, monospace);
  font-size: var(--font-size-m);
  color: var(--text-normal);
}
.about-update {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  max-width: 100%;
}
.about-idle {
  font-size: var(--font-size-s);
  color: var(--text-faint);
}
</style>
