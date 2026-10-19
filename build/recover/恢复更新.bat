@echo off
rem ── CLWriting 更新中断还原入口（双击运行）────────────────────────────────
rem 编码约束：本文件按系统 ANSI 代码页（简体中文 Windows = GBK/936）保存，不得另存为 UTF-8——
rem cmd 以该代码页解析批处理，UTF-8 形态会让中文行与命令错位、注释被截断当命令执行（实测）。
rem 用途：更新换目录中途被杀（断电 / 任务管理器）会留下「原名目录缺席 + <原名>.old-<旧版本>
rem 残留」，快捷方式因此落空。本脚本把残留改回原名，不必先成功启动任何副本。
rem 同步关系（任一侧改名即脚本失效，锚定用例见 test/desktop/update-helper.test.ts）：
rem   exe 名 = CLWriting.exe —— src/desktop/update-helper.ts 的 PORTABLE_EXE_NAME
rem   旗标 = --recover-interrupted-update —— 同文件 RECOVER_UPDATE_FLAG
rem   残留命名 = <原名>.old-<旧版本> —— runUpdateHelper 的 oldDir 与启动维护的清扫命名
rem 运行位置：与 CLWriting.exe 同目录（中断现场下二者同在残留目录内）。
setlocal
for %%I in ("%~dp0.") do set "SELF=%%~fI"
for %%I in ("%SELF%") do set "PARENT=%%~dpI"
for %%I in ("%SELF%") do set "NAME=%%~nxI"
set "EXE=%SELF%\CLWriting.exe"
set "TARGET=%SELF%"
rem 名字不含 .old- 即应用目录未改名（正常目录 / 上次已还原）→ 直接按就绪处理。
rem 探测用空替换，与下面切片用的替换形态不同：cmd 的 %VAR:s=r% 对某些替换字符会静默不替换。
if "%NAME%"=="%NAME:.old-=%" goto :ready
rem 切出原名：先把 .old- 换成 #，再按 # 取第一段（cmd 的无分隔符切片不接受裸 .old-）。
set "MARKED=%NAME:.old-=#%"
rem 切不动（替换未生效）或切出的名字仍含 .old- → 不猜，交人工改名（猜错只会落「未还原」，不误改盘面）。
if "%MARKED%"=="%NAME%" goto :manual
for /f "tokens=1 delims=#" %%A in ("%MARKED%") do set "CANDIDATE=%PARENT%%%A"
if "%CANDIDATE%"=="" goto :manual
if not "%CANDIDATE%"=="%CANDIDATE:.old-=%" goto :manual
set "TARGET=%CANDIDATE%"
:ready
if not exist "%EXE%" goto :noexe
echo 正在还原应用目录……
echo   本脚本目录：%SELF%
echo   还原目标：%TARGET%
rem 启动前把工作目录挪出应用目录：进程 cwd 落在某目录内时该目录改名必失败（与 main.ts 助手态
rem 同款处置，挪到上级）；双击本脚本时 cwd 正是应用目录本身，不挪则改名必败。
pushd "%PARENT%"
"%EXE%" --recover-interrupted-update --target "%TARGET%"
if errorlevel 1 goto :nofix
echo.
echo 已就绪。请双击运行：%TARGET%\CLWriting.exe
goto :end
:manual
echo.
echo [需手动处理] 本目录名形如「应用名.old-版本」，但脚本未能安全推出原名：%NAME%
echo              请手动把本文件夹改名为去掉 .old-版本 的名字（如 CLWriting.old-1.2.3 改成 CLWriting），
echo              再运行里面的 CLWriting.exe。
goto :end
:noexe
echo.
echo [无法还原] 本脚本所在目录里没有 CLWriting.exe：%SELF%
echo            请把「恢复更新.bat」放回解压出来的应用目录（与 CLWriting.exe 同级）再双击。
goto :end
:nofix
echo.
echo [未还原] 没有找到可还原的旧版本目录（形如 CLWriting.old-1.2.3），或改名失败。
echo          兜底：重新下载便携 zip，解压到任意目录，用新目录里的 CLWriting.exe 启动。
echo          书稿与设置都在书库 / 用户数据文件夹里，换目录不影响。
:end
echo.
pause