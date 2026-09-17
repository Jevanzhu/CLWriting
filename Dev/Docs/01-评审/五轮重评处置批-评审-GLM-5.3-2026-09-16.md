# 五轮重评处置批 评审报告

- **评审对象**：提交 `4ba1de72`（fix(review): 五轮重评处置批，基线 `51ebee09`，74 文件 +1818/−467）
- **评审执行**：GLM-5.3 主审亲评（随批评审，2026-09-16）
- **评审性质**：对「全部修复」处置批的独立验收——机检账目 + 逐 hunk 对读 + 风险面独立实测
- **判定**：**合格，可收口**——P1×0 / P2×0 / **P3×1（叙述账目，零代码面）** / nano×3（观察·登记）

## 一、结论摘要

本批对五轮重评（P1×0 / P2×5 / P3×18 / nano×20）做了全量处置：四路文件互斥后台代理（web-next / 机检·审稿·RAG / AI 域 / 构建·CI·治理）+ 主审亲修核心数据面。评审经三道独立验证后认定：**五项 P2 修复全部真实落地且形态合格，无回归引入，账实闭合**；唯一 P3 系提交叙述的改/新拆分口径漂移（代码与门全对，commit 不可改，记正了案）；三项 nano 均为安全方向观察，不动。

## 二、机检账目（逐项对码）

| 机检项 | 结果 |
|---|---|
| 提交统计 | 74 文件 +1818/−467 ✓；src 29（28 改 + 新 1）/ test 38（26 改 + 新 12，含 helpers/real-stores.ts）/ 其他 7（README·CLAUDE·desktop.yml·tsup·vitest·台账·总览·DevREADME 面）——与提交叙述「src 改 29 新 1 / test 改 27 新 12」存在拆分口径 +2 漂移（总量与净账全对，见 §四 P3-1） |
| P2-2 搬迁纯度 | `git show 51ebee09:src/format/draft.ts` 迁移段 vs `src/document/draft-path.ts` 正文 **逐字节一致（176 行 = 176 行，True）**——程序化搬迁主张坐实；残核 56 行零 document import（方向锁治理门在位） |
| fortest 钩子锚 | r0914c 的 71 锚：批内新增 `__setXxxForTest` **0 处** ✓ |
| 测试账目 | 新测试文件收集 **32 例** + review/run.test.ts **+1** = 33，与 win list 7311→7344 恰合；徽章 7425 = 7392+33 收集口径 ✓（「+34 用例」系含 gc 环境门 1 例的书写口径，README 括注已自洽披露）；skip 71→72 = gc 门用例（vitest list 不收集 skipIf-真用例，check:counts 双侧同口径）✓ |
| 门复跑（本评审独立跑） | ① 全量 coverage（含三域新阈值桶）**exit 0**——代理 4 自认「无实测基线、宁低勿红」的风险面由本评审实测收口；② re2 + 新死锁防御组合 **5/5 绿**（加固后）；③ r64 迁移件定向 4 过；批内 L2 九门记录（vitest 一次全绿 328.24s + tsc/vue-tsc/eslint 0 + 三 check 1181/7344/32/53 + e2e 51 过 2 跳 + soak 5 OK）经查无口径冲突 |

## 三、逐域对读（要点）

- **P2-1 清单读失败显式化**：`readManifestDegraded` 缓存口径与旧 `readManifest` 逐位一致（ok 且 sig 在才落缓存、读失败不落不毒化 strict 版）；ENOENT（含竞态删）仍归合法空；树聚合旗标 + 端点 warnings + 单章 maxWritten 留痕三面接线完整；EISDIR 确定性回归 5 例在位。run 族 3 处裸 close 改道与 tree-issues-cache.ts 的 `closeTreeIssuesDb`（ephemeron 断链）构成完整闭环，注释修账如实（原「待长寿命连接再补」失实注已纠正）。
- **P3-15 ALS 死锁防御**：fresh 持锁与排队轮次均在 `manifestLockReentryAls.run(lockKey, …)` 内执行；防御命中面 = 同 key async 嵌套重入（排队自等），外部并发排队与嵌套同步快道不受影响——与 re2 既有四形态回归 + 新三例防御回归的断言面逐一吻合；生产调用方 grep 全为顶层同步/async 非嵌套，防御零误伤（全量绿佐证）。
- **P3-14 doCopy 源锁**：`withSaveLocks` 包裹 + safeDocId 前置 + 结构锁 5s 口径，与 move/rename/trash 同族；锁序 save→manifest 单向一致；body 除缩进外零改写。doCreate 无锁论证（B-6 独占探测即互斥本体）成立。
- **P3-16 journal 重试**：降级前 50ms 退避重取一档，降级留痕不变——瞬态争用压回、互斥失守窗收窄，语义安全。
- **AI 域（代理 3）**：预算闸判定序逐条镜像写稿链（未设不限 / 损坏保守阻断 / ≤0 全拦 / used≥limit 拦截），mock 快路先行不耗预算，失败出口对齐 resolveProvider 分支不进重试；yaml-spec 最小触达（键表尾追、既有书字节零变化，schema 快照红线测试绿佐证）；prompt 注入口径句 + 钉文本在位。
- **机检·审稿·RAG（代理 2）**：codePointLength 收编论证（码元窗恒上界码点数、与防劈守卫自洽）成立；coerceIssue 空描述闸对齐 severity/category 既有风格；repeat_chars 夹紧镜像姊妹键先例；lead-updates/sentences 注记如实。fix/location 空串维持的论证（契约必填展示字段、运行时置 undefined 炸聚合）经核属实。
- **web-next（代理 1）**：toast 首因透出保持单行、error 级随 failed 分流正确；real-stores helper 头注即纪律（真 store + mock api 层 + spy 副作用面）；store 环治理门双闸（未知环红 + 白名单僵尸红）+ 第四组环（doc→words→tree→doc）登记完备。
- **构建·CI（代理 4）**：tag-version 门 workflow_dispatch 豁免论证成立；SHA256 步零产物即红、两腿 artifact 并件；tsup 绝对化零行为（正常路径同义）；global-setup 新鲜度守卫假红面论证（vite build 全量重写、mtime 单调、1s 容差）成立——本评审 e2e 51 过实录佐证。
- **nano 面**：stream-ticket 1MB 排空上限 fail-closed、baseline 同源投影注记、anthropic 分号、TOOL_RISK 锚注、entryPolarity/readLeadUpdatesAt/splitSentences 注记——形态全部合格。

## 四、发现清单

### P3：×1（叙述账目，零代码面）

1. **提交信息改/新拆分口径漂移（+2）**：叙述「src 改 29 新 1 / test 改 27 新 12」（合计 69）vs numstat 实际「src 28 改+1 新 / test 26 改+12 新（含 helpers 非 test 文件）」（合计 67）——总量 74、净账（+10 测试文件 / 徽章 7425 / 差值锚 81）与 check:counts 全部正确，纯拆分叙述漂移。commit 已定不可改，记正于本报告 + 台账处置注；后续批次提交模板宜按 numstat 口径数拆分。

### nano：×3（观察·登记，不动）

1. **manifestDegraded 警告随载荷缓存 ≤5s**：treeIssuesCache 系纯 TTL(5s)+FIFO 零指纹缓存，读失败降级旗标随 payload 缓存至 TTL 到期——与既有四降级旗标（rebuildFailed 等）同语义同残留窗，瞬态恢复后最长 5s 残留可接受；持续失败由 warn 日志承担。不动。
2. **chat_max_calls 接受正小数**：failClosedNumParse 走 parsePositiveNumber（>0 即收），0.5 → 实效 ≈1 次（安全方向怪形）；姊妹键 repeat_chars_threshold 本批已在消费点夹紧正整数，此键未夹——后续随 format 域触达顺手夹紧（与 PATCH 白名单留项同批），登记不立项。 **【处置记·2026-09-16】**作者指令「修掉」，随批评审后即修：failClosedNumParse 收紧正整数（`Number.isInteger` 闸，非正整数 warn「值非正整数」+ 落 0 = 宁拦勿放），chat-budget-gate 既有 fail-closed 用例内扩 0.5（落 0 + warn 文案）/ 3（合法正整数不受夹）两形态断言——用例数零漂移（9 例维持，counts 免修账）；L2 九门复跑全绿（vitest 一次全绿 1181 文件 = 7344 过 + 72 跳 353.31s，其余门全过）。PATCH 白名单留项维持 format 域批登记不变。
3. **「四路文件互斥」编排叙述两处交叉**：ai/prompts/chat.ts（代理 3 改 prompt 体 + 主审改 import 行）与 test/ai/prompts.test.ts（代理 3 +1 断言 + 主审改 import 行）系先后双触——hunk 不相交、顺序合并零冲突，结果正确；编排叙述精度记正（派发时互斥成立，主审 P2-2 改道后交叉）。

## 五、判定

- **五项 P2 全部真实落地**（对码 + 机检 + 回归三面）：P2-1 数据正确性面闭合、P2-2 域环消除且搬迁逐字节纯净、P2-3 发布门焊入 workflow、P2-4 纪律入册、P2-5 治理门 + helper 双落地。
- **无回归引入**：批内一次全绿 + 本评审独立复跑（coverage exit 0 / 防御组合 5/5）双佐证；re2 负载敏感族加固（sleep→waitFor 事件协调）处置得当且如实记档。
- **处置覆盖度**：五轮判定 P2×5/P3×18/nano×20 全数落批或登记，处置口径与报告 §九建议一致（P2-4/5 有界执行 + 渐进收敛，未盲动全量迁移）。
- **结论**：批合格可收口；P3-1 记正了案，nano×3 观察登记，无返工项。五轮评审链至此闭合（落盘 → 处置 → 验收）。
