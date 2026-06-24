# CLWriting GUI 方案 v0.3

> **状态**:v0.3 方案已进入实现收口(2026-06-24 同步)——功能蓝图 + 编排模型(B)+ 工程方案 + prompt 工程 + UI 状态机 + driver 细节 + 横切 全部定稿;Step1 全 + Step2.1-2.5 已落地,driver resume 假会话已修,真宿主 smoke 独立入口已补。**首版只支持 CC**(Codex 暂时放弃,决策 22)。本文作为方案母本/决策记录保留,当前进度以 `Dev/Plans/README.md` 为索引。
>
> **v0.4 修正(2026-06-23)**:**driver CC 实现从 Agent SDK 改 CLI headless**(复用用户 CLI 认证 / GLM 网关,不装 SDK)。**架构红线:GUI 后端不直连大模型**——所有 AI 流量经 `spawn('claude', ...)`,Node 禁 import SDK / fetch 大模型 API(见 9.4)。
> **地位**:GUI 方向讨论的沉淀,**非实施指令**。每节标注「已定 / 待定 / PoC」。
> **前置**:driver 前提已核实通过(第 2 节)。
> **关联**:母本 `参考/clwriting-v1-迁移方案.md`;吸收点 `参考/clwriting-v1-参考项目吸收点.md`。
> **与既有决策的关系**:吸收点文档第 5 节曾判「Electron/Vue 桌面 GUI——形态不符」。本方案**重新审视**:GUI 作为 CC/Codex 的壳,不改变 CLI/CC 插件内核,与 v1 定位兼容;不走 Electron,走本地 server + 浏览器。

---

## 第 1 节 定位(已定)

- **GUI 是壳,CC/Codex 是大脑**:GUI 不自建 agent loop,不替换 AI 宿主;它驱动 CC 或 Codex,提供可视化交互与编排。
- **地基不变**:MD 真源 + `.cache` 可重建 + `node:sqlite`;确定性逻辑走 `clwriting` CLI,AI 走宿主。GUI 是附加形态,不改内核、不改 CLI 单入口哲学。
- **形态**:本地 Node server + 浏览器前端,`clwriting studio` 起服务。**不走 Electron**(与定位冲突,且要把宿主运行时打进包里过重)。
- **宿主在建书时选择**:每本书绑定一个 AI 宿主(`book.yaml` 记 `host: cc | codex`)。**首版只支持 CC**(Codex 暂时放弃,见决策 22),host 缺省 cc;driver 抽象层保留双宿主接口,未来可恢复 Codex。
- **参考项目只作功能参考**:webnovel 的 dashboard、character-arc 的功能,只用来「知道还能做什么」;具体功能从 CLWriting 自身数据与流程内生推导,不照搬形态。
- **GUI 与 CLI 并行可用**:GUI 不建第二份数据——与 CLI 共享同一份 MD 真源 + `.cache` + git。作者可随时在 GUI 与 CLI 间切换 / 并行(用 CLI 写的章 GUI 能看,反之亦然),视角永远一致;写并发用轻量协作(见 1.5),不动 CLI 核心。

---

## 第 1.5 节 与 CLI 的关系 / 并发模型(已定)

**底层一字不变**:GUI 是「新的调用者」,不改任何内核——`clwriting` CLI 全部命令、SKILL.md、MD 真源、`.cache`、node:sqlite 全部原样。GUI 调 CLI 命令(确定性)+ 调 CC driver(AI),和作者手动开 CC 调 CLI 是同一套内核。

> **agents 的例外**:角色文件(`.claude/agents/*.md`)是 generated file(有 `source_hash`),随 **roles 源** 演进可重新生成(如 6.2 给 writer 补「禁 MD 语法」)——这是**角色提示层增强**(改 roles 源 → `roles/shells.ts` 重跑),不是内核逻辑改动,不破坏「底层不变」口径。

**并行架构免费**:GUI 与 CLI 共享同一份真源(MD + `.cache` + git),GUI 不维护自己的数据库。因此切换 / 并行是架构天然保证:
- 作者用 CLI 写 N 章 → 开 GUI,GUI 读 MD,N 章全在
- 作者用 GUI 写 N 章 → 关 GUI,终端 CLI 接着写,无缝
- 两边对同一本书视角永远一致(同一数据的两个「视图 + 操作器」)

**写并发模型(单写者协作,不动 CLI 核心)**:

| 操作类型 | 并行策略 |
|---|---|
| 读(health / detectState / metrics / 读正文) | 无锁,GUI 与 CLI 完美并行 |
| 写(draft / finalize / revert / edit) | 单写者协作 |

- GUI 活跃时写 `工作区/.gui-active`(PID + 时间戳);CLI 向后兼容(不强制检测,老脚本照跑,可选加轻提示)
- 约定:作者「GUI 在写」时避免终端动同一文件;GUI 检测文件 mtime 变化提示刷新
- git 兜底:finalize / revert 是原子 commit,罕见撞车时 git 报错,重试即可

**为何足够**:CLWriting 本就是线性工作流(八阶段串行),同刻作者几乎不可能「GUI 写第 5 章同时终端 finalize 第 4 章」,真实风险窗口极小——乐观 + 提示 + git 兜底足矣,无需重型进程锁或改 CLI 加锁。

---

## 第 2 节 技术前提核实(已通过)

driver 前提经 claude-code-guide(CC 侧)+ general-purpose(Codex 侧)双线核实,**绿灯**。

### 2.1 两宿主能力对照

| 维度 | Claude Code | Codex |
|---|---|---|
| 驱动通道 | CLI headless `claude -p --output-format stream-json`(v0.4 修正) | `codex app-server` JSON-RPC(未来恢复时再接) |
| 双工 / 中途注入 | ✅ generator `yield` 注入 | ✅ `turn/steer` 注入 |
| 续会话 | ✅ `resume: sessionId` | ✅ `thread/resume` |
| 继承项目上下文 | ✅ `CLAUDE.md` + `.claude/agents/` 自动加载(`settingSources`);⚠ `SKILL.md` 不被读(见 2.3) | ✅ `AGENTS.md` + `.codex/agents/` |
| 审批机制 | `canUseTool` 回调 + `allowedTools` | server-initiated `requestApproval`(可弹窗,粒度更细) |
| 分发许可 | Anthropic Commercial Terms(可分发,有品牌限制) | Apache 2.0(更宽松,可闭源衍生) |
| 认证 | ⚠️ **仅 API key**(按 token;Anthropic 禁止第三方提供订阅登录) | ✅ ChatGPT 订阅(月费)**或** API key |
| 角色文件格式 | `.claude/agents/*.md`(frontmatter) | `.codex/agents/*.toml`(TOML schema) |
| 随包分发运行时 | 复用用户本机 Claude Code CLI 与认证 | Rust 二进制 + SDK,需用户侧登录认证 |

### 2.2 三个影响方案的关键发现

1. **两宿主 subagent 都是「软触发」,无确定性 RPC**。CC 和 Codex 都**不能**「直接实例化 writer 角色」,只能构造 prompt 让主 agent 自主 spawn(`Use the writer agent to...`)。这是「受控模式」的真实约束。
2. **角色文件格式不统一(md vs toml)**——但 CLWriting 已有 `roles/shells.ts` 生成器(单一角色源 → 多平台壳),**加一个 TOML 生成分支即可**,贴合现有架构。
3. **认证模式差异大,影响用户成本**:CC 只能 API key(国内门槛高);Codex 可订阅(对个人写作者友好,但 Plus 有 5h 限速,长篇易触顶)。这是「建书时选宿主」决策的重要输入。

### 2.3 PoC 验证结果(2026-06-22,ccats + GLM 环境)

**CC 侧——实打实跑通**:
- 协议层:Agent SDK Streaming Input 走通 ccats `/messages`,session/cost/流式正常。
- 上下文继承:`.claude/agents/*.md` 四角色(writer / continuity-review / editor-review / reader-review)全部加载进 `system.init.agents`。
- 角色 spawn:主 agent 调 `Agent` 工具(`subagent_type:"writer"`)成功触发 writer,产出真实小说开头。
- driver 实现要点:① 触发角色用 **`Agent`** 工具(非 `Task`,CC 2.1.63+ 改名);② subagent 输出在 `tool_result` 内;③ GLM 的 `thinking_tokens` 是大量噪声,driver 要过滤;④ `ENABLE_TOOL_SEARCH` 下工具要现搜、多耗 turns,GUI 可预加载工具降本。

**Codex 侧——首版不做(决策 22)**:
- `codex exec --json` 的 JSONL 格式已确认(`thread.started` / `turn.started` / `turn.failed`)。
- 智能层在本地 ccats 环境未跑通;**首版放弃 Codex**,无需复验。未来恢复时再补角色 spawn 实证。
- 配置注意(未来用):Codex 有两把 key——config.toml `experimental_bearer_token`(ccats 认)与 auth.json `OPENAI_API_KEY`(ccats 401);GUI 接入时注意选用(见 memory `codex-ccats-可用`)。

**`.claude/SKILL.md` 路径**——已验证(2026-06-22,`cc-skill-check.mjs`):**SKILL.md 未被 CC 当作项目指令读取**。禁工具 probe 下,CC 明确答「不知道 SessionStart 命令」,自述上下文只有 `CLAUDE.md` / `MEMORY.md` / agent 描述;零工具调用。`.claude/agents/*.md` 正常加载(作为可 spawn 角色)。**对架构的影响(B 编排决策后)**:八阶段编排(SessionStart / record-call / finalize)的归属是 GUI,不是 CC——GUI 显式调每步(见 6.1 / 9.2),driver 不注入 SKILL.md。SKILL.md 是**人工模式专用**(作者手动开 CC 写小说时,CC 按 SKILL.md 自编排);GUI 模式下编排者是 GUI,SKILL.md 不参与。

**对认证策略的输入**:第三方网关协议覆盖不同(ccats 覆盖 Anthropic `/messages`);GUI 按宿主协议匹配网关,或默认官方端点。

---

## 第 3 节 双轨约束(已定)

短篇 / 长篇双轨是硬约束,GUI 每个域都要「双轨感知」。

| 维度 | 长篇 long | 短篇 short |
|---|---|---|
| 单位 | 章 | 篇 |
| 正文 | `定稿/正文/<章号>-<标题>.md` | `篇/<篇号>-<标题>/正文.md` |
| 账本 | 七类(伏笔/悬念/感情线 + 局线/设定线/成长线/关系债) | 单篇清单(归篇详情 6.5) |
| 卷纲 / 设定 / growth | 有(角色/时间线/卷纲) | 无 |
| 摘要 | 章摘要 + 卷摘要(分层) | 无分层 |
| finalize | 跑形式三检(账本对账) | 跳,只审稿裁决 + 哈希 |
| 文风 | 整本共享 — 整集共享(长短同构) | — |

**对 GUI 的影响**:体检 / 节奏 / 总览双轨都适用(metrics 已有 `kind` 分轨);账本七类 + 设定是长篇专属,短篇清单归工作台篇详情(6.5)、统计台走集子总览(7.3);建书向导 / 流程台按 kind 切形态。

---

## 第 4 节 GUI 骨架(已定)

四大功能区:

```
┌──────────────────────────────────────────────┐
│ 建书台 Onboard  交互建书向导(段1表单+段2 AI)│
│                新书/续写入口 · 宿主在此选    │
├──────────────────────────────────────────────┤
│ 工作台 Studio   八阶段/短篇流程图形化驱动   │
│                MD编辑器·返修·局部改写·版本回滚│
├──────────────────────────────────────────────┤
│ 统计台 Dashboard 五域统计可视化(双轨感知)  │
├──────────────────────────────────────────────┤
│ 设定台 Config   book.yaml/leads/文风铁律     │
│                知识层·import/export/RAG      │
└──────────────────────────────────────────────┘
```

---

## 第 5 节 建书台 Onboard(已定并已落地)

解决 CLI 现状痛点:`init` 无引导、建完设定空。GUI 把建书从「建空壳」升级为「建有血有肉的起点」。

### 5.1 段 1 · 基础信息表单(替代 init 的 stdin 交互)

- 书名 · 题材(标签)· kind(长/短,切换即预览结构差异)
- 题材驱动 leads 推荐(仅长篇,可改)
- 简介(长篇)/ 集子定位(短篇)
- **AI 宿主选择(首版固定 cc;Codex 暂缓,决策 22)**——`book.yaml` 已有 `host` 字段,首版写 cc;未来恢复 Codex 时再开放选择与认证配置。

段 1 收完 = 现在的 init 能力,但表单化、可视化、kind 切换实时预览。

**表单字段(对应 `InitOptions` + GUI 新增)**

| 字段 | 来源 → 落点 | 说明 |
|---|---|---|
| 书名 | `InitOptions.name` → `book.title` | 必填 |
| 题材 | `InitOptions.genre` → `book.genre` | 标签选择,驱动 leads 推荐 |
| kind | `InitOptions.kind` → `book.yaml kind` | long/short,切换实时预览结构差异 |
| 扩展账本类 | `InitOptions.leads` → `leads.enabled` | 题材推荐可改(仅长篇) |
| **AI 宿主** | **GUI 新增** → `book.yaml host`(cc\|codex) | 首版写 cc(Codex 暂缓,决策 22) |
| 简介 | **GUI 新增**(init 无)→ `book.yaml brief` 或 `简介.md` | 长篇简介 / 短篇集定位 |

**GUI 对 init 的三点增强**:① 写入 `host` 字段(首版固定 cc,保留未来扩展);② 新增简介字段;③ kind 切换实时预览长/短篇目录结构差异。

> `book.yaml` 已有 `host` / `target_words` 字段:`host` 首版默认 cc;`target_words` 供完成度直除。

### 5.2 段 2 · AI 填充设定(关键增量,走宿主;init 做不到的 GUI 能做)

| 填什么 | 解决哪个「空」 | 长短 |
|---|---|---|
| 首批角色 | `定稿/设定/角色/` 空 | 长篇 |
| 世界观 / 力量体系 | 设定线空 | 长篇 |
| 大纲骨架 | `大纲.md`+卷纲+前 N 章细纲空 | 长篇 |
| 账本种子 | 七类各 1-2 条初始线 + 履历起点 | 长篇 |
| 集子定位 | 集子主线 + 首篇细纲空 | 短篇 |
| 文风样章 | 样章库 5 场景空(few-shot) | 双轨 |
| 文风铁律 | 通用占位 → 按题材定制 | 双轨 |
| 金句库 | 空 → 题材金句种子 | 双轨 |

每步宿主生成 → GUI 预览 → 作者可改 / 重生成 / 跳过。

**步骤落点(长篇)**

| 步骤 | 输入(给宿主) | 输出落点 |
|---|---|---|
| 首批角色 | 题材 + 简介 | `定稿/设定/角色/*.md` + `名册.md` |
| 世界观 | 题材 + 简介 | `定稿/设定/世界观.md` |
| 境界体系 | 题材(成长线) | `定稿/设定/境界体系.md` |
| 总纲 + 卷纲 | 题材 + 简介 + 角色 + 世界观 | `大纲/总纲.md` + `大纲/卷纲/卷纲_第1卷.md` |
| 账本种子 | 总纲 + 角色 | `大纲/<类>/<编号>-*.md`(front matter + 空履历) |
| 文风样章 | 题材 + 文风调性 | `文风/样章库/<场景>/*.md` |
| 文风铁律 | 题材 + 偏好 | `文风/文风铁律.md`(替代占位) |
| 金句库 | 题材 | `文风/金句库/` |

**短篇**(精简):集子定位 + 首篇细纲(`篇/` 或 `工作区`)+ 文风三件(样章 / 铁律 / 金句,整集共享)。

**闭环**:段 2 首版走 cc 宿主;未来恢复 Codex 时再按 `host` 分流。每步交互:宿主生成 → GUI 预览 → 改 / 重生成 / 跳过 → 确认落盘。

> 对接吸收点文档的 **spiral 三圈开书引导**(seed → expand → validate,M5 规划未施工)——段 2 就是 spiral 的落地载体。

### 5.3 段 2 prompt 组装(建书 AI 填设定)

策略:**各步独立 `spawnRole('onboard')`**——避开 GLM `send` 软触发 Agent 偶发卡死;每步 prompt 自含题材、kind 与设定规范,生成后由 GUI 预览 / 改 / 重生成 / 跳过 / 保存落盘。

**步骤依赖图**(GUI 编排顺序):

```
独立(可早跑)           依赖
──────────────         ──────────────
首批角色 ─┐
世界观   ─┼──→ 总纲 + 卷纲 ──→ 账本种子
境界体系 ─┘
文风三件(样章/铁律/金句)── 独立
```

独立步顺序 `spawnRole('onboard')`;依赖步等前置步作者确认落盘后,由下一步 prompt 读取已落盘真源补上下文。

**每步 prompt 公式**:
```
[spawnRole: onboard(单步自含上下文)]
## 第 N 步:生成 {产物名}
题材:{genre}  简介:{brief}
## 要求
生成 {产物},落 {路径},格式:{spec 约束}
## 设定规范(防臆造)
{相关格式 spec + 负向约束}
```

**首批角色示例**:
```
## 第 1 步:生成首批角色(3-5 个主角)
题材:仙侠  简介:{book.brief}
## 要求
落 定稿/设定/角色/*.md(每角一文件:front matter 姓名/身份/动机
+ 正文外貌/性格/弧光)+ 名册.md(汇总)
## 规范
不臆造与题材冲突的设定;角色动机须支撑后续冲突
```

短篇(精简):集子定位 + 首篇细纲 + 文风三件(整集共享),同 send session。

---

## 第 6 节 工作台 Studio(已定并已落地)

日常创作的核心。地基不变体现在:AI 部分(draft / review)走宿主,确定性部分(check / finalize / revert)走 CLI,编辑器只改 MD 真源。

### 6.1 八阶段 / 短篇流程台

**流程台是编排中枢(B 决策)**:八阶段的编排权归 GUI,不归 CC。GUI 显式调每步——点「生成细纲」→ `send`(主 agent 合成多源);点「写稿」→ `spawnRole(writer)`;机检 / 定稿 → 直调 CLI。CC 每次只做单步生成(干净上下文),不读 SKILL.md、不自编排。这与人工模式(CC 读 SKILL.md 自主跑)是两套并行逻辑,底层 CLI / CC 内核不变(见 1.5)。

图形化驱动 CLWriting 的流程节点:

| 阶段 | 对应 | 走宿主 | 说明 |
|---|---|---|---|
| enter / session-start | 进入章节,读上下文 | 否(确定性) | 显示当前状态机位置 |
| outline + confirm | 细纲生成 + 确认 | 是(outline,`send` 主 agent) | 主 agent 合成多源 → 确认 → record-call |
| prepare | 备料(选场景样章) | 否 | — |
| draft | 写稿(writer 角色) | 是 | 流式回显 |
| check | 机检 | 否(确定性) | 直调,渲染红项 |
| review | 三审 | 是 | 三角色 spawn,收 issues |
| 审稿裁决 | 展示审稿单,作者裁决 | 否 | — |
| finalize | 定稿 | 否(确定性) | 直调 |

短篇走精简流程(跳账本推进 / 卷复盘 / 形式三检)。

**每步 GUI 交互(长篇八阶段)**

| 阶段 | 触发 | 展示 | 作者介入点 |
|---|---|---|---|
| enter | 进工作台自动 / 手动 | 当前态 + 路由 + 近况(`detectState`) | 确认开写哪章 |
| outline | 点「生成细纲」 | 宿主流式生成细纲 | 改 / 确认(`confirm`) |
| prepare | outline 后自动 | 备料清单(场景样章 + 上下文) | 选场景 |
| draft | 点「写稿」 | writer 流式写稿 → 编辑器 | 中断 / 注入 |
| check | draft 后自动 / 手动 | 红 / 黄项机检报告 | 红项返 draft |
| review | 点「三审」 | 三角色 spawn,审稿单汇总 | 裁决(通过 / 返修) |
| finalize | 裁决通过后 | 定稿结果(账本履历 / 摘要) | 确认定稿 |

工作台顶部常驻「当前阶段」指示(来自 `detectState`),每步完成自动推进;短篇走 P1–P4 精简态机。

### 6.2 编辑器(修改文章)

- **MD 编辑器 + AI 改写侧栏**,不走富文本——CLWriting 地基是「MD 真源」,富文本会引入第二种真源破坏地基。
- 双向绑 MD 真源文件;AI 改写走宿主出 diff,作者确认后落盘。

**能力清单(定 CodeMirror 双模式)**:
- **正文模式**(章/篇 .md 正文):纯文本,不渲染不输入 MD 语法——所见即所发,可直接贴平台;允许场景分隔(空行 / `* * *`);对话引号(「」/"")/ 省略号(……)等标点不算格式,照常保留
- **设定模式**(大纲/卷纲/角色/清单/铁律 .md):MD 语法高亮,结构化编辑
- 双向绑工作区草稿 / 定稿真源(改即真源,无第二种真源)
- AI 改写侧栏:选中文本 → 触发宿主 → diff(增 / 删)→ 确认落盘 / 拒绝
- 坚持纯 MD / 纯文本:与 CLI / 宿主工作方式一致,不破坏「MD 真源 + .cache 可重建」地基

**配套(地基侧,从生成到发布全程无格式)**:
- `writer.md` 补「正文禁 MD 语法(标题/加粗/列表/代码块;仅段落 + 空行 + 场景分隔)」——从生成端保证无格式
- `export` 加「发布导出」(剥离 front matter → 纯正文 TXT)——见 8.4
- Milkdown 出局:WYSIWYG 会渲染格式,与「无格式正文」根本冲突

### 6.3 修改文章三件(分步骤上)

- **局部改写**:编辑器选中段落 → 宿主改 → diff 确认
- **MD 编辑器**:直改真源(不走 AI)
- **整章返修**:基于审稿意见 / 指令重做 draft(带 diff),靠流程台自然覆盖

**diff 流程**:
- 局部改写:选中段落 → 宿主改写(走 driver)→ diff(原 vs 改)→ 确认落盘
- 整章返修:审稿意见 / 指令 → 宿主重做 draft → diff vs 原稿 → 确认(原稿可整章回滚)
- diff 组件:diff2html 或自渲染(参考 character-arc 用 diff2html)

### 6.4 受控模式(B 编排:spawnRole 为主)

基于 B 决策(GUI 编排),driver 窄化为「单步生成器」,两策略主次反转:

- **spawnRole(主)**:单角色、干净上下文、确定性输出——GUI 直接以角色系统提示起会话。draft(writer)、review(三角色并行)、局部改写 全走这条,符合角色「在干净上下文工作」的设计初衷,且省 token(不带主 agent 上下文)。
- **send(辅,软触发)**:少数需要主 agent 合成多源的步骤(如 outline 要读总纲 + 卷纲 + 前章摘要 + 账本再产细纲)——构造强 prompt 让主 agent 编排 spawn。
- **CLI 直调(确定性)**:check / finalize / revert / record-call,按钮化,不走宿主。

**逐场景标注**:

| 场景 | 走哪条 | 理由 |
|---|---|---|
| outline | `send`(主 agent 编排多源) | 要合成总纲 / 卷纲 / 前章 / 账本 |
| draft | `spawnRole`(writer) | 干净上下文单角色,确定性 |
| check | CLI 直调 | 确定性机检 |
| review | `spawnRole` ×3(并行) | 三角色各独立会话,continuity 账本驱动 |
| 审稿裁决 | GUI 展示(无宿主) | 作者人工 |
| finalize | CLI 直调 | 确定性 |
| 局部改写 | `spawnRole`(writer / editor) | 单角色,限定范围 |
| 整章返修 | `send` 或 `spawnRole` | 按审稿意见重做 → send;只让 writer 重写 → spawnRole |

### 6.5 篇详情(短篇专属,正文 + 元数据 + 清单同屏)

短篇的单篇清单(反转线索表 + 情绪曲线 + 伏笔回收)**嵌在此处**,不单独成页——清单是单篇内闭合、与正文强绑定,同屏才能写 / 改 / 审时随手对照。**形态服从数据**:长篇账本跨章 → 独立页(7.3);短篇清单单篇闭合 → 嵌篇详情。

**布局**:左正文(纯文本编辑,见 6.2)+ 右清单三段 + 顶部元数据(PieceMeta:目标情绪 · 核心反转)。

**清单三段(数据源 `篇/<篇号>-<标题>/清单.md`)**:
- **情绪曲线(P0 主图)**:`[段落] 情绪 强度/10`(EmotionCurvePoint[])→ 强度折线 1-10 + 段落标注 + 峰值高亮
- **反转线索表(配套)**:核心反转 + 铺垫点 ≥3([位置] 内容,三现结构)→ 核心置顶 + 铺垫点时间轴
- **伏笔回收(配套)**:伏笔 → 回收位置;(未回收)标弃坑 → 列表 + 未回收红标

**情绪曲线为何主图**:短篇目标函数 = 情绪爆破,曲线即爆破力「心电图」;折线一眼看出峰值 / 塌陷段,信息密度最高;贴近创作即时反馈;数据现成零后端新增。三段同源同页都做,情绪曲线占首屏主位。

**跨篇聚合归统计台**:本页只看单篇;各篇核心反转 / 情绪峰值 / 回收率一览(集子总览)→ 统计台 7.3 短篇分支。

### 6.6 prompt 工程(工作台 outline / draft / review)

B 编排下,GUI 的核心产出是**组装 prompt 调 `send` / `spawnRole`**。三步公式基于 CLWriting 真实数据结构,角色用现有 `.claude/agents/*.md`,输出落现有工作区文件。

**三步总览**:

| 步 | 策略 | 角色 | 输入组装 | 输出 |
|---|---|---|---|---|
| outline | `send` | 主 agent | 总纲+卷纲+前章摘要+账本 | `工作区/细纲.md` |
| draft | `spawnRole` | writer | 细纲 + 备料 | `工作区/草稿.md` |
| review | `spawnRole`×3 | continuity / editor / reader | 正文(+ leadChanges) | JSON issues → 审稿单 |

**outline**(主 agent 合成多源,`send`):
- 上下文组装:`大纲/总纲.md` + 当前卷 `大纲/卷纲/卷纲_第N卷.md` + 前章摘要(近 3-5 章)+ 账本各线进度(`大纲/<七类>/*.md`)+ 题材简介
- 任务:产 `工作区/细纲.md`——① 本章场景声明(`场景: 对话`,对应样章库);② 账本推进声明(哪些线 × 动词:埋下 / 推进 / 揭开);③ 情节骨架(开篇 / 发展 / 章尾钩)
- 作者确认后,GUI 调 CLI `confirm`(记哈希 + 备料闸)

**draft**(writer 干净上下文,`spawnRole`):
- `spawnRole(writer)`,writer 系统提示已含规则(2000-4000 字 / 单章一主场景 / 章尾钩 / 账本声明必有证据 / 禁 MD 语法仅段落)
- prompt = `工作区/细纲.md` 全文 + `工作区/本章写作材料.md`(prepare 备料:按细纲场景选样章 + 上下文摘录)
- **不给历史会话**(干净上下文)→ 正文落 `工作区/草稿.md`
- **prepare 组装**(confirm 后自动,确定性,不走 AI):按细纲 `场景` 声明从 `文风/样章库/<场景>/` 选样章(首场景为主)+ 近章摘要 + 账本当前状态 → 组装 `工作区/本章写作材料.md` 作 draft 输入

**review**(三角色并行,各 `spawnRole` 干净上下文):
- **continuity**:正文 + 机检 `byproducts.leadChanges`(账本变动清单)→ 逐条核对账实相符(**恒跑**,不降级)
- **editor**:正文 → 文字质量 / 人物 / OOC / 逻辑
- **reader**:正文 → 爽点交付 / 追读牵引 / 节奏功能
- **统一输出契约**(三角色一致):JSON only,issue 必带 `evidence`(引用正文原文),`severity` = S1 致命 / S2 严重 / S3 一般 / S4 建议
- GUI 汇总:三视角 issues → 按 severity 排序、按视角分组 → 审稿单;作者裁决 `approved` / `rejected`

**draft 示例模板**:

```
[spawnRole: writer]   系统提示 = writer.md(规则已内嵌)

用户消息:
  ## 本章细纲(已确认)
  {工作区/细纲.md 全文}
  ## 备料
  {工作区/本章写作材料.md:场景样章 + 上下文}
  ## 要求
  按细纲写正文 → 工作区/草稿.md
```

**短篇(P1–P4 精简)**:outline / draft 同构(单位换篇);review 三视角围绕「单篇开合收尾不崩」重组(非长篇映射),continuity 对 `清单.md`(反转线索表 + 伏笔回收)逐条核对。

### 6.7 改写 prompt 组装(局部改写 / 整章返修)

**局部改写**(`spawnRole`,单角色限定范围):
- `spawnRole(writer)` 或 `editor`:选中段落 + 前后段上下文 + 改写指令
- 输出:改写段落 → GUI diff(原 vs 改)→ 确认落盘 / 拒绝

```
[spawnRole: writer]
## 原文(选中段落)
{选中段}
## 上下文(前后段)
{前段} ... {后段}
## 改写指令
{作者指令,如「更紧张」「压到 300 字」}
## 要求
只改选中段,不动其他;保持正文纯文本无格式
```

**整章返修**(基于审稿意见 / 指令重做):
- `send`(主 agent 合成审稿意见 + 原稿 + 指令)或 `spawnRole(writer)`(重写)
- 输出:新草稿 → diff vs 原稿 → 确认(拒绝可 `revert` 整章回原 commit)

**diff 流程**(两件共用):原 vs 改 → 逐处确认 → 落盘;diff 组件 diff2html 或自渲染(参考 character-arc)。

### 6.8 八阶段 UI 状态机

B 编排下,状态机在 GUI(不是 CC 自主跑)。按步骤类型分四类:

**A · 确定性步**(enter / confirm / prepare / check / finalize,调 CLI,短任务):
```
idle → running → done | error
```
无流式、无中断;error = CLI 报错展示 + 重试。

**B · AI 流式步**(outline `send` / draft `spawnRole`):
```
idle → loading(起会话)→ streaming(可中断)→ done | interrupted | error
```
streaming 态常驻「中断」按钮;interrupted 保留已生成 → 续写 / 弃稿 / 改指令重写;error = driver 错(auth / timeout / network)→ 展示 + 重试 / 放弃。

**C · AI 并发步**(review `spawnRole`×3):
```
idle → loading(起 3 会话)→ 3× streaming → partial → done
                          (每角独立:streaming / done / error)
```
每角独立状态,issues 逐个回流;单角 error 保留成功角 + 「重试失败角」;三都 done → 汇总审稿单。

**D · 人工步**(审稿裁决):
```
waiting(展示审稿单)→ approved | rejected
```
approved → finalize;rejected → 回 draft(审稿意见注入重写 prompt)。

**跨步推进规则**:

| 当前步 done | 下一步 | 推进 |
|---|---|---|
| enter | outline | 自动 |
| outline | confirm | 停(等确认细纲) |
| confirm | prepare | 自动 |
| prepare | draft | 自动 |
| draft | check | 自动 |
| check 绿 | review | 自动 |
| check 红 | draft | 回灌(红项注入) |
| review | 裁决 | 停(等裁决) |
| 裁决 approved | finalize | 自动 |
| 裁决 rejected | draft | 回灌(审稿意见注入) |
| finalize | 下章 enter | 自动 |

**原则**:确定性步 + 绿灯自动推进;AI 产出 + 人工裁决停住等作者。check 红 / 裁决 rejected 自动回 draft(反馈注入),不卡死。

**中断恢复**:draft 中断保留已生成 → 续写(断点续)/ 弃稿 / 改指令重写;会话丢失(session_lost)提示重连,driver `resume`。短篇 P1–P4 同构(步骤精简,状态机更短)。

---

## 第 7 节 统计台 Dashboard(已定:五域全做)

按 CLWriting 数据域内生组织(非照搬 webnovel 页),双轨感知:

| 域 | 看什么 | 数据源 | 后端 | 双轨 |
|---|---|---|---|---|
| 项目体检 | 成本/审查/文风 三维图表 | `metrics.jsonl` + 文风重扫 | ✅ 现成(`health`) | 双轨 |
| 账本七类 | 各线履历推进 · 停滞预警(进行中且久未推进)· 哪章推哪线 | `大纲/<七类>/*.md` front matter + 履历 | 已落地基础版 | 长篇(短篇归篇详情 6.5,统计台走集子总览) |
| 章节节奏 | 字数曲线 · 钩子类型/强弱 · 情绪 · 场景 | 草稿 front matter | 已落地基础版 | 双轨(章/篇) |
| 项目总览 | 进度 · 热力 · 卷/集结构 | `book.yaml` + 定稿 | 已落地基础版 | 双轨 |
| 设定 | 角色出场 · 时间线 | `定稿/设定/` | 已落地 P1/P2 | 长篇专属 |

**项目体检是 `health` 可视化,几乎零成本,P0 性价比最高**;账本七类履历时间轴是 CLWriting 独有价值,最该做。

### 7.1 体检页字段设计(P0,后端零新增)

体检页 = `health --metrics`(成本/审查)+ `health --style`(文风)的图表化。所有字段来自现成 `MetricsReport` / `StyleTrend`,GUI 侧纯渲染、后端零新增。

**块 1 · 成本(`MetricsReport.cost`)**

| 组件 | 字段 | 呈现 |
|---|---|---|
| 指标卡 | `avgCalls`(平均调用/章)· `overLimitChapters`(超上限章数) | 数字卡 |
| 分步调用 | `avgByStep.{outline,draft,review}` | 柱状图 |
| 预算校准 | `nearLimitUnits`/`missingOutline`/`missingDraft`/`reviewedButNoReviewCall`/`zeroCallUnits` + `budgetNote`/`accountingNote` | 记账健康清单 |

**块 2 · 审查(`MetricsReport.review`)**

| 组件 | 字段 | 呈现 |
|---|---|---|
| 指标卡 | `fullRate`(满审率)· `downgradeRate`(降级率)· `avgBlockers`(平均阻断) | 数字卡 |
| 降级原因 | `topDowngradeReasons[{reason,n}]` | 条形图(top N) |
| 三视角覆盖 | `lensCoverage{continuity/editor/reader}` + `reviewedCount/count` | 覆盖条 |

**块 3 · 文风(`StyleTrend`)**

| 组件 | 字段 | 呈现 |
|---|---|---|
| 逐章趋势 | `dialogueTagSeries`(对话标签占比)· `varianceSeries`(句长方差)· `repeatSeries`(复读率) | 折线,叠加 baseline 对照线 |
| 风险章 | `overlongChapters`(单句超限)· `adjStackChapters`(形容词堆叠)· `summaryEndingChapters`(结尾总结体) | 趋势线上标点 + 风险章列表 |
| 漂移信号 | `drifts[{metric,message}]`(只报趋势,不下判决) | 信号面板 |
| baseline | `baseline.overall` + `baseline.byScene`(场景级指纹) | 对照 |

**待定设计选择**:① 文风三线合一图(双 Y 轴)还是分三图;② 风险章用线上标点还是独立列表;③ 是否做场景级文风切换(按 `byScene` 筛选)。

### 7.2 项目总览页字段设计(P0,着陆页)

GUI 着陆页:展示书的全貌 + 下钻各域的入口。**「当前状态机位置」是 CLWriting 特色**(他工具无)——一打开就知道现写哪章/哪阶段,点「继续写作」直接进工作台对应步。

**核心区**

| 组件 | 字段 | 数据源 | 双轨 |
|---|---|---|---|
| 身份卡 | 书名 · 题材 · kind · host · 创建时间 | `book.yaml` | 双轨 |
| 进度 | 已定稿章/篇数 · 总字数 · 完成度 | 定稿目录 + `countWords`(完成度算法见下) | 双轨 |
| 卷/集结构 | 长篇:各卷章数·字数·状态;短篇:各篇列表 | `大纲/卷纲` · `篇/` | 长卷/短篇 |
| 当前状态机 | 当前态 + 路由 + 近况 +「继续写作」入口 | `state/state.ts` `detectState`(运行时确定性推断,零 AI) | 双轨 |

**增强区**

| 组件 | 字段 | 数据源 | 双轨 |
|---|---|---|---|
| 摘要下钻卡 | 体检核心数(满审率/avgCalls/漂移)· 账本停滞数 | `metrics.jsonl` + 账本 `状态` | 双轨(账本长篇) |
| 写作热力 | 近 N 章/篇定稿时间线 · 产出节奏 | 定稿文件 mtime / `git findChapterCommit` | 双轨 |

**数据源已定**:
- `book.yaml` **新增 `target_words` 字段**(GUI 写入);「完成度」= 已定稿字数 / `target_words`(直除,无估算误差)。无 `target_words` 时回退展示「已写章数 + 篇幅档位」。
- `LeadStatus` 已确认:三态(`进行中/已收尾/已放弃`),无原生「超期」;GUI「停滞预警」为衍生判定(进行中 + 久未推进)。

**不在总览(归工作台)**:快捷操作面板(继续写/审稿/导出/新书)的完整集合;总览只留「继续写作」单入口,其余在工作台。

### 7.3 账本七类页字段设计(P0,长篇专属)

CLWriting 独有价值(参考项目均无)。数据:`大纲/<七类>/<编号>-<标题>.md` 的 front matter(`Lead`)+ 履历(`LeadEntry[]`)。

**重要口径**:`LeadStatus` 只有 `进行中 / 已收尾 / 已放弃` 三态,**无原生「超期」**。下文「停滞预警」是 GUI 衍生(进行中 + 久未推进),非账本字段。

**核心区**

| 组件 | 字段 | 数据源 |
|---|---|---|
| 七类概览 | 每类条目数 + 状态分布(进行中/已收尾/已放弃) | `Lead.类型` + `Lead.状态` |
| 账本推进矩阵 | 章 × 线网格,点 = 该章推进该线(动词) | `Lead.履历`(章号 + 动词) |
| 履历时间轴 | 选定线的推进事件流(章号 → 动词 + 证据) | `Lead.履历`(`LeadEntry`) |

**增强区**

| 组件 | 字段 | 数据源 |
|---|---|---|
| 停滞预警 | 进行中 + 开启章距今 N 章无履历 = 疑似停滞(GUI 推断,N 可配) | `Lead.状态` + `开启章` + 履历 vs 当前进度 |
| 特化展示 | 成长线:境界体系 + 当前境界;局线:父局线(局中局);关系债:欠方/债主 | `Lead` 特化字段 |

**双轨**:长篇专属(本页七类矩阵);短篇**不在本页画单篇清单**——单篇清单(反转线索表 + 情绪曲线 + 伏笔回收)归**工作台「篇详情」**(见 6.5,正文 + 元数据 + 清单同屏,情绪曲线为主图);本页短篇分支改为**集子总览**(各篇核心反转 / 情绪峰值 / 回收率一览,跨篇聚合)。

**特色**:**账本推进矩阵**(哪些章推进了哪些线)是 CLWriting 最独特的可视化——一眼看出某条线是否久未推进、某章是否一次推过多条线。

### 7.4 章节节奏页字段设计(P0,双轨分轨)

数据:草稿 front matter。**双轨字段不同**——长篇 `ChapterMeta`(钩子/情绪定位,追读力向)vs 短篇 `PieceMeta`(目标情绪/核心反转,单篇爆破力向)。

**长篇核心区(`ChapterMeta`)**

| 组件 | 字段 | 数据源 |
|---|---|---|
| 章长曲线 | 各章字数折线(配均字参考线) | `ChapterMeta._wordCount` |
| 钩子类型分布 | 5 类占比:危机钩/悬念钩/渴望钩/情绪钩/选择钩 | `钩子类型`(HookType) |
| 钩子强弱分布 | 强弱占比 | `钩子强弱`(HookLevel) |
| 情绪定位热力 | 情绪分布 / 逐章热力 | `情绪定位`(Emotion) |
| 场景分布 | 5 场景占比:战斗/对话/抒情/叙事铺陈/爽点高潮 | 细纲 front matter `场景`(正文 `ChapterMeta` 无此字段) |

**长篇增强区**

| 组件 | 字段 | 数据源 |
|---|---|---|
| 钩子类型 × 强弱 | 哪类钩常强 / 常弱 | `钩子类型` × `钩子强弱` |
| 场景 × 情绪 | 哪种场景配什么情绪 | `场景` × `情绪定位` |

**短篇(精简,`PieceMeta`)**

| 组件 | 字段 | 数据源 |
|---|---|---|
| 篇长曲线 | 各篇字数 | `PieceMeta._wordCount` |
| 目标情绪分布 | 各篇目标情绪占比 | `目标情绪` |
| 核心反转标记 | 反转类型 / 位置 | `核心反转` |

**枚举已确认**(`format/types.ts:135-146`):`HookLevel` = 强 / 中 / 弱(3 档);`Emotion` = 压抑 / 铺垫 / 小爽 / 大爽 / 转折(5 类);`HookType` = 危机钩 / 悬念钩 / 渴望钩 / 情绪钩 / 选择钩(5 类)。节奏页图例粒度:强弱 3 档、情绪 5 类、钩子 5 类。

**双轨**:长篇完整(钩子 / 情绪 / 场景);短篇精简(目标情绪 / 反转,无钩子类型——短篇目标函数不同)。

### 7.5 设定页字段设计(P1,长篇专属)

**关系图探查结论(不做)**:`RealmDoc`(定稿/设定/境界体系.md)是**境界体系**非角色文档;角色设定(`定稿/设定/角色/*.md`)无强类型(自由 MD);角色间无关系字段(关系只散在账本「关系债」类的 `欠方`/`债主`)。→ **角色关系图数据基础不足,剔除**;最多做「关系债子图」。

**核心区**

| 组件 | 字段 | 数据源 |
|---|---|---|
| 境界体系进阶图 | 成长线境界体系(RealmSystem[])的结构化展示 | `定稿/设定/境界体系.md`(`RealmDoc`) |
| 角色卡片 | 角色标题 + 正文摘要(自由 MD,无深度分析) | `定稿/设定/角色/*.md` |
| 时间线 | 时间线笔记展示(自由 MD,结构待确认) | `定稿/设定/时间线/*` |

**可选**

| 组件 | 字段 | 数据源 |
|---|---|---|
| 关系债子图 | 欠方-债主对 | 账本 `关系债` 类 `欠方`/`债主` |

**双轨**:长篇专属;短篇无设定层(单篇内闭合)。

**价值判断**:设定页是五域最弱——只有境界体系强结构化,角色 / 时间线是自由 MD(卡片展示)。优先级 **P1**(其余四域 P0)。

---

## 第 8 节 设定台 Config(已定方向,P1)

### 8.1 book.yaml 结构化编辑(表单,非裸 YAML)

| 配置块 | 字段 | GUI 形态 |
|---|---|---|
| 基本身份 | title / genre / kind / host | 文本 / 标签 / 下拉 |
| 规模目标 | **target_words**(整书目标字数,新增) | 数字 |
| 卷规模 | volume_size(每卷章数) | 数字 |
| 账本 | leads.enabled / leads.thresholds | 多选 / 阈值表 |
| 预算 | budget.calls_per_chapter / input_per_chapter / summary_* | 数字 |
| 文风 | style.injection(light / heavy) | 开关 |
| 短篇 | short.strict | 开关(短篇) |

### 8.2 文风铁律编辑

`文风/文风铁律.md`(MD 编辑器):反 AI 味 / 禁词 / 可量化约束,机检按此实时核对。

### 8.3 知识层管理

- `knowledge`:知识层 references 增删查(带 `source` / `license`)
- `learn`:文风样章收割(候选制:扫正文 → 打分候选 → 作者审入样章库)

### 8.4 导入 / 导出 / RAG

- `import`:参考作品导入(length-routing 分流长 / 短篇)
- `export`:定稿导出(多形态:TXT / DOCX / 干净导出 / **发布导出**——剥离 front matter → 纯正文 TXT,可直接贴平台)
- `enable-rag`:RAG 插件(key / 端点,可选)

### 8.5 宿主认证配置(按 host;首版只 CC)

- CC:`ANTHROPIC_API_KEY` 或网关(`ANTHROPIC_BASE_URL` + `AUTH_TOKEN`)
- Codex:首版不做(决策 22);未来走 ChatGPT 订阅(device code)或 API key
- 存储:key 不进 git(`.cache` 或系统 keychain)

---

## 第 9 节 Driver 抽象层(B 编排:单步生成器)

统一两宿主,GUI 不感知差异。

### 9.1 宿主选择在建书时(已定)

- `book.yaml` 增 `host: cc | codex` 字段。
- **首版只生成 CC 壳**(`.claude/agents/*.md`);Codex 壳(`.codex/agents/*.toml`)+ `roles/shells.ts` TOML 分支 **待定,首版不做**(决策 22)。
- GUI 用该书 `host`(首版固定 cc);driver 抽象保留双宿主接口,未来可恢复 Codex。

### 9.2 driver 接口(B 编排:窄化为单步生成器)

driver 不编排,只「起会话 + 单步生成 + 事件流」。编排权在 GUI(6.1 / 6.4)。

```ts
interface StudioDriver {
  startSession(cwd, opts): Promise<Session>       // 起会话(带项目上下文;不注入 SKILL.md)
  spawnRole(session, role, prompt): void          // 主操作:以角色系统提示起单步生成(B 默认)
  send(session, prompt): void                     // 辅:软触发主 agent 编排(仅 outline 等多源合成)
  stream(session): AsyncIterable<DriverEvent>     // 流式事件
  respondApproval(session, approval): void        // 审批 / 选择回灌(approval_request 的回应;区别于 CLI `confirm` 确认细纲)
  resume(sessionId): Promise<Session>             // 续会话
  dispose(session): void                          // 结束会话
}

type DriverEvent =
  | { type: 'init'; sessionId; agents; tools }       // 会话就绪(CC system.init / Codex thread.started)
  | { type: 'text'; text; role? }                    // 流式文本(role?: 区分主 agent vs 子角色产出)
  | { type: 'tool_use'; tool; input; role? }         // 工具调用
  | { type: 'tool_result'; result; role? }           // 工具结果(含 subagent 输出)
  | { type: 'role_spawn'; role; parentToolUseId }    // 角色 spawn 检测
  | { type: 'approval_request'; id; choices; detail }// 审批请求
  | { type: 'usage'; cost; tokens }                  // 增量成本(实时回显)
  | { type: 'error'; kind; message; recoverable }    // auth / rate_limit / timeout / network / tool_denied / protocol
  | { type: 'interrupted'; reason }                  // user_cancel / timeout / session_lost
  | { type: 'done'; cost; usage; reason }            // reason: success / cancelled / error
```

`spawnRole` = B 默认(单步生成,6.4 主策略);`send` = 辅(多源合成的少数步骤)。CC 用 CLI headless `stream-json` 实现;Codex app-server 首版不做,未来恢复时再接。

**session 模型**:一个 book 一个 driver session(`startSession` 时起,后端「地图 `bookId → session`」)。`send`(onboard 设定累积 / outline 多源合成)在主 session 内 `resume` 带历史上下文;`spawnRole`(draft / review / 改写)起干净子会话(只带角色系统提示 + 本次 prompt,不 resume、不带主 session 历史)——故 onboard 的设定累积不污染写作的干净生成。切书:`dispose` 旧 + `startSession` 新。SSE 流一个 book 一个,多角色事件用 `DriverEvent.role?` 字段区分。

### 9.3 认证(首版只 CC)

- CC:Anthropic API key(必填),允许自定义 `ANTHROPIC_BASE_URL`(网关)。
- Codex:**首版不做**(决策 22);未来恢复时走 ChatGPT 订阅(device code)或 API key。

### 9.4 两宿主实现要点(基于 PoC)

**CC(CLI headless,复用用户认证;v0.4 从 SDK 改 CLI)**:
- 实现:`spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--allowedTools', ...])` 子进程;driver 继承 env(ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL 网关),**自身不碰认证**
- **架构红线:GUI 不直连大模型**——Node 后端禁止 `import` SDK / `fetch` 大模型 API,所有 AI 流量经 `claude` 子进程(复用用户 Pro/Max OAuth 或 GLM 网关 base_url);driver 唯一职责 = spawn CLI + 解析 stream-json
- **B 模式不注入 SKILL.md**(2.3 验证):driver startSession = 起 CLI 进程(不传 SKILL);八阶段编排由 GUI 显式调 spawnRole / send / clwriting CLI
- `spawnRole`:读 `.claude/agents/<role>.md` 取 frontmatter 后正文作系统提示,起独立 `claude -p`(干净上下文,`--allowedTools ''`,不 `--resume`)
- `send`:主 agent 软触发(`--allowedTools 'Agent,Task,Read'`,`--resume` 续主 session 累积上下文)
- 事件:解析 `--output-format stream-json` 的 JSON 事件流(assistant text / tool_use / tool_result / result cost),滤 GLM thinking_tokens 噪声
- 权限:`--allowedTools` 按 step 控(spawnRole 禁工具 / send 放 Agent+Read / finalize 走 clwriting CLI)
- **role 映射**:`spawnRole(role, prompt)` 的 `role` = 角色 id(writer / continuity-review / editor-review / reader-review)

**Codex(app-server JSON-RPC)——首版不做,待定(决策 22)**:
- 未来实现:`codex app-server --listen stdio://`,Node 客户端 JSON-RPC
- 角色:需 `.codex/agents/*.toml`(`roles/shells.ts` 加 TOML 生成)
- 审批:server-initiated `requestApproval` → GUI 弹窗 → `acceptForSession`
- 认证:config.toml `experimental_bearer_token` vs auth.json `OPENAI_API_KEY` 选用(见 memory `codex-ccats-可用`)

**✅ 可靠性已实证(2.2 PoC,2026-06-22,`cc-reliability.mjs`)**:spawnRole(writer)×5 **成功率 100%**(平均 771 字/轮,全产出有效正文,无乱调工具);send(软触发 Agent)×3 **成功率 100%**(全调 `Agent` 工具,`subagent_type` 全对 "writer",未 spawn 错角色)。B 编排在 GLM 下可靠。**观察**:产出正文出现 `# 第一章` MD 标题——印证 6.2「writer.md 补禁 MD 语法」的必要性(否则 GLM 默认用标题)。

---

## 第 10 节 分步实施路线(按 driver 依赖度切分;细化见 13.3)

**Step 1 · 不依赖宿主(纯确定性,可先做)**:工程骨架 → 书架 → 统计台 → 建书段 1 → MD 编辑器(13.3 的 1.1–1.6)。

**Step 2 · 依赖宿主(driver 就绪后)**:driver 抽象 + **CC 实现**(Codex 首版放弃,决策 22)→ 建书段 2 → 工作台八阶段 + 改写(13.3 的 2.1–2.5)。

> 子步交付物 + 验证检查点 + MVP 边界 + 依赖顺序 → **见 13.3**。

---

## 第 11 节 待定与 PoC

**已解决(深化 / PoC 期间)**:driver PoC(CC 通,见 2.3)· 关系图剔除(7.5,角色无关系字段)· 受控模式边界(6.4)· 超期→停滞口径(7.3,LeadStatus 无原生超期)· 状态机存储(detectState 运行时推断)· GUI 对 init 三增强(5.1)· driver 接口双策略 send/spawnRole(9.2)· **默认宿主 CC**(5.1/9.3)· **target_words 字段**(7.2/8.1,完成度直除)· **枚举确认**(7.4,HookLevel/Emotion/HookType)· **SKILL.md 验证:未被自动读,driver 须注入**(2.3/9.4)· **编辑器 CodeMirror 双模式**(6.2,正文纯文本可直接发布 / 设定 MD)· **短篇清单视图**(6.5 篇详情,情绪曲线为主图;7.3 短篇分支改集子总览)· **编排权归 GUI / driver 窄化**(6.1 / 6.4 / 9.2,B 决策,不注入 SKILL.md)· **GUI 与 CLI 并行 + 写并发模型**(1.5,共享真源,单写者协作)· **工程方案**(第 12 节,技术栈 + studio 挂载 + REST/SSE 契约 + 多书管理)· **prompt 工程**(6.6 工作台 outline/draft/review + 5.3 建书段 2 + 6.7 改写,各步组装公式 + 示例)· **八阶段 UI 状态机**(6.8,四类状态机 + 跨步推进 + 中断恢复)· **driver 细节缺口**(role 映射 / session 模型 / 错误语义 / prepare / 短篇端点 / studio 集成)· **首版只 CC,Codex 暂缓**(决策 22)· **横切关注**(第 13 节,测试策略 / 性能 / 实施路线细化 + MVP)· **driver 可靠性 PoC 通过**(2.2,spawnRole / send 双 100%,9.4 风险证伪)。

**仍待定(不阻塞)**:**无**。driver 细节缺口 + 横切 + driver 可靠性实证(2.2 PoC 通过,spawnRole / send 双 100%)均已清。**Codex 支持首版放弃**(决策 22)。当前主线已进入实现收口,Step1 + Step2.1-2.5 均已落地。

---

## 第 12 节 工程方案(v0.3 新增)

### 12.1 技术栈(已定)

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Node 原生 `http` | 零运行时依赖,贴合 `node:sqlite` 哲学;REST 路由手写极简分发器,不引框架 |
| 前端 | Vue 3 + Vite | 轻 + 中文生态强 + SFC 直观;React 对本地 GUI 过重,Svelte 生态偏小 |
| 图表 | ECharts | 类型全覆盖(折线 / 柱 / 热力 / 矩阵),中文最强;体积本地不在意 |
| 编辑器 | CodeMirror 6 | 已定(6.2);扩展 `lang-markdown` / `diff` |
| 流式 | SSE | driver 事件 server→client,SSE 天然适配 + 自动重连;WebSocket 双向浪费 |

**取舍**:后端用原生 `http` 而非 Fastify / Hono——CLWriting 内核是「无构建无依赖」,GUI 后端同构;REST 端点不多,手写分发器比引框架干净。前端 Vue 而非 React——本地 GUI 不需 React 生态体量,Vue 更轻、中文资料多。

### 12.2 `clwriting studio` 挂载 + 目录结构

**子命令**:`clwriting studio [--port N] [--book <path>]`
- 注册到 CLI 命令分发(新分支,不动现有命令);执行后进 server loop **常驻**(不进状态机轮转),Ctrl+C 停——仍是 `clwriting <command>` 单入口之一,只是其「执行」= 起常驻 server
- 起后端 server(默认 `127.0.0.1:7cxx`,只监听本地)→ 静态托管前端 `dist/` → 自动开浏览器
- `--book` 直进某书;省略进书架(12.4)

**目录结构**(GUI 代码隔离在 `src/studio/`,不侵入内核):

```
src/studio/
├── server/              后端(Node 原生 http)
│   ├── index.ts         起 server + 静态托管 + 路由
│   ├── router.ts        极简 REST 分发器
│   ├── api/             REST 端点(调 CLI / 读 MD)
│   ├── driver/          driver 抽象层(第 9 节;首版只实现 CC)
│   │   ├── cc.ts        CC(CLI headless)实现
│   │   └── codex.ts     Codex 实现(首版不做,待定)
│   ├── sse.ts           SSE 流(driver 事件 → 前端)
│   └── studio-cli.ts    clwriting studio 子命令入口
├── web/                 前端(Vue 3 + Vite)
│   ├── src/
│   │   ├── pages/       建书台 / 工作台 / 统计台 / 设定台
│   │   ├── components/  图表 / 编辑器 / diff / 流程台
│   │   ├── stores/      状态(书 / 会话 / 流程态)
│   │   └── api/         调后端 REST + SSE 订阅
│   └── dist/            构建产物(server 静态托管)
└── shared/              前后端共享类型(DriverEvent / MetricsReport / ...)
```

**关键**:`src/studio/` 与现有 `src/`(CLI 内核)平级,不侵入内核;`driver/` 在 server 侧(后端进程 spawn Claude Code CLI);`shared/` 前后端共享类型;开发时 Vite dev server 代理 API 到后端,生产时 server 静态托管 `dist/`。

### 12.3 通信契约(REST + SSE)

**REST(数据读写 + 触发操作)**,路径前缀 `/api/books/:id`,下表 `...` 代表该前缀:

| 域 | 方法 路径 | 作用 | 后端 |
|---|---|---|---|
| 书架 | `GET /api/books` | 所有书 | `books.jsonl` |
| 书架 | `POST /api/books` | 新建(段 1 表单) | `init` |
| 身份 | `GET ...` | 单书身份 | `book.yaml` |
| 状态 | `GET .../state` | 当前状态机位置 | `detectState` |
| 流程 | `POST .../outline` | 生成细纲 | `send` → SSE |
| 流程 | `POST .../confirm` | 确认细纲 | CLI `confirm`+`record-call` |
| 流程 | `POST .../draft` | 写稿 | `spawnRole(writer)` → SSE |
| 流程 | `POST .../check` | 机检 | CLI `check` |
| 流程 | `POST .../review` | 三审 | `spawnRole` ×3 → SSE |
| 流程 | `POST .../finalize` | 定稿 | CLI `finalize` |
| 改写 | `POST .../rewrite` | 局部改写 | `spawnRole` → SSE |
| 回滚 | `POST .../revert` | 版本回滚 | CLI `revert` |
| 体检 | `GET .../health/metrics` | 成本 / 审查 | `health --metrics` |
| 体检 | `GET .../health/style` | 文风 | `health --style` |
| 账本 | `GET .../leads` | 七类(长)/ 集子总览(短) | `大纲/<七类>` / `篇/` |
| 节奏 | `GET .../rhythm` | 章节节奏 | 草稿 / 细纲 front matter |
| 总览 | `GET .../overview` | 项目总览 | `book.yaml` + 定稿 |
| 配置 | `GET/PUT .../config` | book.yaml 读写 | `book.yaml` |
| 文件 | `GET/PUT .../file/:path` | 任意 MD 读写(编辑器) | MD 真源 |
| 建书 | `POST .../onboard-ai` | 段 2 AI 填设定某步 | `spawnRole('onboard')`→ 落盘 |
| 导出 | `POST .../export` | 导出(含发布导出) | `export` |

**短篇**:复用同套端点,后端按 `book.yaml kind` 分轨——短篇 finalize 跳形式三检、review 对 `清单.md`(反转线索表 + 伏笔回收)核对、单位换篇;不必独立端点。

**SSE(driver 事件流)**:
- `GET .../stream` — 订阅 driver 事件
- 前端 POST 触发操作(outline / draft / review / rewrite / onboard)→ 后端起 driver 会话 → 事件经 SSE 推送 → 前端实时回显
- SSE 事件 = `DriverEvent` 序列化(text / tool_use / role_spawn / usage / done / error / interrupted)
- 断开自动重连;session 在后端保持(地图 `bookId → session`)
- **错误语义**:同步错误(参数错 / 未认证 / 书不存在)→ REST 直接返回 4xx / 5xx;异步错误(会话过程中 auth 失效 / 超时 / 网络断)→ SSE 推 `error` 事件(`DriverEvent.error`)。即 POST 返回 200 = 接受请求,过程结果(含 error / done)走 SSE

### 12.4 多书管理 / 书架

- **书架为 GUI 入口**:`clwriting studio`(不带 `--book`)→ 书架,展示所有书(书名 / 题材 / kind / host / 进度 / 最近活动)
- **单书焦点**:GUI 同刻只在一本书里工作;选书 → 切 cwd + driver `dispose` 旧会话 + `startSession` 新书
- **切书**:顶部常驻书名(回书架)/ 切书下拉
- **最近书**:书架顶部「最近打开」(按 mtime)
- **多 tab**:server 单进程,多 tab 共享后端 → 仍单书焦点(切书即切 cwd,所有 tab 同步)

---

## 第 13 节 横切关注(测试 / 性能 / 实施路线)

### 13.1 测试策略

**driver 测试(mock CC)**:driver 是技术心脏,但真调 CC 贵且慢。用 **mock driver**(按脚本回放预录事件序列)测接口契约:事件流序列(init→text→tool_use→...→done)、role 映射、error / interrupted 处理、session resume。夹具:预录「事件序列」(如一次完整 draft 流)。

**GUI 测试**:
- 组件测(Vitest + @vue/test-utils):图表(体检 / 账本 / 情绪曲线)、编辑器、diff、流程台状态机
- e2e(Playwright):关键路径(建书段 1 提交、体检页加载、八阶段状态流转——用 mock driver)

**双轨回归**:长 / 短篇 fixture(小型书仓库),每次改 GUI 跑双轨(长篇八阶段 + 短篇 P1–P4 都走通)。fixture 放 `src/studio/test/fixtures/`。

**CLI 契约**:GUI 后端调 CLI 命令,只测「调用 + 解析」(CLI 内核本身已测,不重测)。

### 13.2 性能考量

| 场景 | 策略 |
|---|---|
| 大书 metrics(几百章) | 分页(按卷 / N 章)+ 懒渲染(可视区先算)+ 增量(只算新增章) |
| 账本矩阵(章 × 线) | 虚拟滚动 + 卷级折叠 + ECharts `dataZoom` |
| 编辑器大文件 | CodeMirror 6 自带虚拟滚动;集子(多篇)篇列表分页 |
| SSE 长流式(draft) | 前端节流(批量更新 DOM,不逐事件重渲) |

**原则**:本地单用户,瓶颈在「大书全量计算」不在并发——分页 + 懒 + 增量足矣,不做重型缓存。

### 13.3 实施路线细化

**Step 1(不依赖 driver,纯确定性)**:

| 子步 | 交付物 | 验证检查点 |
|---|---|---|
| 1.1 工程骨架 | `clwriting studio` + Node http server + Vue 脚手架 + REST 分发 + 静态托管 | 起服务、浏览器开、书架页渲染 |
| 1.2 书架 + 单书导航 | `GET /api/books` + 切书 | 书架展示所有书,选书进单书 |
| 1.3 体检页 | `GET /api/health/*` + ECharts | 三块图对照 `health` 命令输出 |
| 1.4 统计台其余 | 账本 / 节奏 / 总览 / 设定(P0→P1) | 各页字段对照数据源 |
| 1.5 建书段 1 | 表单 + `init` + host 选择 | 表单提交建书,`book.yaml` 正确 |
| 1.6 MD 编辑器 | CodeMirror 双模式 + 版本回滚 | 编辑正文 / 设定,回滚生效 |

**Step 2(依赖 driver)**:

| 子步 | 交付物 | 验证检查点 |
|---|---|---|
| 2.1 driver 抽象 + CC 实现 | `StudioDriver` + cc.ts + mock | mock 事件流正确;真 CC smoke 一次 draft |
| 2.2 driver 可靠性 PoC | 多轮 spawnRole / send 实证 | ✅ **已通过**(2026-06-22,spawnRole 5/5 + send 3/3,见 9.4) |
| 2.3 工作台八阶段 | outline / draft / check / review / finalize + 状态机 | 八阶段状态流转(mock + 真 CC) |
| 2.4 建书段 2 | onboard 单步生成 + AI 填设定 | 段 2 各步生成 → 落盘 |
| 2.5 改写 | 局部改写 + 整章返修 + diff | diff 确认落盘 / 拒绝 |

**MVP 边界**(首个可用版本):Step 1 全 + Step 2.1–2.3(driver + 八阶段)。即:能建书(段 1)+ 统计台全 + 工作台写完一章。当前主线已越过 MVP,Step 2.4(建书段 2)与 Step 2.5(改写)也已落地。

**依赖顺序**:1.1 → 1.2 →(1.3–1.6 并行)→ 2.1 → 2.2 → 2.3 →(2.4 / 2.5)。

---

## 附:决策记录(本次讨论已定)

1. GUI 路线:本地 server + 浏览器(非 Electron);GUI 是壳,CC/Codex 是大脑。
2. 宿主选择:**建书时选**(每书绑 host,非全局)。
3. 受控模式:**软触发 + 关键单步独立起会话**(采纳建议)。
4. 统计:五域全做,双轨感知。
5. 修改文章:编辑器 + 局部改写 + 整章返修,分步骤上;编辑器走 **MD / 纯文本双模式**(正文纯文本可直接发布,设定 MD;非富文本,见 6.2)。
6. 建书向导:段 1 表单 + 段 2 AI 填设定(解决 init 空壳痛点),对接 spiral。
7. 参考项目(webnovel / character-arc)只作功能参考,功能从 CLWriting 自身内生推导。

**深化期间追加(v0.2)**:

8. 关系图剔除——角色无关系字段,数据基础不足(7.5)。
9. 账本「超期」→「停滞」口径——`LeadStatus` 无原生超期,GUI 衍生判定(7.3)。
10. GUI 对 init 三增强——新增 `host` / 简介 / kind 预览(5.1)。
11. driver 接口双策略——`send`(软触发)+ `spawnRole`(独立起会话)(9.2)。
12. `book.yaml` 新增 `host` 字段——建书时写入,段 2 AI 填设定即用该宿主。

**v0.2 收尾定稿(2026-06-22)**:

13. 默认宿主 **CC**——建书未选 host 时缺省 cc(API key 成本可控;Codex 订阅作高级选项)。
14. `book.yaml` 新增 **`target_words`**——完成度直除,弃估算。
15. 枚举确认——`HookLevel`(强/中/弱)、`Emotion`(压抑/铺垫/小爽/大爽/转折)、`HookType`(5 类);节奏页图例据此(`format/types.ts:135-146`)。
16. **SKILL.md 未被 CC 自动读**(`cc-skill-check.mjs` 验证)——B 编排决策(见 19)后,driver **不注入** SKILL.md;编排权归 GUI,SKILL.md 是人工模式专用。
17. 编辑器 **CodeMirror 双模式**——正文纯文本(禁 MD 语法、可直接发布、允许场景分隔 `* * *`、标点照常);设定 MD;`writer.md` 补禁格式、`export` 加「发布导出」。
18. **短篇清单归工作台「篇详情」**——正文 + 元数据 + 清单三段同屏(情绪曲线 P0 主图,反转线索表 / 伏笔回收配套);统计台账本页短篇分支改「集子总览」(跨篇聚合)。形态服从数据:清单单篇闭合 → 嵌篇详情;长篇账本跨章 → 独立页。
19. **编排权归 GUI(B 决策)**——八阶段由 GUI 显式调每步(`spawnRole` 单步生成 + `send` 多源合成 + CLI 直调),driver 窄化为「单步生成器」,**不注入 SKILL.md**。SKILL.md 变「人工模式专用」(作者手动开 CC 时仍用)。GUI 模式与 CC 自编排是两套并行逻辑,底层 CC / CLI 内核不变(见 1.5)。
20. **GUI 与 CLI 并行可用**(1.5 节)——共享同一份 MD 真源 + `.cache` + git,GUI 不建第二数据;切换 / 并行架构免费。写并发用「单写者协作」(GUI 写 `.gui-active`、CLI 向后兼容、git 兜底),不动 CLI 核心。
21. **工程方案**(第 12 节)——技术栈:Node 原生 `http` + Vue 3 / Vite + ECharts + CodeMirror 6 + SSE(轻量 / 中文友好 / 零后端依赖,贴合内核哲学);`clwriting studio` 子命令起本地 server;GUI 代码隔离 `src/studio/`(不侵入内核);REST + SSE 通信契约;书架为入口、单书焦点。
22. **首版只支持 CC,Codex 暂时放弃**(2026-06-22)——driver 抽象层保留双宿主接口(未来可恢复),但 v0.3 / 首版只实现 CC:只生成 CC 角色壳、只做 CC 认证、Codex driver 实现标待定。简化首版,集中把 CC 链路做扎实;Codex 的 PoC 复验、TOML 角色生成都暂缓。
23. **横切关注**(第 13 节)——测试:driver mock + GUI 组件 / e2e + 双轨回归;性能:分页 / 懒渲染 / 虚拟滚动(大书场景);路线:Step1(1.1–1.6)+ Step2(2.1–2.5),**原 MVP = Step1 全 + Step2.1–2.3**,当前主线已越过 MVP 并完成 Step2.4/2.5。
24. **driver 可靠性 PoC 通过**(2026-06-22,`cc-reliability.mjs`)——spawnRole(writer)×5 成功率 100%(平均 771 字,全有效正文);send(软触发 Agent)×3 成功率 100%(`subagent_type` 全对)。**B 编排在 GLM 下可靠**,9.4 风险证伪消解。观察:产出含 `# 标题`,印证 writer.md 须补「禁 MD 语法」(6.2)。**已支撑实施落地**。

---

## 附二:维护检查清单(深化后必扫,防迭代债)

每次深化方案后,除改新增处,**必扫这些「汇总性段落」保持同步**(历史教训:状态行曾 3 次过时):

- [x] **状态行**(文档头 `> 状态:`)—— 已同步到 2026-06-24 实现收口口径
- [x] **第 10 节**(分步路线)—— 与 13.3 细化版 + Codex 决策(22)一致
- [x] **第 11 节**(待定与 PoC)——「已解决」/「仍待定」反映最新状态
- [x] **决策记录**—— 当前 24 条,无新增决策编号
- [x] **旧表述残留**—— 短篇清单 / outline 策略 / Codex 口径 / 宿主选择 已扫;未发现阻塞性残留
- [x] **命名一致性**—— 接口 / 端点 / 字段保持当前实现口径;`respondApproval` 仍为 driver 预留能力,CLI `confirm` 为确定性步
