# 随包知识语料（三面运行时读取）

本目录是 `知识层/` 正式语料的**随包子集**：真模型运行时按各面策略读到的判断类速查都在这里，
不进随包的只剩许可件与各类目 README（说明性文件，非语料副本）。

- 来源与许可：各篇正文前的 front matter 保留原始 source / source_ref / license；MIT 许可全文见 `许可/`。
- 一致性：本目录下每个文件必须与 `知识层/` 内同名文件**逐字节相等**，由 `npm run check:knowledge` 对账；
  改语料 = 改 `知识层/` 原稿（含 manifest 哈希）后同步此处，两处不同步即红。
- 注入口径：篇目与消费面单源 = `src/knowledge/catalog.ts` 的 `faces`（`check:knowledge` 按它校验
  「声明会下发的篇必须在位」）。三面策略各自只声明选哪些篇、帽值多少：
  - 写稿面（`src/knowledge/select.ts`）：按书 `kind` 分档，基础篇 1 篇（长篇＝长篇章节钩子速查，
    短篇＝短篇反转机制速查）+ 信号追加 1 篇，合计 ≤2 篇、单篇 ≤3000 码点、合计 ≤6000 码点；
  - 三审面（`src/knowledge/review-method.ts`）：按书档 × 视角各取对口篇 1 篇，单篇 ≤3000 码点；
  - 对话面（`src/knowledge/chat-method.ts`）：按 catalog 声明序取帽内前 N 篇，单篇 ≤3000、合计 ≤6000 码点。
  篇内 front matter 不进 prompt；冲突时以本书设定为准。
- 作业包引用：对话面作业包（`resources/skills/*.md`）可经 front matter `references` 引本目录篇目，
  取用时按书档只嵌本档那篇；`check:knowledge` 的作业包引用门校验声明的篇在本目录与 `知识层/` 均在位。
- 题材卡（`题材/`，32 张）：写稿面按书题材召回至多 2 张（判据 = 卡 `aliases` 命中书级
  `book.yaml` 的 `book.genre`，召回规则见 `知识层/题材/README.md`）；建书播种只铺命中的卡，
  未命中卡仍在本目录随包可读。`check:knowledge` 的别名门校验每张卡带非空 `aliases`。
