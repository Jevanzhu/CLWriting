/**
 * 推迟到「当前帧绘制完成之后」再执行（回调里的 DOM 变更在下一帧渲染）。
 *
 * 为什么不是单 requestAnimationFrame：rAF 回调之后同一任务内立即跑微任务，
 * 渲染管线（style/layout/paint）紧随其后——在 rAF 里改状态触发的挂载仍落在
 * 同一帧内，分帧无效（2026-09-04 实测设置弹窗单 rAF 分帧后整帧成本不降）。
 * rAF + setTimeout 把回调推到本帧 present 之后的定时器任务，重内容下一帧才
 * 上屏——遮罩独占的轻帧由此真实成立（J5 win 同步拍：遮罩帧与窗控压暗同帧
 * 扫描输出，144Hz 每帧预算 6.9ms，重内容同帧挂载必然把遮罩拖出单帧预算、
 * 落后窗控 1-2 帧即作者感知的「弹窗延迟」）。
 */
export function afterPaint(cb: () => void): void {
  requestAnimationFrame(() => setTimeout(cb, 0))
}
