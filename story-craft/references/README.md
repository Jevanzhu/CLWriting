# story-craft 参考资料

本目录存放 Skill 与 Agent 可按需读取的参考资料。
这些资料只提供创作约束、审查口径、题材判断和方法论提示，不作为故事事实真源。

## 使用原则

- 故事事实以用户项目中的 `.story/state.json`、`.story/memory.json`、`大纲/`、`设定集/` 为准。
- 参考资料用于生成前的判断、审查时的口径统一和缺口排查。
- CSV 文件是上下文参考，不是结构化检索数据库。
- 短篇项目只加载 `short/` + `shared/`；不得默认读取 `long/`。
- 长篇项目加载 `long/` + `shared/`；`long/` 的方法论资料已在 S5-02 引入。
- `index/` 只保存加载映射和缺口登记，不放创作内容。

## 目录

- `shared/`：短篇和长篇共用资料，包含核心约束、审查 schema、题材画像、CSV 参考和 reviewer 口径。
- `short/`：短篇专用资料，包含阅读驱动力分类和情节信号/剧透边界。
- `long/`：长篇专用资料，包含从 oh-story-claudecode 引入的长篇方法论、出处说明和 MIT 许可证。
- `index/`：参考加载映射与缺口登记。

## 加载边界

- `/story-short-*`、短篇 reviewer `solo` 和短篇扫描流程只读取 `references/short/`、`references/shared/` 与必要题材包。
- `/story-long-*`、长篇 reviewer `lean/full` 和长篇规划流程读取 `references/long/`、`references/shared/` 与必要题材包。
- 共用命令根据场景读取 `shared/`，只有用户明确询问短篇或长篇专项口径时才进入对应目录。
