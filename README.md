# CLWriting

> 为中文网文作者打造的开箱即用、全程中文、200 万字不崩的 AI 长篇创作系统。
>
> 一本书是一个 git 仓库，AI 负责写和审，脚本负责数和记，作者只做三件事——确认细纲、审稿、拍创作决策。

**状态**：v1.0 重写进行中（`main` 主线）。当前 **M0-M6 已完成**；**M7 导出 + 迁移指引 + RAG 插件出口达成**（321 测试全绿；`export` 定稿正文干净导出、v0.2→v1 轻量迁移指引、`learn` 文风样章/金句收割、`enable-rag` RAG 可选插件）。可用入口：`enter`、`health`、`revert`、`confirm`、`check`、`finalize`、`roles`、`knowledge`、`review`、`session-start`、`init`、`update`、`use`、`list`、`repair`、`auto`、`export`、`import`、`learn`、`enable-rag`。

---

## v1 技术栈

| 项 | 选择 |
|---|---|
| 运行时 | Node ≥ 24 |
| 语言 | TypeScript（strict） |
| SQLite | 纯 `node:sqlite`（运行时零第三方依赖） |
| 构建 | tsup |
| 测试 | vitest |

---

## 开发

```bash
npm install          # 安装 devDependencies
npm run typecheck    # tsc --noEmit 类型检查
npm run build        # tsup 构建（src → dist）
npm test             # vitest 运行测试
node dist/cli.js     # 运行 bin
```

> **要求 Node ≥ 24**（`node:sqlite` 开箱即用）。低于此版本 bin 会以人话提示升级并退出。

---

## 致谢

本项目在设计上参考了以下开源项目：

- **[webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)**：架构思想参考；v1 为从零重写。
- **[oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)**（MIT）：长篇写作方法论资料来源。
- **[character-arc](https://github.com/uu201/character-arc)**（MIT）：角色弧线与设定方法论参考。

## 许可证

[MIT](LICENSE)
