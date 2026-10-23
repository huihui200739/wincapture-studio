# 主进程 / IPC / 工程存储 审计报告（electron/main.ts、preload.ts、projectStore.ts）

- 审计角色：main-auditor（Team 成员）
- 审计日期：2026-10-22
- 基线：typecheck 通过；`npx vitest run` 453+ 用例全绿（审计开始时）
- 本次范围：`electron/main.ts`、`electron/preload.ts`、`electron/projectStore.ts`（独占写入）
- 范围外只记录不修：`src/shared/**`、`electron/capture/**`、`electron/native/**`、`src/renderer/**`、`scripts/**`
- 新增测试：`tests/main-ipc/projectStore.test.ts`（26 例，真实文件 IO，不 import electron）
- 契约检查：`node scripts/check-ipc-contract.mjs` → `IPC 契约一致`（51 通道 / preload 51 / main handle 46 + on 3）

结论速览：**共确认 24 项缺陷（P0 3 / P1 11 / P2 10）**，全部在本范围内修复；3 项结构性/跨范围问题记录在 §6。

---

## 1. 修复清单

优先级口径：P0 = 可造成任意文件破坏/任意执行或必现数据丢失；P1 = 安全边界缺失、功能不可用、数据损坏风险；P2 = 健壮性/资源泄漏/误导性行为。

### P0

| # | 位置 | 根因 | 修复 | 验证 | 影响/攻击面 |
|---|------|------|------|------|-------------|
| P0-1 | main.ts `assertAllowedPath`（旧 344-359）、`export:start`（旧 1131-1134） | `export:start` 直接 `allowRoot(dirname(渲染进程传入的 outputPath))`，随后 `file:write/rename/remove/mkdir` 只校验「在某个已授权根内」。渲染进程传 `outputPath=C:\x.mp4` 即可把整个盘符加入白名单，进而任意写文件、`file:remove` 任意删除文件（`fsp.rm`）。 | 输出目录白名单拆成 `projectRoots`（本次打开的工程）与 `outputRoots`（对话框选择/系统视频/应用数据目录）；`export:start` 要求 `outputPath` 为绝对路径、`.mp4` 结尾、且落在已授权目录内，否则 `E_PERMISSION_DENIED`；`system:pick-file` / `system:pick-directory` 对话框选定后才登记授权目录。另加 `realpath(最近存在祖先)` 校验，防 Junction/符号链接逃逸。`file:*` 再叠加窗口角色校验（见 P0-3）。 | 代码级：旧路径无法再通过 `allowRoot` 注入任意目录；typecheck + 契约脚本通过；`assertAllowedPath` 依赖的纯逻辑 `isPathInside` 有单测（前缀同名目录/大小写/根目录边界）。 | 修复前：渲染进程一旦被注入（或 devtools/第三方脚本）即可获得对整盘的写/删能力，可写启动项、覆盖系统文件、删除用户资料。 |
| P0-2 | main.ts `registerMediaProtocol`（现 2141） | `wcs-media://local/<相对路径>?project=<任意路径>`：`ProjectStore.resolveInside(project, rel)` 只保证相对路径不逃出 **调用方给出的 project**，而 `project` 参数本身是渲染进程可控的。构造 `wcs-media://local/Windows/win.ini?project=C:%5C` 即可读任意文件（`net.fetch(file://…)`）。协议还缺 `registerSchemesAsPrivileged`，`<video>` 流式/缓存语义不可靠。 | 协议处理前要求 `project` 在 `projectRoots`（本次会话打开/创建/恢复的工程）内，且是「像工程」的目录或位于 `store.projectsRoot()` 下；`resolveInside` 后再用 realpath 复核仍在工程内；只允许普通文件。模块顶部对 `wcs-media` 调用 `registerSchemesAsPrivileged({standard, secure, supportFetchAPI, stream})`。 | 代码级：任意 `project` 参数被 403；`ProjectStore.resolveInside` 的穿越拒绝有单测；契约脚本通过（协议不计入 IPC 表）。 | 修复前：任意文件读取（含凭据文件、其他工程素材）；配合 P0-1 可先写恶意文件再用协议读取/回显，或窃取本地数据。 |
| P0-3 | main.ts 全部 `ipcMain.handle`（旧只有统一 `handle()`，不区分来源窗口；`roleFromUrl` 死代码即此意图） | 所有窗口（main/overlay/exporter/recorder/camera）的 preload 都暴露同一份 `window.wcs`；主进程不校验 IPC 发送方角色，任意渲染进程都能调用 `file:*`、`project:delete`、`export:*`、系统对话框等敏感通道。 | 新增 `handleFor(channel, roles, fn)`：用 `roleFromUrl(senderFrame.url \|\| sender.getURL())` 判定来源窗口并白名单校验（`roleFromUrl` 由死代码变为安全边界：main/overlay/exporter/recorder/camera）。分配：`file:write/rename/remove/mkdir` → 仅 exporter/recorder/camera；`file:read` → 全部窗口（主窗口 Timeline 需要读素材）；工程管理 → main；采集暂停/停止/标记/状态 → main+overlay；导出进度/完成回报 → 仅 exporter；`overlay:ready` → 仅 overlay。 | typecheck 通过；`scripts/check-ipc-contract.mjs` 通过；角色判定纯逻辑复用有单测覆盖的路径工具。 | 修复前：任一窗口被注入即可越过其余窗口边界，例如 overlay 渲染进程调用 `project:delete` 或 `file:remove`。 |

### P1

| # | 位置 | 根因 | 修复 | 验证 | 影响 |
|---|------|------|------|------|------|
| P1-1 | main.ts 全局快捷键 `Ctrl+Alt+R`（旧 1287-1295） | 停止录制直接 `engine.stop()`，绕过 IPC 的清理：`currentSession` 不清空、悬浮条不关闭、摄像头协调器不释放。下一次 `capture:start` 被「已有录制会话在进行中」拒绝，摄像头指示灯常亮。 | 抽出唯一入口 `stopCaptureSession()`（stop + `currentSession=null` + `closeOverlayWindow()` + `closeCamera()`），IPC `capture:stop` 与快捷键共用。 | 代码级；清理函数幂等（窗口已毁/协调器为空均不抛）。 | 快捷键停止一次后录制功能不可用，且隐私指示灯误导用户。 |
| P1-2 | main.ts `export:start`（旧 1136-1148） | `createExporterWindow()` 后若 `waitForReady` 或 `executeJavaScript` 抛错，`win.destroy()` 永不执行 → 隐藏 offscreen 窗口泄漏（每失败一次泄漏一个渲染进程，约数百 MB）。 | `try/finally` 中销毁；同时 `exporterWindows` 集合跟踪所有导出窗口，供取消与退出清理。 | 代码级（finally 覆盖 throw）；`export:cancel` 只遍历该集合。 | 导出失败重试会持续吃内存，最终 OOM。 |
| P1-3 | main.ts `export:cancel`（旧 1151-1161） | 对所有窗口串行 `await executeJavaScript('__wcsExporter?.cancel?.()')`。导出窗口编码期间 JS 队列被占，`await` 会卡住 IPC 几十秒；同时给主窗口/overlay 发无关脚本。 | 只向 `exporterWindows` 广播，且不 await（fire-and-forget + catch）。 | 代码级。 | 取消按钮「没反应」，IPC 被长时间阻塞。 |
| P1-4 | main.ts `waitForReady`（旧 642-645） | 只等 `did-finish-load`；页面加载失败/渲染进程崩溃时 Promise 永不 resolve，录制分段或导出永久挂起且无错误。 | 用 `once(did-finish-load)` + `once(did-fail-load)` + 20s 超时，失败抛 `E_UNKNOWN`（可重试），并清理监听器/定时器；`ERR_ABORTED(-3)` 交给超时兜底。 | 代码级（三路 settled 保证只结束一次）。 | 首段录制卡死、导出无响应且无日志。 |
| P1-5 | main.ts 窗口/退出生命周期（旧 166-171、1425-1433） | ①主窗口 `closed` 只置空引用：录制中的 recorder/overlay/exporter/camera 隐藏窗口会阻止 `window-all-closed`，进程留在后台（再启动命中单实例锁却看不到窗口）。②`window-all-closed` 只 `engine.cancel()`，不销毁隐藏窗口。③无 `before-quit` 收尾。 | 主窗口 `closed` → `shutdownApp()`；`window-all-closed` / `before-quit`（preventDefault 后异步收尾）统一走 `shutdownApp`（只执行一次）：录制中先 `engine.stop()`（15s 超时兜底→cancel）落工程，再关摄像头、销毁 overlay/recorder/exporter/camera，最后 `app.quit()`；`will-quit` 注销快捷键。 | 代码级；`shutdownStarted` 防重入。 | 关闭窗口后应用不退出、摄像头/麦克风占用、工程可能未落盘。 |
| P1-6 | main.ts `finalizeSessionProject`（旧 657-696）+ `projectStore.relocateAssets` | 资产 `hash` 用自造 `simpleHash(文件名列表)`，而 `project.ts` 约定 + `relocateAssets` 用的是「文件内容 sha256 前 32 位」。二者永不相等 → 「素材缺失按哈希重定位」完全失效（死代码 `hashFile` 的意图）。 | `finalizeSessionProject` 对 screen/mic/system/camera 资产的首个实际文件调用 `hashFile(content)`（`hashFile` 由未使用导入变为实际完整性/重定位依据）；`relocateAssets` 跳过空哈希，避免「任意不可读文件」误命中。 | 新增单测：写真实 wav，构造缺失 asset（hash=内容 hash）→ 重定位到 `media/mic/real.wav`；空 hash 不重定位。 | 素材被移动/改名后工程永久显示「素材缺失」，用户只能重建。 |
| P1-7 | projectStore `load` + `readProjectFile`（旧 165-238） | ①只校验 `schemaVersion` 数字，不迁移、不规整：v0/缺字段工程直接交给渲染层，渲染层按当前结构访问会崩；保存时又把 `schemaVersion` 改成当前版本，等于「未迁移却标成新版」。②未来版本工程解析失败时**回退到 prev 旧版**，用户看到旧数据，保存后把未来工程降级覆盖。③主文件损坏回退 prev 后，下一次保存会把损坏主文件备份覆盖掉唯一的 good prev。 | 读取统一走 `src/domain/migration.parseProjectJson`（JSON 校验、版本校验、旧版迁移、字段规整、未来版本只读提示）；迁移时按 `backupFileName` 落迁移备份并把规整结果原子写回；未来版本（E_SCHEMA_FUTURE）绝不回退 prev；`save` 备份 prev 前先尝试解析当前主文件，解析失败则跳过备份以保住回退点；`LoadResult` 增加 `migratedFrom/readOnlyNotice`，main 向界面发 `project-migrated` / `project-readonly` / `project-recovered-from-backup` 事件。 | 新增单测：v0 迁移（tracks 补齐、备份文件存在、写回 v1）；未来版本只读 + save 拒绝 + 不回退 prev；损坏主文件回退 prev 且后续保存不覆盖 good prev。 | 旧工程打不开或打开后崩溃；未来版本工程被降级覆盖（数据丢失）；损坏工程失去回退点。 |
| P1-8 | projectStore `save`（旧 257-323） | 临时文件名 `project.json.tmp-<pid>-<Date.now()>`：同一毫秒内并发保存（自动保存 + 手动保存）撞名，两个写者交替写同一个临时文件后 rename，可能写入半截内容或 rename ENOENT；且 `save` 先 `await ensureDir` 再入队导致落盘顺序不确定；rename 失败时临时文件残留。 | 临时名追加 `randomBytes(4)`；按工程目录（大小写不敏感）用 `queueSave` 串行化，入队后再 ensureDir（保证调用顺序=落盘顺序）；写失败/校验失败/rename 失败都清理临时文件；写后读回校验 `id` 与 `schemaVersion`；序列化改用 `serializeProject`（大 tick 用十进制字符串，§13.3）。 | 新增单测：8 个并发 save 后加载结果是最后一次调用（n7），目录无 `.tmp-*` 残留；写失败无残留。 | 自动保存与手动保存并发时工程 JSON 损坏（最坏整工程丢失）。 |
| P1-9 | projectStore `exportPack/importPack/copyDirSafe`（旧 531-586） | ①`importPack` 对目标目录先 `fsp.rm(recursive)` 再复制：导入同名工程包会**静默删除已有工程**。②`exportPack` 不校验工程目录、也不禁止目标在工程目录内部 → 复制进自己的无限递归/磁盘爆炸。③复制不跳过 `.partial`/`.tmp-` 中间文件。 | 导入：目标已存在时用 `uniqueProjectDir` 生成 `(2)` 后缀目录，绝不覆盖；失败清理半成品；拒绝源/目标互为父子。导出：要求存在 `project.json`；拒绝目标在工程目录内部；复制跳过临时文件并继续拒绝符号链接。 | 新增单测：同名导入不覆盖原工程；导出到工程内部抛 `E_INVALID_COMMAND`；损坏包导入后目标目录被清理。 | 导入工程包 = 删除用户原工程（数据丢失）；导出到工程内可打满磁盘。 |
| P1-10 | projectStore `uniqueProjectPath` 不存在（新建/录制复用 `defaultProjectPath`） | `project:create` 与 `capture:start` 直接 `defaultProjectPath(name)` + `ensureDir` + `save`：默认名「未命名工程」或同一秒开始的两次录制会写到同一路径，**覆盖已有工程**。 | 新增 `uniqueProjectPath`（存在则追加 `(2)`…），`project:create`、`capture:start`、`importPack` 全部使用；`defaultProjectPath` 额外处理 Windows 保留名（CON/NUL/COM1…）与结尾点号/空格。 | 新增单测：同名第二次创建得到 `同名 (2).wcaproj`；保留名/结尾点号清洗。 | 新建两个「未命名工程」即丢一个工程。 |
| P1-11 | main.ts 取消语义（`project:open`、`project:import-pack`、`project:export-pack`；lead 追认 P1-A/P1-B） | 系统对话框取消时 `return null` / `{ok:false}`：契约是 `IpcResponse<ProjectHandle>` 非空，渲染层解引用 null 抛 TypeError，或被误报为「打开失败」；`project:delete` 主进程又弹一次确认框，且主进程取消时返回 ok(null)，渲染层会提示「工程已删除」。 | 取消统一用 `AppError E_EXPORT_CANCELLED`（可重试、数据保留）；`project:delete` 去掉主进程二次确认（渲染层已确认），主进程只做 `.wcaproj` 后缀 + `looksLikeProjectDir` + 非根目录校验，校验失败抛错，成功才删。 | 代码级 + 契约脚本；`project:delete` 的路径校验逻辑可在后续补 main 层测试（当前受 electron 依赖限制）。 | 取消打开工程时崩溃/误报；两次确认框；取消删除被提示成已删除（且渲染层可能刷新掉列表）。 |

### P2

| # | 位置 | 问题 | 修复 |
|---|------|------|------|
| P2-1 | main.ts `freeDiskBytes`（旧 410-427） | 回退分支把 `target` 直接拼进 PowerShell 命令字符串：路径含单引号即可注入任意命令（如 `C:\Users\it's me\...`）。 | 只对盘符根（`/^[A-Za-z]:\\$/`）做 PowerShell 查询并转义单引号，其余直接返回保守估计；优先 `fs.statfsSync`。 |
| P2-2 | main.ts `store` 构造（旧 1367） | `ProjectStore` 用默认 `os.homedir()/Videos`，而界面/系统信息用 `app.getPath('videos')`；组策略重定向 Videos 时默认工程目录与界面显示不一致。 | 构造时传入 `{ videosPath: () => app.getPath('videos'), homePath: () => app.getPath('home') }`。 |
| P2-3 | main.ts `capture:start` | 渲染进程配置完全不校验（qualityId/sourceKind/fps/countdown/region/deviceId 任意值），非法配置会进引擎后才失败，错误信息不友好；`QUALITY_PROFILES` 未使用导入正是此意图。 | `validateCaptureConfig()` 规范化校验（未知 qualityId 拒绝、fps 0..240、countdown 0..10、region 边界、字符串长度），非法抛 `E_INVALID_COMMAND`；`QUALITY_PROFILES` 由未使用导入变为校验依据。 |
| P2-4 | main.ts `capture:start` 失败路径 | `engine.start` 抛错时已打开的摄像头不释放（指示灯常亮、隐藏窗口泄漏）。 | `try/catch` 中 `await closeCamera()` 后 rethrow。 |
| P2-5 | main.ts `capture:stop`（旧 1331-1345） | 停止成功后又 `store.load()` 再 `touchRecent`；若 load 失败（工程文件异常）整个 stop 报失败，前端看不到录制结果。 | 直接复用 `stopCaptureSession()`；`finalizeSessionProject` 内部已 touchRecent，删除重复 load/touch。 |
| P2-6 | main.ts `*:dialog` 调用（旧多处 `mainWindow!`） | 主窗口关闭后 `mainWindow!` 为 null，`dialog.show*` 抛 TypeError，错误信息与用户操作无关。 | `showOpenDialog/showSaveDialog` 包装：有主窗口时作为 parent，否则使用无 parent 重载。 |
| P2-7 | main.ts `system:open-path` / `system:show-in-folder` / `project:reveal`（旧 1185-1193、967-970） | 渲染进程可传任意路径：`shell.openPath` 对 `.exe/.bat/.ps1` 等于任意程序执行；reveal 无校验。 | `assertOpenablePath`：必须在工程/导出/视频/诊断目录内且存在；`openPath` 仅允许媒体/文档扩展名；`project:reveal` 要求 `looksLikeProjectDir`。 |
| P2-8 | main.ts `overlay` 相关（旧 1262-1265、486-489、852） | ①`overlay.update` 用 `send`，主进程用 `ipcMain.handle` 注册 → 消息永远到不了 handler（死路）。②`overlay:ready`/`overlay:command` 无主进程实现：悬浮窗 ready 时错过状态、全局 Ctrl+Alt+M 拿不到备忘录内容。③`overlayWindow?.webContents.send` 未判活，窗口销毁后抛异常。 | preload `update` 改 `invoke`；main 注册 `overlay:ready`（校验 overlay 角色 + 推 `lastStatus`）与 `overlay:command` 发送（悬浮窗 ready 后快捷键「标记」交给悬浮窗，从而带上备忘录当前行；未 ready 时直接 `engine.addMarker`）；新增 `sendToOverlay()` 判活包装；`window:update-overlay` 合并到 `lastStatus` 再推送。 |
| P2-9 | main.ts `captureListSources` vs preload `listDisplays`（lead 追认第 8 条） | `listDisplays()` 调 `capture:list-sources` 返回 `CaptureSourceInfo[]`，但契约是 `DisplayInfo[]`。RecordView 用 `displays.find(d => d.id === source.displayId)?.scaleFactor` 永远 undefined → 界面渲染「undefined× 缩放」。 | 新增独立通道 `capture:list-displays`（lead 已收进 IPC 表 `IPC.captureListDisplays`），main 返回真正的 `DisplayInfo[]`（id=显示器 id、bounds、scaleFactor、isPrimary、rotation、refreshRate），preload 改调该通道。 |
| P2-10 | main.ts `export:*` IPC 回报 + `lastExport`；`!` 死通道 | `export:progress` 允许任意窗口伪造；`export:report-progress`/`exporter:progress` 两个 handler 全仓无发送方（重复/遗留）；`project:delete` 的 fsp.rm 前无目录有效性校验（已并入 P1-11）。 | `export:progress`/`export:complete` 只接受 exporter 角色；删除两个无发送方 handler；`ipcMain.on` 数量回到 3。另加 `process.on('unhandledRejection'/'uncaughtException')` 日志 + `main-error` 事件，避免隐藏窗口异步失败静默。 |

### 附加加固（无独立编号）

- `app.on('web-contents-created')`：`setWindowOpenHandler` 一律 deny；`will-navigate` 只允许 `dist/renderer/index.html`（打包）或 `WCS_DEV_SERVER`（开发）；`will-attach-webview` 阻止。修复前导航到远程页面时 preload 仍注入，远程页面可拿到全部 IPC 能力。
- `setPermissionRequestHandler/CheckHandler` 增加来源校验（仅应用自身页面可申请摄像头/麦克风/屏幕采集）。修复前任意来源可申请。
- 所有窗口显式 `webSecurity: true`、`allowRunningInsecureContent: false`、`nodeIntegrationInSubFrames: false`。`sandbox:false` 保留（见 §5 遗留）。
- `file:write` 校验 `data` 必须是 `Uint8Array`；`file:read` 拒绝目录与 >512MB 单次读取（防打爆渲染进程堆）；`file:remove` 拒绝目录。
- `system:pick-file` 的 `filters` 结构清洗（只接受 `{name, extensions[]}`，extension `[a-z0-9]{1,12}`），`defaultName` 取 basename 并截断。

---

## 2. 已知线索的逐项结论

| 线索 | 结论 | 处理 |
|------|------|------|
| `main.ts` `hashFile` 导入未使用 | **不是死代码，是遗漏的完整性依据**。`MediaAsset.hash` 在 `src/domain/project.ts` 明确约定为「文件内容 sha256 前 32 位」，`projectStore.relocateAssets` 也按内容哈希匹配；但 `finalizeSessionProject` 用自造 `simpleHash(文件名/大小)`，导致按哈希重定位永远不命中。 | 改为 `await hashFile(实际文件)`；`simpleHash` 删除。 |
| `main.ts` `roleFromUrl` 未使用 | **不是死代码，是遗漏的 IPC 来源窗口判定**。preload 用 `location.hash` 决定 `role`，主进程却没有对应的发送方校验（P0-3）。 | 复活为 `senderRole()`/`assertSenderRole()` 的角色判定核心，补齐 `camera` 角色；配合 `handleFor` 做最小权限。 |
| `main.ts` `buildPayloadSource` 未使用 | **死代码**（注释自称「参考实现与单元测试入口」，但全仓无测试、无调用）。逐字段核对：内联版与它生成的 JS 源码字段顺序与内容完全等价（`index,startTick,durationTicks,width,height,fps,frames:[{mediaTick,jpeg}],audio:{mic,system}`，audio 都是 `{mic:[...],system:[...]}`）。内联版额外做了「边拼边释放原始 Buffer」的内存优化，是唯一权威实现。 | 删除该函数，避免后续误改两份实现；录制载荷逻辑保持不变（无行为变更）。 |
| `projectStore.ts` `mime` 未使用 | **死代码残留**。`readMedia` 返回的是 `wcs-media://` 流式 URL，不使用 data URL，因此 mime 无处返回（`MediaInfo` 契约也没有 mime 字段）；旧代码另有 `...({bytes: stat.size})` 的额外字段 hack。 | 删除 mime 与 bytes hack；保留 `sampleRate/channels` 的 wav 推断。`MediaInfo.durationSeconds/width/height` 仍为 0（见 §5）。 |

---

## 3. 验证方式与结果

1. **typecheck**：`npx tsc --noEmit -p tsconfig.json` → 0 error。
2. **未使用告警（本范围）**：`npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.json | grep electron/(main|preload|projectStore)` → 0 条（其余文件属其他 agent 范围）。
3. **单元测试**：`npx vitest run tests/main-ipc` → 26/26 通过（见 `tests/main-ipc/projectStore.test.ts`）。
   - 覆盖：路径穿越/绝对路径/NUL 拒绝、`isPathInside` 边界、原子保存与临时文件清理、并发保存串行化、prev 快照、损坏回退、未来版本只读、v0 迁移、最近列表去重/上限、导入不覆盖、导出防自包含、哈希重定位、readMedia URL/越界、目录命名。
4. **IPC 契约**：`node scripts/check-ipc-contract.mjs` → `IPC 契约一致`（51 通道；main `handleFor` 46 + `ipcMain.on` 3）。
5. **无法在 vitest 中直接测的部分**（main.ts 依赖 electron API）：窗口生命周期、角色校验、协议处理、退出流程给出代码级证明 + 逐路径人工走查；未运行 electron GUI（按纪律留给 lead 的 verify/e2e）。

---

## 4. preload 暴露面 / 契约影响（需 lead 知悉）

- `listDisplays()` 改调新通道 `IPC.captureListDisplays`（lead 已加入 `src/shared/ipc.ts`），返回真正的 `DisplayInfo[]`；`src/shared/api.ts` 的声明无需变化。
- `overlay.update()` 由 `ipcRenderer.send` 改为 `invoke`，与主进程 `ipcMain.handle` 匹配；`OverlayApi.update` 形态不变（仍返回 void，内部 fire-and-forget）。
- preload 中原先硬编码的通道改为 `IPC.captureListDisplays / projectReadPointerLog / exportComplete / overlayCommand / overlayReady`（lead 已收进契约表）。
- 取消语义（lead 追认 P1-A）：`project:open`、`project:import-pack`、`project:export-pack` 取消时抛 `E_EXPORT_CANCELLED`，不再 `ok(null)`/`{ok:false}`。需要 ui-core 侧按错误码展示「已取消」而非「失败」（lead 已与 ui-core 同步）。`api.ts` 的 `openProject` 是否 nullable 由 lead 决定（主进程已不返回 ok(null)）。
- `project:delete` 不再有主进程二次确认框（渲染层 HomeView 已有确认）；主进程只做路径/工程有效性校验。
- 删除死通道 `export:report-progress`、`exporter:progress`（全仓无发送方）；`src/shared/ipc.ts` 中被 lead 删除的 `project:media-info`、`export:list-jobs`、`window:show` 在 main/preload 中均无引用（契约脚本已确认）。

---

## 5. 未修复风险 / 遗留（明确记录，未在本轮改）

1. **`sandbox:false` + 进程级 `--no-sandbox`**：本机 Electron 必须以 `--no-sandbox` 启动（否则 0x80000003），因此即使把窗口 `sandbox` 设为 true 也会被进程级开关覆盖。当前安全边界依赖 `contextIsolation + nodeIntegration:false + IPC 角色/路径白名单`。彻底启用需要先解决 GPU 沙箱崩溃问题再做全量回归，属于产品/环境级决策，未在本轮改动（改错会导致应用完全无法启动）。
2. **输出目录内的写删仍是「目录级」授权**：用户通过对话框选定/系统视频目录后，exporter 角色可在该目录内写任意文件名、删除任意文件。已用角色白名单把能力限制在导出隐藏窗口，但若导出渲染进程被注入，仍可破坏该目录内容。进一步收紧需要按「精确文件 + 扩展名」授权（导出管线还要写 `.partial`、多帧教程图片，改动面大），建议后续专项。
3. **符号链接/Junction 校验是「最近存在祖先 realpath」**：可防已存在的 junction 逃逸；对「检查时不存在、随后被替换成 junction」的 TOCTOU 竞态没有完全覆盖（Windows 普通用户创建 junction 需要权限，风险较低）。
4. **恢复未完成录制全链路未接线**（跨范围，见 §6-2）：`project:recoverable` 只扫描最近列表，而最近列表只在录制 `finalize` 时写入；崩溃会话没有 `project.json`、也不在最近列表 → 恢复入口实际永远为空。`src/domain/recovery.rebuildFromJournal` 无任何调用方。修复需要 capture 侧（录制开始即落初始 project.json / 写 recent）与主进程（恢复时用 journal 重建工程）协同，超出本文件安全改动范围。
5. `buildSystemInfo().hardwareEncoding` 仍硬编码 `true`（未做编码器探测），界面可能显示不实的硬件编码能力；探测逻辑在渲染侧（SettingsView 诊断面板），主进程侧暂未接入。
6. `readMedia` 的 `durationSeconds/width/height` 仍返回 0（旧行为）。界面/导出侧实际通过 `listMediaSegments` + mediabunny 探测取得时长，未影响功能；若要填真实值应在迁移到 mediabunny 探测后统一。
7. `copyDirSafe` 对 Windows Junction 的识别依赖 `Dirent.isSymbolicLink()`（Node 对 reparse point 通常报 symlink），极端情况下特殊 reparse point 可能漏检；工程包格式本身不是 zip（目录复制），不存在 Zip Slip/解压炸弹，但也没有体积上限（用户自己的工程包，风险可接受）。
8. `project:open` 允许渲染进程传入任意已存在 `.wcaproj` 目录（用于「最近工程」直接打开）；打开后该目录会加入本次会话可读白名单。这是功能所需，但意味着「打开一个恶意工程目录」= 允许读取该目录内任意文件（只能读、且仅该目录）。建议后续增加「工程目录必须由对话框选择/最近列表来源」的来源标记。
9. **退出时正在进行的导出**：`shutdownApp` 会销毁 exporter 隐藏窗口（编码随之中断），但没有等待 exporter 自己清理 `.partial` 临时文件的机会，异常退出时输出目录可能残留 `*.partial`。下次导出会覆盖同名临时文件，不影响正确性，但会占空间；彻底处理需要在 exporter 侧实现「销毁前同步清理」握手。
10. **`project.prev.json` 只保留 1 份回退快照**（§13.2 的「上一版」语义），没有多版本轮转/容量上限；单份快照不会无限增长，但用户连续保存后只能回退一步。若需要「历史版本」，属于产品功能而非缺陷。
11. **`uncaughtException` 处理只记录日志不退出**：目的是避免隐藏窗口异常导致「应用静默消失 + 未保存数据丢失」；代价是极端情况下进程可能带伤继续运行。是否升级为「提示用户重启/自动重启」需要产品决策。

---

## 6. 跨范围发现（只记录，不修改）

1. **`src/renderer/lib/store.tsx` 启动即弹「打开工程」对话框**（P1，ui-core 范围）：启动 effect 里无条件 `await wcs().openProject()`，注释写「mock 模式下自动打开示例工程」，但 native 模式也会走真实 IPC → 每次启动弹出系统「打开工程」对话框；用户取消则 catch 后推「打开工程失败」toast（叠加上本次主进程取消语义改造，文案会是「已取消打开工程」）。应仅在 `apiMode() === 'mock'` 时调用。
2. **恢复功能缺 capture 侧接线**（P1，capture/lead 范围）：见 §5-4；`src/domain/recovery.rebuildFromJournal` 无调用方，`project.json` 只在停止录制时落盘。
3. **`project:recoverable` 的 `estimatedLossTicks` 固定 20_000_000（2s）**：未按 journal 最后一段与分段目标（1.6s）计算，可能与真实尾部损失不符；属于展示精度问题，未改。
4. **`export:start` 期间 IPC handler 全程占住一次 invoke**（lead 已知）：导出是长任务，主进程必须等隐藏窗口 `run()` resolve。若界面需要「启动后立即返回 + 靠事件推进度」，需要改契约（新增 jobId 语义），本轮未动。
5. **`src/shared/ipc.ts` 的 `RecentProject.recoverable` / `missingMedia` 由主进程在 touchRecent 时计算**，若工程目录后续被外部移动，最近列表会按新扫描结果刷新（已修复 listRecent 每次回查磁盘），但 `recoverable` 字段仍是上次写入值；无害。
6. `electron/capture/captureEngine.ts`、`workers.ts` 等由 capture-auditor 负责；本报告未重复覆盖其死代码/状态机问题。

---

## 7. 改动文件清单

- `electron/main.ts`：安全边界（角色/路径/协议/导航/权限）、生命周期与退出清理、快捷键共用停止路径、导出窗口泄漏与取消、waitForReady 超时、取消语义、参数校验、死代码（`buildPayloadSource`）删除与线索复活（`roleFromUrl`/`hashFile`/`QUALITY_PROFILES`）。
- `electron/preload.ts`：`listDisplays` 独立通道、`overlay.update` 改 invoke、硬编码通道改用 `IPC.*`。
- `electron/projectStore.ts`：迁移接入（`parseProjectJson/serializeProject/writeProject`）、原子写并发串行化与唯一临时名、prev 备份保护、未来版本不回退、导入不覆盖、导出防自包含、哈希重定位修复、最近列表并发/磁盘一致性、唯一工程目录、readMedia 清理。
- `tests/main-ipc/projectStore.test.ts`：新增 26 例回归测试。
- `docs/audit/main-ipc.md`：本报告。
