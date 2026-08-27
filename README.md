# CLWriting

帮中文网文作者写书的 AI 工具。装在自己电脑上是个桌面应用：AI 出初稿，程序管检查和记账，你负责审稿和拍板。两种写法都支持——连载的长篇，或者一篇一个故事的短篇集。

一本书就是一个普通文件夹，里面全是 Markdown 和 YAML，放在你自己的磁盘上。设计目标是长篇写到两百万字量级还不崩设定、不吃书——这事不指望 AI 自觉，靠账本核对、伏笔追踪、版本快照这些机制兜底。

[![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Test](https://img.shields.io/badge/tests-3849%20all%20green-4FC08D?logo=vitest&logoColor=white)](#开发)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 写一本书的流程

1. **建书。** 应用里填书名、选题材、选长篇或短篇集，目录结构自动生成。
2. **写设定。** 大纲（长篇有总纲、卷纲、章纲；短篇的章纲里带反转线索表和情绪曲线）、角色、世界观、物品，都在表单里填。
3. **写正文。** 可以自己在编辑器里写；也可以点「全自动写章」——AI 起草，程序跑机检（复读、句式、禁词、比喻密度这类能量化的问题），报红就自动打回重写，全绿了才交给你过目，重试到上限会停下来问你，不会闷头烧钱。
4. **审稿。** 三审：长篇是读者视角、编辑视角、设定校对；短篇是钩子、情绪反转、设定收尾。审完你裁决，改不改你说了算。
5. **定稿。** 逐章确认。定稿前有一道「防吃书」检查：账本里声明的设定和正文实际写的对不上号，会拦下来让你先处理。

写作过程中还有一批配套：伏笔从埋设到回收全程有记录，埋了没收会提醒；字数曲线对照规划，节奏跑偏提前预警；文风系统维护样章、手法、禁词条目库，机检和 AI 都按它来；选中一段文字可以让 AI 改写或分析（情绪曲线、钩子强度、文风漂移）；工作台里有个对话助手，能替你做查资料、改文件这类操作，有风险的动作会先问你。

## 安装和上手

要 Node 24 及以上。

```bash
npm install
npm run dev:api     # 终端 1：先起 API 服务（:7878）
npm run dev:app     # 终端 2：再起桌面应用（HMR，加载 :5173 的 Vite）
```

`dev:app` 开发态不内嵌 API——所有 `/api` 请求经 Vite 代理转发到独立的 `dev:api`（7878）。只开 `dev:app` 不开 `dev:api` 时，应用打开正常，但一碰需要后端/AI 的操作就会报「本地服务未连接」（旧版本误报「AI 服务繁忙」），记得两个终端一起跑。

应用打开后，先去「设置 → AI」加一家供应商：Anthropic 官方、Claude 中转、OpenAI 兼容接口（Chat Completions 或 Responses 协议）都行。填好地址和 Key，点「测试连接」，通了就能建书开写。Key 在本机加密存储，不会进 git，也不会明文出现在任何日志里。

之后所有操作都在界面里完成：建书、写设定、写章、审稿、定稿、导出。

## 书在磁盘上长什么样

长篇的书，文件夹大致是这样：

```text
我的书/
├── book.yaml           # 这本书的配置：题材、字数目标、机检阈值、AI 调用预算
├── 写作/正文/第一卷/    # 正文章节，按卷分目录
├── 大纲/               # 总纲.md、卷纲/、章纲/
├── 布线/               # 悬念、感情线等线索的伏笔档案
├── 设定/               # 角色、物品、伏笔、世界观、人物名册
├── 文风/               # 文风铁律 + 条目库（禁词、样章、手法）
├── 工作区/             # 草稿、待定稿（自动连写的攒稿区）
├── 定稿/正文/          # 定稿后的章节落这里
├── 项目/               # 文档清单、字数日记这些内部账本
├── .版本/              # 每次保存前的历史快照，可恢复
└── .cache/rag.db       # 全书设定的本地检索索引（SQLite）
```

短篇集用同一套目录，只是没有卷纲和布线，章纲换成反转线索表、情绪曲线、伏笔回收三段式。

编辑器自动保存（手动 ⌘S 也行），保存带版本校验——同一章要是在别处改过，会提示你选「重载」还是「覆盖」，不会悄悄吞掉任何一版。每次保存前自动留快照，章节历史面板里能恢复任意一版，恢复动作本身也会先留底。

机检阈值、调用预算这些默认值，可以在 book.yaml 里按书调，也可以在设置里定全局默认让新建的书自动继承；标了「全局固定」的项以全局为准。

应用自己的数据（供应商配置、全局设置、事件记录）放在 userData 目录（macOS 是 `~/Library/Application Support/CLWriting`），和书稿分开，升级应用不会动你的书。

## 安全

应用启动时会在本机起一个 HTTP 服务，只绑 127.0.0.1，局域网和外网都连不进来。那还要防什么？防的是你浏览器里开着的其他网页——它们理论上可以借跨站请求或 DNS rebinding 来读你的书稿、伪造操作。所以服务端还有三层：

- Host 头必须精确匹配本机地址加端口，挡 DNS rebinding；
- Origin 走白名单，别的网页发来的写请求直接 403；
- 所有写接口还要带上启动时随机生成的会话令牌。

GET 读接口不校验令牌，这是有意的设计：令牌防的是远端网页，不防你电脑上的其他程序——本机进程和这个服务本来就在同一个信任域里。具体到机制：启动时随机生成的会话令牌由 `GET /api/boot` 发放，本机任何程序都能调这个接口拿到它，所以它只构成「网页拿不到」这一层防线；如果你在本机跑着不受信任的程序，请把它当能完全读写书稿的进程对待。

## 开发

```bash
npm --prefix src/studio/web-next ci   # 装前端子包依赖（CodeMirror 等；新克隆必跑，见下）
npm run typecheck          # tsc --noEmit
npm run build:all          # 桌面主进程 + 前端构建
npm test                   # 3849 单测
npm run test:e2e           # Playwright e2e（mock 驱动，29 specs / 44 用例）（其中常规命令跑 42，另 2 个发布 smoke 需 CLWRITING_E2E_RELEASE）
npm run dev:api            # 只起 Studio API :7878（配合 dev:app / dev:web）
npm run dev:web            # Vite HMR :5173（配合 dev:api）
npm run dev:app            # 桌面应用（HMR；需先有 dev:api，见「安装和上手」）
npm run dev:electron       # 构建后起 Electron（非 HMR）
npm run build:desktop      # electron-builder 打包 dmg
npm run lint               # ESLint（JS/MJS 最小门：no-unused-vars / no-undef）
npm run check:counts       # 核对 README 里的测试数和实际是否一致
```

前端子包 `src/studio/web-next` 有自己的 `package.json` 和二级 `node_modules`（CodeMirror 等钉在那里，根目录的 `npm install` 不会带下来）。新克隆后要先补装上面第一行（CI 同款命令；本地改前端依赖时把 `ci` 换成 `install`）——不装的话 `npm test` 会在打字机相关用例上报模块解析失败，`build:web` / `dev:web` 也起不来。

改完代码至少跑 `npm test`：464 个测试文件 / 3849 单测全绿是合入门槛，CI 里的 check:counts 会核对 README 声称的数字，对不上直接红。动了前端就再跑 `vue-tsc` 和 e2e。e2e 的 29 个 spec 共享单一临时 workDir、按 spec 固有顺序跑（前一个建的书/写的内容供后一个用）——勿加并行或改动 spec 顺序，否则隐式依赖会静默错。

## 技术栈

Node 24+，TypeScript strict。前端 Vue 3 + Pinia + Vite，编辑器 CodeMirror 6，桌面壳 Electron；存储是 node:sqlite（RAG 索引）加 JSON/YAML 配置；AI 侧三个协议适配器（Anthropic、OpenAI Chat、OpenAI Responses）统一走 runTask 编排，重试、超时、用量都归它管；测试 vitest（3849 单测）+ Playwright（29 specs / 44 用例）（常规命令跑 42，2 个发布 smoke 需 CLWRITING_E2E_RELEASE 环境变量）。

代码上有几条一直守着的规矩：作者数据不被升级覆盖；定稿走原子写入加指纹校验；api_key 不进 git；服务端不 spawn 任何 CLI 子进程，要用的内核模块直接 import；对话和工作流的事件 append-only 全量落库（每本书一个 SQLite，在 userData 下），要清理去「事件审计」视图里手动删。

## 致谢

设计上参考过这些开源项目：

- [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)——架构思想来源；本项目是从零重写的
- [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)（MIT）——长篇写作方法论
- [character-arc](https://github.com/uu201/character-arc)（MIT）——角色弧线与设定方法论

## 许可证

[MIT](LICENSE)
