# 待改进 TODO

更新时间：2026-05-26

来源：

- `Dev/Reviews/opus-4.7复审报告-2026-05-25.md`

范围：仅针对正式项目 `story-craft/`、`docs/`、README 和插件配置；`Dev/` 下参考项目不纳入实现范围。

## 当前状态说明

- P23 / P24 / P25 已全部完成，完成记录不再保留在本 TODO 中。
- 本文件只记录当前仍未完成的待办项；目前暂无未完成项。
- 历史治理闭环可查看最新复审报告、git 历史和已归档计划文档。
- 最新复审结论：关键质量问题已闭环，复审报告中的 5 个低优先级事项也已处理完毕。

## 执行原则

- 不建议为下列事项单独开启大型阶段。
- 优先在自然修改相关文件时顺手清理。
- 涉及 reviewer 输出契约或 `WriteResult` 类型拆分时，先同步文档再改代码。
- 每次代码改动后运行：

```bash
timeout 60s python3 -B -m pytest story-craft/scripts/tests
env PYTHONPYCACHEPREFIX=/tmp/story-craft-pyc python3 -m compileall -q story-craft/scripts
git diff --check
```
