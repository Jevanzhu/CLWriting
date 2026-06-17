# CLWriting

> 为中文网文作者打造的开箱即用、全程中文、200 万字不崩的 AI 长篇创作系统。
>
> 一本书是一个 git 仓库，AI 负责写和审，脚本负责数和记，作者只做三件事——确认细纲、审稿、拍创作决策。

**状态**：v1.0 重写进行中（`v1` 分支）。当前 **M3 状态机 + git 隐身层已完成**，可用入口包括 `clwriting enter`、`clwriting health`、`clwriting revert`；**M4 AI 角色层 + 一级宿主尚未施工**，真 AI 写稿 / 三审 / 修复确认 / 复盘体检仍是后续工作。完整路线图见 [`Dev/Plans/`](Dev/Plans/)（本地资料）。

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
