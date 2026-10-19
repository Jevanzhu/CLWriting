# 高危结论对抗性复核（v1，6 条）

复核人：verify-highrisk ｜ 日期：2026-10-19 ｜ 立场：默认怀疑，逐条回源码重建证据
范围与方法：只读复核 d1–d5 中 6 条最高危结论；裁定所依据行均为本次实读行（file:line）。
纪律：未改任何源码/配置/测试；未跑全量测试与 coverage；未并发跑 vitest；未 git 提交。
裁定口径：成立 / 部分成立 / 不成立 / 需运行时验证。

## 裁定表

| 编号 | 原严重度 | 裁定 | 修正严重度 | 复核依据（本次实读） |
| --- | --- | --- | --- | --- |
| V1 脏路由离书丢编辑 | P1 | 成立 | P1（维持，并新增 conflict 面） | useBookSwitchGuard.ts:296-322,337-338；stores/doc.ts:112-134,717-752；shared/dirty-mirror.ts:164-187 |
| V2 跨卷重号章静默覆盖 | P2 | 成立 | P2（维持，前提与快照兜底须写明） | draft-path.ts:41-49,55-68；document/service.ts:360-368,385-386；ai/tools/rewrite.ts:126-158,166 |
| V3 更新链校验值同源 | P2 | 成立 | P2（维持；升 P1 前提见下） | update/asset.ts:45-64,77＋；update/download.ts:138-167；desktop/update-controller.ts:153-185 |
| V4 助手 argv 无来源校验 | P2 | 成立 | P2（维持；边界=同权本机进程，非提权面） | desktop/update-helper.ts:87-111,247-269,294-321 |
| V5 续期失败停表→stale 接管 | P2 | 成立 | P2（维持；触发窗窄但机制真） | fs/cross-process-lock.ts:112-155,181-215；studio/server/api/task-gate.ts:106-109,181-184 |
| V6 一次性重发用量分裂 | P2 | 部分成立 | P3（降级：明示口径，主流失败零计费） | ai/orchestrate/chat/turns-phases.ts:473-476,502-528,551-601,701-708 |

## V1 · 脏路由离书：flush 失败仍清镜像 → 编辑永久丢失（成立，维持 P1）

- 实读 useBookSwitchGuard.ts:296-322：脏路由分支 `if (!n)` 先 `workbench.clear()`（:302）、`await doc.flushDirty()`（:303），**只有 console.warn**（:308-312），随后无条件 `lastBook=''`、`doc.setBook('')`、`ws.setBook('')`、`clearEventStores()`、`endBookSession()`。
- 实读 stores/doc.ts:112-134：`setBook('')` 中 `prevBook` 为原书名时执行 `mirror.clearBookMirrors(prevBook)`（:127）并 `docs.value = new Map()`（:118）——内存编辑与 localStorage 镜像同时清。
- 实读 shared/dirty-mirror.ts:164-187：`clearBookMirrors` 按 payload book 精确比对后 `localStorage.removeItem` 全删（:177-183）；`readDirtyMirror`（:136-153）的 baseRev 时效门只在「复活」时用，镜像已删即无复活面。
- 兜底盘点：`flushDirty`（doc.ts:717-752）失败项只进返回数组，不落盘；服务端 `.版本`/快照只覆盖已落盘历史（guard:300 注释自认「快照是恢复底线」）；无 journal/后写回兜底。→ 未落盘编辑确实永久丢失。
- 原报告说对了：失败后清镜像 + 零用户可见提示，成立。**说过头处**：恰相反——原报告低估了面，见「新发现 1」：conflict 未决项同样被静默丢弃。
- 可达性：guard:337-338 自述「离书时分支已 doc.setBook('')」，即 /book/A → 无书路由（/shelf 等）在真实导航下确走本分支；watch 回调跨 await 不因 Book.vue 卸载而中止。触发需离书 + 保存失败双条件，但一旦发生即不可恢复且无提示，维持 P1。

## V2 · 跨卷重号章静默覆盖（成立，"静默"成立但影响被局部夸大）

- 实读 draft-path.ts:41-49：`readChapterDir(bodyDir)` 后 `chapters.find(c => c.章号 === chapter)` 取**首个命中**（跨卷扫描），命中即返回该路径 + `existed: true`——`existed` 只表「将覆写既有文件」，不含「命中项是否本次目标」的校验；同章号第二份文件在另一卷时，目标章（作者打开的那份）与写入点会分离。
- 实读 document/service.ts:360-368：`input.expectedRevision !== currentRev` 才拒（REVISION_CONFLICT），`currentRev` 由**待写 absPath 自身**磁盘字节算出——基线与被写对象同源，防的是并发改动，防不了「按章号解析错文件」。
- 实读 rewrite.ts:126-158：新鲜度校验（meta.baseSha 比对、`readChapterBody(bookRoot, chapter)` 复验）与写入（`saveDraft(bookRoot, chapter, …)`）全部按章号定位；三道闸都会命中同一个（错误的）文件，故对重号解析错位整体不设防——比原报告描述更精确。
- 原报告说对了：同章号多文件时确实会覆写非目标章，且不弹任何确认。**说过头处**：①写盘链有快照留底（service.ts:385-386「journal pending → 快照留底 → 原子落盘」；rewrite.ts:166「改写前的旧稿已自动快照」），破坏可回滚；②落盘摘要回显实际 relPath（rewrite.ts:162-164），并非全无痕；③前提是同章号跨卷并存这一异常态。结论：机制成立，维持 P2（不应升 P1）。

## V3 · 更新链校验值与被校验对象同源（成立，维持 P2）

- 实读 update/asset.ts:45-64：`sha256` 仅来自 GitHub API 该资产的 `digest` 字段（`sha256:<hex>` 形态校验，缺失 → null）；:77＋`pickChecksumsUrl` 也取自同一 release 的 assets。
- 实读 update/download.ts:138-167：`--sha256`（即 API digest）优先；缺失才拉 SHA256SUMS.txt（同一 release 面）；两者皆无 → 显式拒绝不可校验包（:147）。故「独立信任锚」不存在，但也没有「无校验直下」的降级口。
- 实读 update-controller.ts:153-185：URL 与 digest 同出自一次 release 解析，缓存命中复核亦比 `asset.sha256`（:158-170）。链内唯一「独立」量是下载后实测 sha256（download.ts:171 注释），属**自校验值**，不能提供来源独立性。
- 原报告说对了：锚与被校验对象同源，成立，维持 P2（自更新应用的常规信任模型，非链内缺陷）。**升 P1 的前提**：需要「攻击者可写该 release 元数据（发布账号/CI 被控）」或「api.github.com 被 MITM 且客户端 TLS 校验被绕过」——即供应链/TLS 前提；现有 sha256 绑定反而挡住了 CDN 侧替换包体（含重定向到第三方主机）。若要求 P1 级防线，需引入离线/内置公钥签名的独立清单。

## V4 · 更新助手 argv 无来源校验（成立，边界明确）

- 实读 update-helper.ts:87-111：`parseApplyUpdateArgv` 仅做「存在性 + pid 正整数」检查，`--target/--payload/--home/--sha256/--exe` 全为裸取值，无来源、签名或父进程校验。
- 实读 :247-269（precheck）：`--sha256` 缺省/空 → **整段 hash 复核跳过**（:253 `if (inv.sha256)`）；`--home` 缺省 → 其他实例探测跳过（:263 `if (inv.homeDir && …)`）；仅 `--payload` 存在性必查（:252）。
- 实读 :272-286、:294-321：`--target` 派生 `newDir`/`oldDir` 后被 `rmDirQuietly`（递归 + force，:114-120）与 `renameWithRetry` 使用；即可对任意 `--target` 改名并把 `<target>.old-*` / `<target>-new-*` 递归删除。
- 边界：助手以本用户权限运行（:277 目标不可写即失败退出，无提权路径），故攻击面 = 同权本机进程，该进程本可直接删文件——**不是提权面**，维持 P2。原报告结论准确，无夸大。

## V5 · 续期定时器抛错即停表 → 10 分钟后可被 stale 接管（成立，维持 P2）

- 实读 cross-process-lock.ts:203-215：续期 `setInterval` 内 `utimesSync` 抛错 → catch 只 `clearInterval`，无日志、无重试、无告警（注释自认 best-effort）。
- 实读 :118-137 与 :73：判 stale 的唯一活体出口是 `age > maxHeldMs`（缺省 `MAX_HELD_MS = 10*60_000`）；stale 即「接管」（清理后重占，:181-182 注释）。
- 实读 task-gate.ts:106-109,181-184：任务闸续期 30s，且闸持有段为分钟级（rag-build/大书 review 可超 10min 线）——即续期停表后 mtime 冻结，10 分钟后第二进程按「活 pid 超龄且无续期」接管。
- 后果同书同 action 双跑（:176-184 注释自述此前已真双进程复现过同类双持）。触发需 `utimesSync` **持续**失败而锁文件仍在（EPERM/EBUSY、杀软占用等第三方干扰）；锁文件被删的形态无需 stale 判定即已失锁。原报告两处（无重试无日志、10 分钟接管）均与源码一致，维持 P2（不升：需长持闸 + 持续失败双条件）。

## V6 · 一次性重发首发用量只进账本不进封套（部分成立，降 P3）

- 实读 turns-phases.ts:473-476：**代码自述**该口径——首发（失败）与重试各由本次 runTask 独立入账 ai-calls/账本，`out.attemptsUsage` 只聚合末次发送链，首发不并入封套。
- 实读 :502-528：收缩重试 `out = await sendTurn(retryToSend, …)`（:515）整体覆盖 out；:551-601 换网重试同式（:595）。故末次失败时连「首发 + 重试」都不进封套，只剩末次。
- 实读 :701-708：`doneUsage = out.attemptsUsage ?? out.usage` 后 emit `chat_done` 的 inputTokens/outputTokens——前端成本展示只吃这一路，与账本按次口径确实分裂，机制成立。
- **说过头处**：①这是**明示设计**（:473-476 与 :701-703 均写明理由），不是漏改；②两类重发的首发失败形态多为建连期失败（:480「超窗 400 属建连期失败、零增量」；换网族为连接错误），首发用量通常为 0/缺失，前端少计的多是 0，非「系统性低估成本」；③账本侧不丢次（按次入账），无数据丢失。故降 P3：真实存在但影响面小（仅「已计费但失败的调用」需供应商侧确实出字，如超时被计费）。

## 复核中发现的新问题

1. **V1 的面被低估（新发现，建议并入 V1 描述）**：脏路由分支丢弃的不只是 `flushDirty` 失败项——`conflict` 项本就被 `flushDirty` 扫描面排除（doc.ts:737 `!e.conflict`），守卫只把它们塞进同一条 console.warn（guard:307-311）；而同一决断在 precommit（guard:262-279）与 committed（guard:340-347）路径会经 `askDrop` 弹「切换到其他书将永久丢弃」让作者选择（guard:243-252）。**同一应用内三条离书路径、两套口径**，且冲突态可由后台 AI 改写落盘自然造出，触发比「保存失败」更日常。
2. **V2 的校验同源比原报告更广**：不止 revision 闸，改写链的新鲜度/复验三道闸（rewrite.ts:126-152）全部按章号定位，与写入路径同源，无法检出「重号解析错文件」。
3. **V5 的补充失效面**：锁文件被外部删除时不需要 stale 判定——对手 `open 'wx'` 直接成功（无告警），释放侧只有 payload 复读保护（cross-process-lock.ts:216-232）；「锁文件消失」这一态在两侧都无用户面留痕。

## 无法裁定项

- V6 的 `.cache/ai-calls.json` 落盘路径与文件名未复读（本次实读的是封套/前端侧）；「账本按次入账」仅以 turns-phases.ts:473-476 代码内注为据，未独立验证落盘文件内容。
- V4 未读 runUpdateHelper 尾部（update-helper.ts:340-408）：原报告「递归删」我以 prepareWorkDir（:273）与 swapDirs（:294-320）为据，未确认换新成功后对 `.old-*` 的删除时机。
- V1「脏路由分支在真实 vue-router 导航下必执行」未做运行时验证：依据为 watch(`immediate:true`) 结构 + guard:337-338「离书时分支已 doc.setBook('')」自述；未启应用实测 /book/A → /shelf 的落点。
- `/shelf` 路由的 bookName 参数形态未复读 router 定义（由 `name=''` 分支语义与上述自述推论）。
- 复核成本：工具调用 ≤25（实读源码片段 12 处，未跑测试、未跑 coverage）。
