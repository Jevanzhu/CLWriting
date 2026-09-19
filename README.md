# CLWriting

帮中文网文作者写书的 AI 工具。装在自己电脑上是个桌面应用：AI 出初稿，程序管检查和记账，你负责审稿和拍板。两种写法都支持——连载的长篇，或者一篇一个故事的短篇集。

一本书就是一个普通文件夹，里面全是 Markdown 和 YAML，放在你自己的磁盘上。设计目标是长篇写到两百万字量级还不崩设定、不吃书——这事不指望 AI 自觉，靠账本核对、伏笔追踪、版本快照这些机制兜底。

[![Node](https://img.shields.io/badge/Node-%E2%89%A524-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Test](https://img.shields.io/badge/tests-7769%20all%20green-4FC08D?logo=vitest&logoColor=white)](#开发)
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

## Windows 版使用须知

Windows 包（NSIS x64）是第一版，几件事提前说清：

- **安装包未做代码签名。** 首次运行时 Windows SmartScreen 可能提示「Windows 已保护你的电脑」——点「更多信息」→「仍要运行」即可，这是无签名分发的正常提示，不是文件损坏。
- **没有自动更新。** 新版本要手动下载安装包覆盖安装（先退出应用再装）。书稿都在书库文件夹里，重装应用不影响内容。
- **先装 Git。** 旧书的历史迁移等功能依赖 Git；没装会明确提示，装 [Git for Windows](https://gitforwindows.org/) 后重启应用即可。
- **书库别放在 OneDrive、坚果云等同步盘里。** 应用的保存与检索要独占锁文件和 SQLite 索引，同步盘的实时同步会与之冲突，还可能造出「冲突副本」文件。坚果云式冲突副本能自动检测提醒；OneDrive 式副本（文件名带计算机名后缀）认不出来，只能靠你避开。
- **路径别太深。** Windows 对超长路径支持有限，书库放在浅层目录、总路径 200 字符以内最稳。
- **应用数据在** `%APPDATA%\CLWriting`（供应商配置、全局设置、事件记录），和书稿分开，升级/重装不动书稿。

## macOS 版使用须知

macOS 包（dmg）与 Windows 版一样是第一版，几件事提前说清：

- **安装包未做开发者签名与公证（ad-hoc 签名）。** 把 dmg 里的应用拖进「应用程序」后首次打开，macOS 可能提示「无法打开，因为它来自身份不明的开发者」，个别版本提示「应用已损坏」——这是无正式证书分发的正常提示，不是文件损坏。处理：在访达里**右键点应用图标 →「打开」→ 再点「打开」**；仍提示「已损坏」时，终端执行 `xattr -cr /Applications/CLWriting.app` 后再打开。
- **安装包仅支持 Apple Silicon（M 系芯片）。** Intel 芯片的 Mac 暂无可用安装包；下载 dmg 前先确认芯片型号（苹果菜单 → 关于本机）。
- **没有自动更新。** 新版本同样手动下载 dmg，先退出应用再拖入覆盖。
- **书库放在默认磁盘上，别放在手动格式化成「大小写敏感 APFS」的卷。** 大小写敏感卷上能造出仅大小写不同的书名/文件名（「Book」与「book」并存），整库拷到 Windows 或默认 macOS 后会被系统合并成同一个，内容以一边为准；Windows 与默认 macOS 的书库互拷不受影响。

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
├── .版本/              # 保存前自动留底的历史快照（分层保留），可恢复
└── .cache/rag.db       # 全书设定的本地检索索引（SQLite）
```

短篇集用同一套目录，只是没有卷纲和布线，章纲换成反转线索表、情绪曲线、伏笔回收三段式。

编辑器自动保存（手动 ⌘S 也行），保存带版本校验——同一章要是在别处改过，会提示你选「重载」还是「覆盖」，不会悄悄吞掉任何一版。保存前自动留快照（同一来源短窗内合并留一次，越近留得越细），章节和文档的历史面板里能恢复留底的各版，恢复动作本身也会先留底。

机检阈值、调用预算这些默认值，可以在 book.yaml 里按书调，也可以在设置里定全局默认让新建的书自动继承；标了「全局固定」的项以全局为准。

应用自己的数据（供应商配置、全局设置、事件记录）放在 userData 目录（macOS 是 `~/Library/Application Support/CLWriting`，Windows 是 `%APPDATA%\CLWriting`），和书稿分开，升级应用不会动你的书。

**换电脑时，把整个书库文件夹复制过去，在新机器的应用里选择它就能继续用**——书库就是一个普通文件夹，Windows 和 macOS 之间互拷无差别。两点注意：别放到大小写敏感的卷上（见上方 macOS 须知）；AI 对话记录和事件审计属于应用数据，留在各机器本地不跟文件夹走（旧机器上不丢，只是不随身）。

## 安全

应用启动时会在本机起一个 HTTP 服务，只绑 127.0.0.1，局域网和外网都连不进来。那还要防什么？防的是你浏览器里开着的其他网页——它们理论上可以借跨站请求或 DNS rebinding 来读你的书稿、伪造操作。所以服务端还有三层：

- Host 头必须精确匹配本机地址加端口，挡 DNS rebinding；
- Origin 走白名单，别的网页发来的写请求直接 403；
- 所有写接口还要带上启动时随机生成的会话令牌。

读接口（GET/HEAD）同样要过令牌闸：除发放令牌的 `/api/boot` 和 SSE 事件流两个例外，其余 API 请求一律校验请求头里的会话令牌——SSE 是浏览器的事件流接口带不了自定义头，凭据只能走查询参数，由它自带的凭据闸把关。这道闸防的仍是远端网页，不防你电脑上的其他程序：令牌由 `/api/boot` 免凭据发放，本机任何程序两步——先调它拿令牌，再带着令牌调接口——就能取得凭据，本机进程和这个服务本来就在同一个信任域里。如果你在本机跑着不受信任的程序，请把它当能完全读写书稿的进程对待。

## 开发

```bash
npm run setup             # 一键装齐双包依赖（根包 npm install + 前端子包 install；新克隆后首跑一次，缺子包依赖时 build:web / build:all 会提示到这里）
npm --prefix src/studio/web-next ci   # 装前端子包依赖（CodeMirror 等；新克隆必跑，见下）
npm run typecheck          # tsc --noEmit
npm run build:all          # 桌面主进程 + 前端构建
npm test                   # 7769 单测
npm run test:related -- src/foo.ts   # 只跑与改动文件 import 相关的单测（日常小改的快速面；合入门槛仍是 npm test 全量）
npm run test:e2e           # Playwright e2e（mock 驱动，33 specs / 54 用例）（其中常规命令跑 51，另 3 个发布 smoke 需 CLWRITING_E2E_RELEASE）
npm run dev:api            # 只起 Studio API :7878（配合 dev:app / dev:web）
npm run dev:web            # Vite HMR :5173（配合 dev:api）
npm run dev:app            # 桌面应用（HMR；需先有 dev:api，见「安装和上手」）
npm run dev:electron       # 构建后起 Electron（非 HMR）
npm run build:desktop      # electron-builder 打包（mac 出 dmg / win 出 NSIS exe）
npm run lint               # ESLint（JS/MJS 最小门 + TS 面 typescript-eslint recommended：src / scripts / test 全部 .ts 纳管）
npm run check:counts       # 核对 README 里的测试数和实际是否一致
```

Windows 在 cmd/PowerShell 里直接跑同一套 npm 命令即可（环境变量写法已由 cross-env 统一，脚本无 POSIX 专属语法；`dev:app` / `dev:electron` 走 Electron 官方入口，工作区路径含 `^` 等特殊字符也正常）。Node 建议 24 或 26 LTS。CI 覆盖盲区披露（R0915-P2，四轮重评处置批）：ci.yml 矩阵为 os×{24,26} 但显式排除 windows×26 腿（R69-6 控成本），desktop.yml 出包腿仅 node 24——即 **win×26 组合无任何 CI 腿背书**，win 侧持续门以 node 24 腿为准；本机 win×26 全量门实录见下方门槛段（负载下 worker OOM 曾于 2026-09-15 四轮重评记录，main.test.ts 监听器治理已处置，win×26 复跑绿与否以下轮全量实录为准——2026-09-17 win 侧收口批 v26.8.1 全量一次全绿实证，治理后未再复发）。

前端子包 `src/studio/web-next` 有自己的 `package.json` 和二级 `node_modules`（CodeMirror 等钉在那里，根目录的 `npm install` 不会带下来）。新克隆后要先补装上面的 `npm --prefix src/studio/web-next ci` 一行（CI 同款命令；本地改前端依赖时把 `ci` 换成 `install`）——不装的话 `npm test` 会在打字机相关用例上报模块解析失败，`build:web` / `dev:web` 也起不来。

改完代码至少跑 `npm test`：1268 个测试文件 / 7769 单测全绿是合入门槛，CI 里的 check:counts 会核对 README 声称的数字，对不上直接红。单测数是 macOS/Linux 口径——win 上平台门（`skipIf(win32)`）的用例进 vitest 收集但按平台门跳过、不计入过数（阶段 21 J3；2026-09-10 全量重审修复批 win 实跑口径：1014 文件 / 6470 过 + 79 跳 0 败，过数实测差 68 恒定〔**2026-09-19 六轮重评修复批 +5 用例/±0 文件（mac 亲跑 1268 文件 / 7769 过 + 8 跳 0 败一次净跑）**：新增测试（gen 流中挂起超时回归×2 / chat-gap 连续溢出合并计数×1 / 拆分·合并干跑预览码位截断×2）全无平台门，win 静态推演 7701 过、锚 68 维持——前锚 **2026-09-19 五轮重评修复批 +15 用例/+1 文件（mac 亲跑 1268 文件 / 7764 过 + 8 跳 0 败一次净跑）**：新增测试（journal 压缩读失败弃轮 / os-kek 缺失不重建对称面×2 / openai 末见 usage / responses function_call 回填×2 / embed 503 body.cancel×2 / 知识注入码点截断 / 切书补全失败清空×2 / 概览伏笔失败置空 / workbench 存稿竞态×2）全无平台门，win 静态推演 7696 过、锚 68 维持——前锚 **2026-09-18 win 实机重锚 64→68**：win←mac 合并批实跑重锚——0918独立重评修复批 D005（check-counts walk symlink 门）it.skipIf(win32) 净 +3（+4/−1）+ 0918三拍板批 os-kek #1 mode 0600 断言补 win 门 +1（两处 mac 侧均按「差值锚 64 维持」静态推断未重锚）；真差值 = 68 实测钉定（2026-09-18 合并批树 7703 − 7635）——前锚 **2026-09-17 mac 实机重锚 81→64**：81 系历史记账值——最后一个 mac 实测锚 = 2026-09-14 mac 适配修复批（1123 文件 / 7261 过，差 80），其后各批全在 win 侧跑门、按收集增量等额上调徽章而未再 mac 重锚，累计漂移 17（本批四处修账 7425→7408 = mac 实测 runnable 口径）；真差值 = 64 实测钉定（2026-09-17 拍板快断批后树 7401 − 7337 复核仍 64），win 预期口径 7339 过 + 72 跳（= 7344 实测锚 + 拍板快断批净 −7〔死码删除 −11：git 域 −3 + install 域 −8；check-counts 分账直测 +4〕+ 同日 CI 复验修复批 +2〔spec-order 定向豁免直测〕；2026-09-17 main CI 首跑该腿死于测试步未达对账，预期口径待实跑核对）。另：树内 darwin 门 1 例 + linux 门 3 例 + DISPLAY 环境门 1 例使 linux CI 收集口径与 mac 恒差 5——ci.yml 仅 main/workflow_dispatch 触发、三线分支零 CI 实跑故未暴露；**2026-09-17 拍板快断批分账处置（台账 §三 G 销案）+ 同日 CI 复验修复批实测修账 4→5**：linux 实测差 5 恒定〔darwin 门 1（books-guard #37，skipIf(!darwin)）+ linux 门 3（r41-join-keys ×1 + r42-join-fold ×2，skipIf(linux)）+ DISPLAY 门 1（r44-close-flush-electron R44-2 实机用例，canRunRealElectron = win32 || darwin || DISPLAY——CI ubuntu headless 无 DISPLAY 即省，桌面 linux 有 DISPLAY 时该门不省、差值回 4）；前四处经 mac vitest list 逐一在册实证，第五处 2026-09-17 main CI 首跑实证（ubuntu 双腿 vitest list 实测 7396 = 7401 − 5——拍板快断批静态盘点只扫平台门、漏了这处环境门）；check:counts linux 腿镜像 win 臂按声称值 − 5 反推核对，README 仍为唯一真相源〕。81 的构成沿革（历史记档）：73 既有 + dev 侧新增 2 个 + 2026-09-12 R0912-3 起新增 4 个（books-guard #37 darwin 门 + r0912-3-knowledge-commit 3 个 win32 权限门）+ 2026-09-14 mac 适配修复批净 +1（win 门 +3〔safe-path 字面反斜杠 1 + r71 posix 形态 2〕/ mac 门 +2〔r71 旧 win 形态 2 例转 skipIf(!win32)〕）+ 2026-09-15 重评-0914-三轮处置批对冲净 0（EACCES 读失败族摘 skipIf(win32) 改 fs-deny 平台分派 win 臂真跑——声明面 80→63，posix 臂拆分与 r42 R42-5 钉平台腿回加对冲；win 收集 7259→7285 与 mac/linux 声称 7339→7365 同步移动）+ 2026-09-16 四轮维持项反转修复批 +1（draft 新增 posix 字面反斜杠保字面用例 skipIf(win32) 入 win 门——mac/linux 侧照常跑）〕；**mac 实跑实录：2026-09-18 0918三轮修复批 1251 文件 = 7703 过 + 8 跳 0 败**（一次全绿 176.42s〔首跑 1 败输出仅留汇总未捕获件名，按在册负载脆端族口径全量重跑兜底，如实记档〕；九门全绿 = tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check〔counts 1251/7703/33/54 README 修账后对账绿 / packaging / knowledge〕+ e2e 51 过 3 跳 42.0s〔跳 = 发布门 spec 预期口径〕+ coverage 阈值门红 0 条；批动因 = 2026-09-18 全量源码独立重评三轮（P2×2 + P3×9，作者指令「全部修复！」）——P2×2 真修（B201 拆分取号临界区 per-bookRoot 跨进程锁〔10s 超时 OCCUPIED，成败两态释放〕/ G201 books-repair 扫盘「本轮已发现」同名判重 warn 跳过留痕）+ P3×9 全量真修（A201 knowledge 进可见性校验链三处贯通 / B202 leads fm 空串回落默认 / C201 字体枚举 SIGTERM→2s→SIGKILL 升级窗 + linux fc-list 自管接线 / G202 init 半成品恢复前书名对账闸 / G203 `##` 标题识别单源新件 format/section-heading.ts / D201 corpus 目录解析单源 / D202 errBrief 脱敏单源〔message 过 redactSecret〕/ D203 electron-smoke exitCode 自然排空 / D204 noImplicitReturns 启用 + exactOptionalPropertyTypes 实测 127 错缓办留痕〔G102 先例〕）；连带修 dabf0dff 遗留 tsc 错 1 处（vault-os-migration ragProviders 字面量形状，断言面零变）；净 +7 文件/+23 用例（回归测试 7 新件行为命名 + 既有件扩例 2），差值锚 64 维持；批记 = `Dev/Docs/Archive/README.md`）——**mac 实跑实录（前史）：2026-09-18 0918三拍板批 1244 文件 = 7680 过 + 8 跳 0 败**（一次全绿 202.58s；九门全绿 = tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check〔counts 1244/7680/33/54 README 修账后对账绿 / packaging / knowledge〕+ e2e 51 过 3 跳 40.2s〔跳 = 发布门 spec 预期口径〕+ coverage 阈值门红 0 条；批动因 = 作者指令「按你推荐的拉。全部修了」——总览 §五 最后两项真开放待拍板 + KEK 升级信号三件全数落批，推荐档全采纳：A006 轻量档〔chat 六失败出口单点 finishTurn 尾部补 chat_error.echo 回显作者原文（regenerate 轮复用已恢复原文不回显；echo 仅 SSE 通道不落事件库、不过 redactSecret 保复制重发可用）+ 前端 chat store errorEcho + 聊天窗错误横幅下回显块一键复制；B001 回滚 / P1-S4 防连发 400 / F1-P1 closeMaskingAll 遮蔽语义零改动〕/ B004 fail-loud 档〔章号双轨校验闸：structure-core 新增 chapterNumberMismatches 扫 写作/正文/ 文件名号 vs frontmatter 章号，真失配（fm 在且≠文件名号）时 merge/split 五写口〔applyChapterMerge/planChapterMerge/undoChapterMerge/planChapterSplit/applyChapterSplit〕前置 409 CHAPTER_NO_MISMATCH，fm 缺失文件不入闸保 B105 半完成 undo 恢复路径；API documents-core structStatus 映射〕/ KEK v2 档〔vault 信封升版：os 通道有凭据（safeStorage/Keychain/DPAPI）即建 v2 = byOs 单通道 KEK（HKDF info clwriting-vault-kek-os），byApp 有意移除消持制品定向攻击面；迁移 = 同 DEK 重封零逐键重加密（vault.keys 不动、幂等）；VaultOsKeyMissingError 守降级（旧构建读 v2 拒解，防降级毁配置）；os-kek 装置 = main 进程 userData/os-kek.json（safeStorage 加密 0600 原子写、可用性/解密/形态任一失败回落 null）经 env CLW_OS_KEK 注入 utilityProcess 子进程（CLW_STUDIO_TOKEN 先例不经 argv + 启动前逐键大小写不敏感剥宿主残留；无 env〔纯 node dev:api/测试〕维持 v1 语义，非 64hex env 视同缺失显式 resolve）；vault-key.ts 仅威胁模型注释更新未触分片（改动此文件 = 摧毁 v1 存量凭据红线在位）〕；新测试 5 件 26 例（行为命名：chat-failure-echo 5 / chapter-no-mismatch-gate 5 / vault-os-channel 5 / vault-os-migration 5 / os-kek 6）+ 既有件扩例净 +1（chat-store 回显生命周期 1；chat-exits / chat-unexpected-error-cleanup 回显断言随批扩写不增用例数），差值锚 64 维持；批记 = `Dev/Docs/Archive/README.md`）——**mac 实跑实录（前史）：2026-09-18 0918独立重评二轮修复批 1239 文件 = 7653 过 + 8 跳 0 败**（一次全绿 169.31s；九门全绿 = tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check〔counts 1239/7653/33/54 README 修账后对账绿 / packaging / knowledge〕+ e2e 51 过 3 跳 40.3s〔跳 = 发布门 spec 预期口径〕+ coverage 阈值门红 0 条；批动因 = 2026-09-18 全量源码独立重评二轮（P2×3 + P3×36，作者指令「全部修复。」）——P2×3 + P3×36 全量真修（A101 chat 小窗预算下限 clamp / E101 flushDirty 已删文档假警报 / F101 ShelfModal 二次 decode；P3 高价值：B101 拆分光标代理对守卫 / C104 CSP frame-ancestors / D102 摘要后常量时比较 / B102 章号守卫下沉 / B105 undo 半完成态续跑；G102 代理支持按缓办处置（依赖面 + 打包形态 + 配置面属产品决策，一次性 warn 留痕兜底））；批内如实记档：连带四败自清（r38-exit-guards 静态锚随 C107 契约改写 / migrate-defaults 新件 mkdir 缺父目录 / append-book 并发件 sort() 按 UTF-16 码元序 / r0912-3 脚本两态分叉点下沉进提交层，四者均为批内新件或合约锚，逐项修正后全绿）；净 +29 文件/+107 用例（回归测试 29 新件行为命名 + 既有件扩例 + 1 件随 F102 改名），差值锚 64 维持；批记 = `Dev/Docs/Archive/README.md`）——**mac 实跑实录（前史）：2026-09-18 0918独立重评修复批 1210 文件 = 7546 过 + 8 跳 0 败**（一次全绿 142.77s；九门全绿 = tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check〔counts 1210/7546/33/54 README 修账后对账绿 / packaging / knowledge〕+ e2e 51 过 3 跳 40.0s〔跳 = 发布门 spec 预期口径〕+ coverage 阈值门全量三跑终态红 0 条〔G003 .vue 插桩入核算 + G001 15 域阈值地板〕；批动因 = 2026-09-18 全量源码独立重评（P1×1/P2×11/P3×36，作者指令「全部修复！」）——P1×1/P2×11 全量真修 + P3 随批 24 项 + 连带四败自清（pricing ×3 播种基线对齐 D002 复验 / migrate-warn ×1 纳入 B009 留痕口径）+ 批内自纠一处如实记档 = 子代理调试残留探针两件（zz-probe3/4，chat-store 测试整份复制）收口前删除重跑；净 +22 文件/+87 用例 = 修复项回归测试 22 新件（行为命名，逐项锚注在案）+ 既有件扩例；差值锚 64 维持；批记 = `Dev/Docs/Archive/README.md`）——**mac 实跑实录（前史）：2026-09-17 六轮重评修复批 1184 文件 = 7425 过 + 8 跳 0 败**（代码面一次全绿 157.35s〔e2e 51 过 3 跳 38.1s（终树复跑 41.7s） + soak 五段 5 OK〕+ 文档回填后终树兜底复跑一次全绿 172.78s，两次计数逐位一致——本批徽章 7403→7425 修账的实测锚；净 +4 文件/+22 用例 = 新行为命名测试 4 件 19 例 〔stream-error-usage 8 / finalize-manifest-degraded 3 / prefs-debounce-fire-clears-handle 3 / task-call-budget-labels 5〕+ 既有结构契约 3 件随 sqlite-prepared 单源收编各扩 1 例，零删除；差值锚 64 维持）——同日 mac 侧收口批 1181 文件 = 7408 过 + 8 跳 0 败**（一次全绿 167.59s；e2e 51 过 2 跳 45.9s + soak 五段 OK——本批徽章 7425→7408 修账的实测锚）——同日拍板快断批 1180 文件 = 7401 过 + 8 跳 0 败（一次全绿 139.38s；e2e 51 过 3 跳 40.2s + soak 五段 OK——九门全绿；净 −11 用例〔死码删除：git 域 −3 + install 域 −8〕+ 4〔check-counts linux 分账直测〕，e2e 门后打包态冒烟 spec +1、常规轮 51 不变）——同日 CI 复验修复批 1180 文件 = 7403 过 + 8 跳 0 败（一次全绿 140.22s；e2e 常规 51 过 3 跳 38.9s + 定向 release-smoke 2 过〔探针定向豁免留痕实证〕+ soak 五段 OK〔最大增长 0.31MB，上界 24MB〕——九门全绿；净 +2〔spec-order 定向豁免直测〕）。本批动因 = 同日凌晨四线同推触发 main CI 首跑 35142681460 六腿全红，四类根因全数定位修复：① ubuntu 双腿 check:counts 红——linux 实测差 4 系静态盘点漏 r44-close-flush-electron 的 DISPLAY 环境门（ubuntu headless 无 DISPLAY 即省，实测 7396 = 7401 − 5），README 分账修 4→5；② e2e 腿红 = R0911-G-P3-3 顺序探针拿全量快照（33）对 CI test:e2e:release 定向单 spec 收集集（1）必失配——探针加定向跑豁免（isTargetedRunArgv argv 过滤词判定，全量轮 fail-closed 不变，直测 +2）；③ mac 双腿红 = r43 夹具 pid 段硬编码 123 撞 GitHub macOS runner 常驻活进程、清扫器按 R65-37「他进程在途写」正确拒清（本机 pid 123 无人用恒绿）——deadPid() 抽 test/helpers/dead-pid.ts 单源（atomic-sweep R65-37 先例，两消费点）；④ win 腿首跑 2 时序脆端（chat-exits ① deadline 120ms 慢机在确认闸挂起前到期 → tool/result 缺失；f2-title 末步 waitFor 默认 1s 慢机不够）裕量放宽〔语义零漂移〕，重跑全过但被 tinypool 收尾竞态杀（已登记族 R0911-G-P1-1d 二次命中、单次重跑兜底被穿透一次，维持挂账）。win 腿 check:counts 预期 7339 待下轮 CI 实跑核对。**二轮复验（run 35169792997，同日）：四腿转绿实证首批修复生效**——e2e 腿绿（定向豁免实战过）+ mac 双腿绿（deadPid 实战过）+ ubuntu·26 绿（linux 分账 5 对账过）；余二红再定位：⑤ ubuntu·24 + win 首跑红 = pm7-ngram-hash 性能对比断言系统性翻转（CI 共享 runner 上 5 万字总耗时仅 3-5ms、coverage 插桩下数值实现劣化占比高于字符串参照，方向恒定非抖动、retry:2 不救：ubuntu·24 三连败 5.08 vs 4.24 等、win 首跑 3.84 vs 3.34；本地比值亦探到 0.9×，断言处处偏脆）——按 scale.test.ts R67-19 先例 CI 侧 ×1.5 容差（本地门不动，真退化 2× 以上仍连败可捕）；⑥ win 腿重跑零测试红、两轮均被 tinypool 收尾竞态杀（R0911-G-P1-1d 单次重跑兜底连续两次穿透，维持挂账）。本树 win 实测 7681 过 + 76 跳 0 败（2026-09-18 四轮修复批 win 实跑；差值锚 68 维持——本批净 +46 用例均无平台门，mac 口径 7749 静态推演 = 7681 + 68；前锚 **2026-09-18 win 实机重锚 64→68**：win←mac 合并批实跑重锚——0918独立重评修复批 D005（check-counts walk symlink 门）it.skipIf(win32) 净 +3（+4/−1）+ 0918三拍板批 os-kek #1 mode 0600 断言补 win 门 +1，真差值 = 68 实测钉定（2026-09-18 合并批树 7703 − 7635））〔**win 实跑实录：2026-09-18 四轮修复批 1267 文件 = 7681 过 + 76 跳 0 败**（一次全绿 417.10s；九门 win 亲跑 = tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check〔counts 1267/7749/33/54 README 修账后对账绿 / packaging / knowledge〕+ e2e 51 过 3 跳 1.1m〔跳 = 发布门 spec 预期口径〕；净 +16 文件/+46 用例 = 修复回归 16 新件行为命名 + 既有件扩例改写；批动因与全量改动面见批记 = `Dev/Docs/Archive/README.md`）——前史：**win 实跑实录：2026-09-18 win←mac 合并批·二轮 1251 文件 = 7635 过 + 76 跳 0 败**（净跑一次全绿 366.22s——首跑 1 败 = os-kek #1 mode 0600 断言 win 不兼容〔expected '666' to be '600'，Windows/libuv 不强制 POSIX 权限位，mac 批漏挂 CC-P2-3 先例门〕，按 test/ai/calls.test.ts 先例 it.skipIf(win32) 补门后全量净跑全绿；win 侧改动 = 该测试一处补门 + 根 README 修账 + Archive 批记行；纯 ff 合并 origin/mac 两批〔dabf0dff 0918三拍板批 + a9bc13d6 0918三轮修复批〕零冲突；e2e 51 过 3 跳）——前史：**win 实跑实录：2026-09-17 单立清账批 1188 文件 = 7395 过 + 72 跳 0 败**（一次全绿 360.53s；e2e 51 过 3 跳 1.1m；净 +1 文件/+19 用例 = execRing 分桶〔cc-ring +3 / r50-b3 按腿改写 3 + 跨腿翻转 +1〕+ test/desktop/server-main.test.ts 新件 11 例 + check-packaging node_modules 排除锚 +4 例；差值锚 64 维持；execRing 两桶分环 + server-main 信号测试装置两单立销案，workspace 化拍板维持备案）——前史：**2026-09-17 0917清库修复批 1187 文件 = 7376 过 + 72 跳 0 败**（一次全绿 411.03s；九门全绿 = tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check 过〔counts 1187/7376/33/54 README 修账后对账绿 / packaging / knowledge〕+ e2e 51 过 3 跳 1.1m（跳 = 发布门 spec 预期口径）；净 +3 文件/+15 用例 = 新行为命名测试 3 件 11 例〔chat-switch-provider 2 / chat-knowledge-inject 4 / save-book-registration-guard 5〕+ 既有扩例 4〔pm10 真尾窗契约改写 6→8 / check-counts AST 盲区钉 1 / io-export-worker skippedDrafts 透传 1〕，差值锚 64 维持；本批动因 = 作者「我要的是修！」否决同日挂账清库批的纸面「维持」终态，原六项待拍板五项反转真修：MAX_AGENT_TURNS 5→20（护栏三道独立在位：deadline / 确认闸 / budget 预算闸）/ switch-provider 接线 chat 主发送（决策表消费 + 换网重发恰一次 + 双留痕，failure.ts R66-11「无消费者」销案）/ 知识层方法论注入接线（manifest 方法论 ≤4 条、防越界 fail-closed、双码点帽、promptMeta.files + 血缘登记）/ 事件读链 O(N) 立项落地（store 三原语 listEventsTail/countEvents/firstBranchMetaSeq + chat-history 真尾窗〔翻倍前扩 + 分支安全边界 + 触底退化全量〕，截断态 total 契约改骨架事件行数、pm10 守门件随批改写为验收面）/ testableConst 存量换装 32 处收编 25 文件（守卫锚 71→39 只减不增）；附带：desktop.d.ts 类型契约对码零漂移补锚注（isTrustedSender 单立·待拍板销案）+ onSaveMeta/doMove fp 键孤儿评估不泄漏维持 + rename 微任务残窗守卫下沉 executeSave（bookMovedGuardFailure 锁内最后时刻复核，SaveResult 加性 BOOK_MOVED，5 用例）+ finalize 第三文件读判维持（声明侧细纲.md 无缓存可替，收敛即闸退化）+ 导出 skippedDrafts 透传前端 + asar 排生产依赖 node_modules〔−27M〕+ desktop.yml mac playwright 缓存键改版锚 + check-counts skip 门禁 AST 化〔全树 A/B 逐位 0 差异〕；r-批次按域归并维持渐进）——前史：**2026-09-17 win 侧收口批 1184 文件 = 7361 过 + 72 跳 0 败**（一次全绿 346.65s——差值预期（7425 − 64）兑现、「待实跑核对」销案；九门 win 亲跑全绿 = tsc 0 + vue-tsc 0 + eslint 0/0 + 三 check 过〔counts 1184/7361/33/54〕 + e2e 51 过 3 跳（1.1m；跳 = 发布门 spec 预期口径） + soak 五段 5 OK〔最大增长 0.31MB，上界 24MB〕；win 本地 CLAUDE.md 随批同步两条 mac 侧纪律条〔2026-09-17 入库判据 + coverage 单腿 ubuntu·24 实况——私有备忘单机生效不入库，P3-1 断点 win 半边闭合、在册维持〕；tinypool 上游评估落账台账 §三〔无补丁级修复路径，撤兜底改判随 vitest 4/5 迁移批〕）——前史：2026-09-16 五轮重评处置批 1181 文件 = 7344 过 + 72 跳 0 败（一次全绿 328.24s——五轮全库重评（GLM-5.3，独立重评 P1×0/P2×5/P3×18/nano×20）经作者指令「全部修复」全数落批：**P2-1** 清单读失败显式化〔readManifestDegraded 分离「合法空/读失败降级」+ 树聚合 manifestDegraded 旗标 + api/check warnings 透出 + 单章 maxWritten 降级留痕；run 族 3 处裸 close 改道 closeTreeIssuesDb（prepared ephemeron 断链）〕/**P2-2** 域环消除〔resolveDraftPath+ensureChapterNotFinalized+inferVolumeDir+slashRelative 族逐字节上移新件 document/draft-path.ts（format/draft 235→56 行残核），format→document 反向边移除 + format 域方向锁治理门，src 6 + test 11 import 改道，W-P1-5 守卫契约逐字节随迁〕/**P2-3** desktop.yml tag↔package.json version 一致性门 + 发布产物 SHA256 清单步/**P2-4** 测试命名纪律（行为命名，批次号留锚注）入 CLAUDE.md/**P2-5** webnext 真 store 测试 helper + 7 存量文件迁移 + stores import 环治理门（实得四组环全登记）〕+ P3 族 = doCopy 源 save 锁（withSaveLocks 结构锁口径 + safeDocId 前置）+ withManifestLockAsync async 同 key 重入自等死锁 fail-loud（AsyncLocalStorage 携 key，回归三例钉死）+ journal 锁超时降级前重试一档 + budget.chat_max_calls 预算闸（fail-closed）+ 批量定稿失败透因 toast + prompt 注入口径句 + rag 码点计量收编 codePointLength 单源 + review 空 issue 描述拒收 + repeat_chars_threshold 非正整数夹紧 + yaml 三域覆盖率阈值桶 + ai-studio-direction 静态扫加固 + tsup 清理路径绝对化 + e2e global-setup dist/web 新鲜度守卫 + CheckInput.bannedWords 死参数删 + tree-issues 缓存裸 close 前向防御等 + nano 族〔stream-ticket 排空 1MB 上限 / baseline stringify 同源投影注记 / entryPolarity 零消费注记 / README 事件第二删除入口补记 / anthropic break 分号 / TOOL_RISK 死分支锚注等〕；新测试 +10 文件/+34 用例（gc 门 1 例按环境跳，非平台门），差值锚 81 维持；批内加固一处如实记档 = re2-manifest-lock-reentry-async 探测点 sleep 定点→waitFor 事件协调（本文件系注册在案负载敏感族，加固后 5/5 绿））——前史：2026-09-16 四轮维持项反转修复批 1171 文件 = 7311 过 + 71 跳 0 败（一次全绿 343.91s——四轮评审维持 13 项经作者指令「全部修复」全数反转处置：P3×5〔P3-6 rag norm 回填由游标迭代内 UPDATE 改键集分页物化（批 512；node:sqlite 同连接查询中 DML 非定义行为规避）/ P3-8 draft slashRelative 收编 normalizeWinSeparators 成同族第 9 站（posix 字面反斜杠文件名身份保持）/ P3-11 events iterateEvents 改每调用新语句重入安全（listEvents 保留语句缓存）/ P3-14 migrate-defaults 每书 RMW 上跨进程锁（5s 超时 fail-closed 跳过、幂等下次启动重试）/ P3-15 migrate-finalized git status 移入 manifest 锁内取（新鲜度）〕+ nano×8〔nano-2 contract 去重重叠赋值死码删 / nano-3 style-entry 三元简化 / nano-5 workbench 截断劈开代理对时孤儿低位代理剔除（0xDC00 判别）/ nano-6 git-exec ETIMEDOUT 与外部 SIGTERM 分判 / nano-8 walk-md dirReal 递归传递免重复 realpath / nano-9 events 改直连 fs/id（垫片收敛 document 域）/ nano-10 TabBar·ContextMenu 下拉翻位随窗口 resize 重算 / nano-11 composer 最小高变量化〕；本批净 +1 文件/+6 用例声明（5 中性 + 1 posix 门），差值锚 80→81；批内自纠两处如实记档 = nano-5 初版代理方向取高位系误（node 复现实证劈点落对内时孤儿系低位段，已记正）/ ContextMenu watch 体初版包 async 函数多一跳微任务致 re2 焦点断言假红（热路径回内联同步，仅 resize 监听臂走异步包装）——前史：2026-09-16 ⑤⑤注释冻结剪枝批 1170 文件 = 7306 过 + 70 跳 0 败（一次全绿 322.37s——连续六批免兜底；纯注释删产行为零代码改动——desktop/export·cache/install/test·state 六路 15 文件净删 120 行〔注释 118 + 随块空行收拢 2；A main 23 + B server 族 23 + C shell 族 56 + D export·cache 7 + E install 10 + F test·state 1〕，剪出归档非直删落 Archive 冻结件六份〔37→43 篇〕；实测结论 = 考古密度远低于毛估〔重评-0911c 四档估 src 2.4k–4k / 重评-0912-2 修账 1.3–1.5k，src 实收低一个数量级；test 侧毛估 2k–3k 经全域只读普查四路实测合计 1 行——判定性不立项（S1 studio 474 文件 0 / S2 ai 族 244 文件 0 / S3 desktop 族 115 文件 0 / S4 领域族 ~240 文件 1），唯一墓碑行经作者「全部修复」处置随 F 路剪除〕，本库注释文化实为锚注骨架；主审全批评审四道机检全过 + 边界判剪六处单源逐一经实证在位〔初判「最重两块无注单源」系假阳性，记正〕）——前史：2026-09-16 ⑤④收官补批·service 缝C 1170 文件 = 7306 过 + 70 跳 0 败（一次全绿 323.64s——连续四波一次全绿；行为等价重构零用例漂移——service.ts〔2110→1664〕meta 族参数化拆 service-meta.ts〔+561〕，svc 宿主 24 处改写、成员最小放宽 9 处、剥前缀多重集机检逻辑行零增删）——前史：2026-09-16 ⑤④产品拆分波5批 1170 文件 = 7306 过 + 70 跳 0 败（兜底重跑全绿 321.81s；纯移动拆分零用例漂移——prefs·store〔871→791〕拆 theme-apply 缝落 shared 层〔+126〕，createThemeApply 工厂闭包参数化系唯一结构性改动；全绿路径如实记档 = 首跑 1 败系 mtime 垫片族同毫秒撞车第 8 站〔pm1 目录签名失效用例，孤立 2× 绿〕→ 按 ⑤波1 七站先例确定性加固〔utimesSync 前推 60s〕→ 兜底重跑全绿；本批收官 ⑤④ 五波——17 件 >800 行巨件全数拆分落地）——前史：2026-09-16 ⑤④产品拆分波4批 1170 文件 = 7306 过 + 70 跳 0 败（一次全绿 314.68s；纯移动拆分零用例漂移——api·documents〔1019→59〕/api·books〔870→235〕/api·stream〔879→705〕/useChapterTreeActions〔901→558〕四件拆分落地 + 10 个新 src 模块，re-export 桥接消费面零改动）——前史：2026-09-16 ⑤④产品拆分波3批 1170 文件 = 7306 过 + 70 跳 0 败（一次全绿 314.83s；纯移动拆分零用例漂移——self-heal〔1077→861〕/turns〔958→574〕/events·store〔1355→1104〕/desktop·server-manager〔1127→841〕四件拆分落地 + 9 个新 src 模块，re-export 桥接消费面零改动）——前史：2026-09-16 ⑤④产品拆分波2批 1170 文件 = 7306 过 + 70 跳 0 败（第四跑兜底全绿 315.48s；纯移动拆分零用例漂移——structure〔928→111〕/state〔1175→346〕/run〔849→469〕/rag〔1086→332〕四件拆分落地 + 8 个新 src 模块，re-export 桥接消费面零改动；全绿路径如实记档 = 四跑序列——首跑 2 败负载竞态族〔p0-regression 等，孤立复跑绿〕、次跑 1 败系真缺陷 server-main-error 2/2 确定性〔DEFAULT_VOLUME_SIZE 具名导出缺失：recap.ts 回引 health.ts 未导出常量，vitest transform 不校验具名导出、真 Node ESM 拒绝——export 前缀修复 + tsc --noEmit 全树验证〕、三跑 2 败负载竞态换脸〔r2w1-case-only-rename + r50-c4-static-spa-fallback，孤立绿〕、第四跑 R0911-G-P1-1d 兜底全绿）——前史：2026-09-16 ⑤④产品拆分波1批 1170 文件 = 7306 过 + 70 跳 0 败（一次全绿 311.94s；纯移动拆分零用例漂移——service〔2243→2110〕/yaml〔1234→319〕/count〔1144→437〕/install·books〔818→477〕四件缝 A+B 落地 + 8 个新 src 模块，re-export 桥接消费面零改动）——前史：2026-09-16 结构大件波2批 1170 文件 = 7306 过 + 70 跳 0 败（一次全绿 309.57s；⑤② 剩余两巨件拆分〔server-manager 1→6 件 / chat 1→6 件，62=62 / 28=28 用例零变化纯结构〕，用例数与波1持平）——前史：2026-09-16 结构大件波1批 1160 文件 = 7306 过 + 70 跳 0 败（干净重跑一次全绿 308.81s；前四跑分别 3/2/1/1 败，逐站根因 = mtime 垫片族在册潜伏脆端〔写盘与 stat 落同一毫秒指纹不变：pm11 memo / pricing R42-2 / kk-P2-15 探测梯 / providers-api 切换 / providers-revision-models ×2 / r35 目录探针〕与 R0912-3 拆分件迟到弹〔pending settle 竞速 2s 后 setTimeout(0) 真退出落出用例窗〕，七站确定性加固（显式 utimes 前推 + spy 在役窗内放行握手）后一次全绿；本批净 +11 文件/+3 用例 = ⑤② 两巨件拆分〔main.test.ts 1→6 件 / adapter.test.ts 1→6 件，用例零变化纯结构〕+ 新增 test/governance/ai-studio-direction.test.ts 3 例〔R0916-5c 方向锁/形状锁/白名单僵尸〕，无平台门，差值锚 80 维持）——前史：2026-09-15 四轮处置批 1149 文件 = 7303 过 + 70 跳 0 败（干净重跑一次全绿 324.81s；前三跑 1/2/3 败均系注册在案收尾竞态族〔re2-manifest-lock-reentry-async / cross-process-lock / r35-search-cache 三族文件，机器高负载期孤立复跑各全绿〕；本批净 +3 文件/+16 用例 = 新增 3 文件 7 例〔r0915-srv-review-bookmoved 2 + r0915-chat-history-messages-normalize 2 + r0915-quote-grid-render-cap 3〕+ 既有 8 文件净增 9 例〔use-relation-graph +2 / batch-finalize +1 / chapter-lookup-preserve +1 / draft-pipeline +1 / short-index +1 / migrate-layout-v3 +1 / r35-repair-ghost-entries +1 / api-endpoints-a +1〕，无平台门，差值锚 80 维持）——前史：2026-09-15 机械批一组 1146 文件 = 7287 过 + 70 跳 0 败**（全量重跑一次全绿 328.02s；首跑 2 败系注册在案收尾竞态族〔cross-process-lock 锁文件损坏 1 + 另 1 同族〕孤立复跑 18 过 1 跳后按 R0911-G-P1-1d 兜底口径全量重跑一次全绿；本批净 +1 文件/+2 用例 = 新增 r0915-rag-rebuild-gate 2 例，无平台门，差值锚 80 维持）——前史：2026-09-15 拍板快断批 1145 文件 = 7285 过 + 70 跳 0 败（全量重跑一次全绿 329.19s；首跑 3 败系注册在案的收尾竞态族〔cross-process-lock 2 + r35-search-cache 1〕孤立复跑 3 文件全绿；本批净 +1 文件/±0 用例声明面 = 删 catalog-sync.test.ts 6 例 + 新增 6 例〔r0915-inline-seed-prefix 3 + r0915-merge-undo-newest 2 + foreshadow 1〕）——前史：2026-09-15 全库源码重评三轮修复批 1144 文件 = 7285 过 + 70 跳 0 败（一次全绿 370.02s；本批净 +2 文件/+26 用例 = 新测试文件 2 个〔r0914c-rename-root-doc 2 例 + r0914c-fortest-hooks-guard 1 例〕+ 既有文件净增 23 例；win 跳 84→70 系 EACCES 读失败族摘 skip 改平台分派 win 臂真跑所致）——前史：2026-09-14 复审-0914-修复批 1130 文件 = 7194 过 + 84 跳 0 败（一次全绿 359.71s，win 树 mac/linux 口径 7273）+ 本 win→mac 合并批并树 mac 侧净增三批 = +12 文件/+66 用例（mac/linux 口径：mac 适配修复批 +1 文件/+25 用例 + 全库优化修复批 +8 文件/+22 用例 + 全库重评修复收口批 +3 文件/+21 用例，其中 mac 门 −2〔r71 旧 win 形态 2 例转 skipIf(!win32) 移出 mac/linux 口径〕，差值锚 79→80）——更早前史：2026-09-13 全库源码重评二轮修复批 1129 文件 = 7190 过 + 84 跳 0 败（一次全绿）、同日全库源码重评 win 适配修复批 1126 文件 = 7176 过 + 84 跳〔首轮 1 败为已登记 sleep 时序家族假红，孤立复跑 5/5 绿〕、同日 win 合并批复核批 1121 文件 = 7142 过 + 84 跳 0 败（7221 − 79 吻合）、win 合并批 1121 文件 = 7141 过 + 84 跳 + 1 用例、R0912-ds41 复核批 1102 文件 = 7008 过 + 84 跳、2026-09-12 重评-deepseek-v4.1-flash 修复批 1101 文件 = 7005 过 + 84 跳，待 CI 实跑核对〕——2026-09-11 修复批起 win 腿测试步带「收尾竞态重跑一次」兜底（R0911-G-P1-1d：vitest×tinypool forks 池收尾 ERR_IPC_CHANNEL_CLOSED 竞态会杀进程于汇总前，首跑非零自动重跑一次区分竞态与真失败），win 腿的 check:counts 现同时核对文件数、e2e 数与单测数（R0910-W：此前 win 腿只对账文件数与 e2e 数，单测数只在 macos/ubuntu 腿核对）。CI 测试步曾存四族环境面红，2026-09-11 修复批已全数处置：R71-8 改运行时 FS 大小写探测分支断言、kk-P2-8 改 msgBox 快照增量口径、TTL 族 7 处真睡眠改注入时钟（r43 慢机时序压力源同批移除）、win teardown 竞态上重跑兜底（上游根治评估登记台账 §三 G）——本地全绿，六腿 CI 复验待下轮 dispatch。动了前端就再跑 `vue-tsc` 和 e2e。e2e 的 33 个 spec 按固有顺序跑（前一个建的书/写的内容供后一个用），其中主链共享单一临时 workDir（少数 spec 如 usage-card / startup-notices 各持独立 server+workDir 实例，见 test/e2e/e2e-ports.ts）——勿加并行或改动 spec 顺序，否则隐式依赖会静默错乱。

项目治理与协作规矩（文档操作链、测试分层、评审命名、入库判据等纪律条）唯一正本 = `Dev/Docs/03-设计/项目治理-现行规范-2026-09-17.md`（入库可考）；根目录 `CLAUDE.md` / `AGENTS.md` 系单机私有指针壳（`.gitignore` 排除），只指向正本、不承载治理内容。

## 技术栈

Node 24+，TypeScript strict。前端 Vue 3 + Pinia + Vite，编辑器 CodeMirror 6，桌面壳 Electron；存储是 node:sqlite（RAG 索引）加 JSON/YAML 配置；AI 侧三个协议适配器（Anthropic、OpenAI Chat、OpenAI Responses）统一走 runTask 编排，重试、超时、用量都归它管；测试 vitest（7769 单测）+ Playwright（33 specs / 54 用例）（常规命令跑 51，3 个发布 smoke 用例需 CLWRITING_E2E_RELEASE 环境变量）。

代码上有几条一直守着的规矩：作者数据不被升级覆盖；定稿走原子写入加指纹校验；api_key 不进 git；AI 生成链路不 spawn 任何 CLI 子进程（要用的内核模块直接 import），历史轨迹与启动迁移会 spawn 本地 Git（Windows 需预装，见上方使用须知）；对话和工作流的事件 append-only 全量落库（每本书一个 SQLite，在 userData 下），要清理去「事件审计」视图里手动删；另外「清空对话历史」会连带删除该书本次对话产生的事件（同一份账，语义一致），两处入口删的都是同一库。

## 致谢

设计上参考过这些开源项目：

- [webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer)——架构思想来源；本项目是从零重写的
- [oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)（MIT）——长篇写作方法论
- [character-arc](https://github.com/uu201/character-arc)（MIT）——角色弧线与设定方法论

## 许可证

[MIT](LICENSE)
