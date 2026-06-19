# CLWriting

> 为中文网文作者打造的开箱即用、全程中文的 AI 创作系统——**双轨**：长篇（200 万字不崩、不吃书）+ 短篇集（单篇情绪爆破、一反转撑全篇）。
>
> 一本书/一个集是一个 git 仓库，AI 负责写和审，脚本负责数和记，作者只做三件事——确认细纲、审稿、拍创作决策。

**状态**：v1.0 重写进行中（`main` 主线）。**M0–M8 已完成**：
- M0–M4：格式层/缓存/写章机检/状态机/git 隐身/三审/角色分发/知识层
- M5–M7：安装器（多书）+ 自动连写 + 导出/迁移/RAG 插件
- **M8 短篇轨**：双轨第二轨——`kind: short` 分流 + 短篇集布局 + 精简态机 + 按篇定稿 + 单篇清单（反转线索/伏笔回收）+ 短篇专属机检 + 短篇三审（钩子/情绪反转/设定收尾）+ 短篇导入。ZCode 等价宿主 smoke 出口达成（正反向闭环复现）；真 CC/Codex smoke 待跑。

401 测试全绿；运行时零第三方依赖。可用入口：`enter`、`health`、`revert`、`confirm`、`check`、`finalize`、`roles`、`knowledge`、`review`、`session-start`、`init`、`update`、`use`、`list`、`repair`、`auto`、`export`、`import`、`learn`、`enable-rag`。

> **短篇轨用法**：`clwriting init --kind short --name <集名> --genre <题材>` 建短篇集 → `enter` 起草第一篇 → 按 P1–P4（定情绪+反转 → 五段大纲+清单 → 正文 → 三审定稿）走。`import` 自动按 length-routing 分流短篇分支。

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
