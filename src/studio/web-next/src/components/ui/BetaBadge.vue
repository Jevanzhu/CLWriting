<template>
  <span class="beta-badge" title="实验性功能，体验中">Beta</span>
</template>

<style scoped>
.beta-badge {
  display: inline-block;
  padding: 1px 7px;
  font-size: var(--font-size-xxs);
  font-weight: 700;
  letter-spacing: 0.4px;
  line-height: 1.4;
  border-radius: 99px;
  background: var(--interactive-accent);
  color: var(--text-on-accent);
  vertical-align: 1px;
  user-select: none;
  /* 挂点宿主多为 uppercase 小节标题（如 CollapseSection 标题条）——徽章锁定原样大小写 */
  text-transform: none;
}
</style>
