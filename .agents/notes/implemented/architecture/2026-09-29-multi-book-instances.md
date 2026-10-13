# Agent Note: 多库多窗采用一库一实例（多进程）

Status: implemented

## 问题

作者需要在同一台机器上把多个书库并排打开。单实例单库的形态下，访问第二个库只能靠「切库」，而切库要重启应用，已打开的书库与窗口状态随之丢失。真正的约束在数据面：任务闸、SSE 流、worker、崩溃恢复都**按库**组织，两个库共用一个进程时，这些资源的归属要在运行时代码里逐处拆分。

## 决策

一库一实例：每个书库由独立的应用进程承载。实例身份是 `libraryInstanceKey(dir)`（`src/fs/user-data-path.ts`）——平台折叠后的库路径取 sha256 前 16 位 hex；win/darwin 折叠大小写、darwin 叠 NFC 归一、linux 全等；欢迎态用固定 key `welcome`。

实例的 Electron userData 落在 `<home>/instances/<instanceKey>/`（`instanceUserDataPath`）。应用级共享数据——providers/vault、`global.json`、`prompts/`、事件库、`workdir.json`、`studio-token.json`——留在共享根 `appDataHomeDir()`，由主进程以 `--user-data <home>` 下发给 server 子进程（`src/desktop/server-boot.ts` 解析）。

「同库单实例、异库多实例」不靠自建锁：Electron 原生单实例锁的作用域就是 userData 目录，两个实例目录不同即两个锁域；同库第二次启动拿不到锁，由 Electron 把已有实例的窗口拉到前台后自身退出（聚焦语义零额外代码）。打开新库的入口是 `spawnLibraryInstance(dir)`（`src/desktop/new-instance.ts`）：以 `--dir <p>` 拉起新实例，detached + unref——Windows 上非 detached 的子进程会加入父进程的 KILL_ON_JOB_CLOSE Job，父实例退出即被 OS 硬杀，父退子存只有 detached 才成立。

库路径解析有一条硬约束：**必须在 `app.setPath('userData')` 之前同步、零磁盘 IO 地算出**——key 决定 userData，userData 决定锁域。因此实例 key 不得改用 `bookHash`（`src/events/store-migrate.ts` 的 `trueCasePath` 逐段 `readdirSync`，失联网络卷上会同步冻结启动链，正是慢盘面加固要防的形态）。

## 曾考虑的替代方案

**单进程多主窗。** 把 `wins.mainWindow` 的单引用改成多实例、`serverManager` 改成 Map、菜单动作按焦点窗路由、IPC 上下文按 sender 解析库、退出语义改「全窗关完才退」。落选原因：改动面与风险显著更大，收益只有省内存与少一个进程；而按库拆分的资源本来就需要隔离，进程边界一次性解决。

**维持单实例单库 + 切库重启。** 保留现状，靠重启切换库。落选原因：并排看两个库是作者的真实工作流，切库重启把两个库变成串行访问，等于没有这个能力。

## 后果

换来的：库之间的隔离由 OS 进程边界承担——任务闸、SSE、worker、崩溃、内存全部互不可见；主进程改动收敛在「锁 + 状态分片 + 入口」三处，不动 `handleTrusted` 与 IPC 上下文解析。

付出的：每个库一份进程开销，Electron 基础内存按实例计；共享根上的跨进程 RMW（`workdir.json`、库登记等）从进程内互斥升级为跨进程互斥，需要补锁清单逐个兜住；「同机上有哪些实例、各开哪个库」成了新的观测与降级面。
