# 开发与验证

## 模块

| 路径 | 作用 |
| --- | --- |
| electron/main.ts、preload.ts | 权限边界、IPC、窗口、文件与运行时协调 |
| electron/native/ | grabber：GDI/PrintWindow；audio：WASAPI；pointer：鼠标钩子；统一 QPC |
| electron/capture/ | 状态机、媒体时钟、分段调度、现代采集和摄像头协调 |
| src/domain/ | 工程、命令、时间映射、关联剪辑、磁吸、场景与投影 |
| src/media/ | 解码、帧缓存、编码、混音、合成、时间拉伸和导出 |
| src/renderer/ | 界面、时间线及独立 recorder/camera/desktop/exporter 运行时 |
| tests/、scripts/verify-* | 单测、原生联调、真实编解码、界面与交付检查 |

工程使用 100ns 整数 tick 表示媒体时间，QPC 锚定后排除暂停区间。常用段长 1.6 秒，在 30 FPS / 48 kHz AAC 下对齐帧和采样。屏幕为独立 MP4，声音为 WAV，摄像头按相同起点和时长切片。提交使用临时文件、校验和原子替换；恢复依赖 journal。

## 自动验证

先运行 npm run check 和 npm run build。本批 928 项单测、55 条 IPC 契约；测试数量不代表所有硬件均已验收。

`tests/media/timeStretch.test.ts` 覆盖变速的时长与音高（基频、过零率）、跨块连续性与缓冲上界；`tests/media/exporter.test.ts` 末尾的「变速导出走保持音调的时间拉伸」用正弦素材做端到端验证。`tests/media/compositor.test.ts` 覆盖模糊/马赛克的取样-降采样-放大链路与取样失败回退。

| 命令 | 检查 |
| --- | --- |
| npm run verify:input-camera | 钩子启停、点击送达；2560×1440 可控流限制保留帧尺寸，暂停/切片/像素解码、过期帧拒绝。输入被拒绝时单列 unavailable。 |
| npm run verify:pointer-desktop | 打开专用窗口，90 秒内由交互桌面鼠标点击蓝色区域；核对目标窗口 DOM 点击和钩子 down/up、物理坐标、QPC。无点击或只有 DOM 事件均不通过。 |
| npm run verify:capture-perf | 带帧编号的动态图源，读取真实 JPEG 中的编号及尺寸，测原生 1080p30/60 回调节奏和工作集；ok 表示功能检查，targetMet 单独报告速率目标。WCS_BASELINE_GRABBER 可指定历史原生程序作同机对照。 |
| npm run verify:camera | 逐设备精确打开并保留原始错误，默认优先验证内置摄像头；快照、2 秒采样/编码/解封装。目标打开失败或运行时回退到其它设备均返回失败。WCS_CAMERA_DEVICE 可用唯一匹配的名称或 ID 指定目标；虚拟设备通过不代表物理设备通过。 |
| npm run verify:record | 正式主进程真实采集、暂停恢复、落盘和逐段封装校验。 |
| npm run verify:parity | 真实素材解码、三画幅、指针、多消费者缩略图、4K60 倍速导出。 |
| npm run verify:remaining | 保持音调的真实 WAV/M4A 编解码、音频调度、640/4K 滤镜像素检查、GPU/软件 3D、实际 PrintWindow 移动缩放关闭。 |
| npm run verify:all | 各页截图、画布适配、1366×768、200% 缩放、悬浮条和图标。 |
| npm run verify:performance | 默认 20 秒录制和导出，分开报告采集帧缺失与输出时间槽缺失，统计 Electron 加原生进程工作集。WCS_PERF_SECONDS 支持 3–3600 秒，WCS_PERF_SCALING=performance 选帧率优先；不达目标会返回失败。 |
| npm run release | 完整构建、NSIS、三个原生进程、归档完整性、解压版真实启动与正式 preload。 |

结果统一在 dist/verify/，截图在其 screenshots/ 子目录。探针数据在 .tmp/ 或 .verify-*，与 .appdata/projects 用户工程分开。

旧探针工程、媒体样本、浏览器缓存和安装包可以按用途清理；安装包与解压包可重新构建，`node_modules` 和当前本地 Electron 运行时仍是运行依赖。2026-10-24 清理时删除了旧测试产物，保留的简要 JSON 验证记录归档到 dist/reports/2026-10-24/；真实录制工程保留。`.tmp/`、`.verify-*/`、`dist/`、`release/` 均不提交 Git。

本机系统 TEMP 可能拒绝 esbuild 写入，包装脚本改用工作区临时目录。验收 Electron 清除 ELECTRON_RUN_AS_NODE 并传 --no-sandbox。打包缓存 .tmp/eb-cache 属于构建依赖；安装包尚无签名或更新服务。

Windows 开发启动和 Electron 验证统一通过 `scripts/lib/electron-runtime.mjs`，使用 `%LOCALAPPDATA%/WinCaptureStudio/runtime/electron-<版本>-<架构>/` 中的本地运行时缓存。只复制已安装的依赖，不修改区域映射、隐私权限或安全软件。版本独立、完整复制后原子改名，后续复用。手动运行源码目录中的 `node_modules/electron/dist/electron.exe` 会重新遇到本机的路径区域问题。

摄像头路径问题的隔离证据：同一原生测试程序从源码目录运行，`MFCreateDeviceSource=0x80070005`；复制到桌面普通目录或系统临时目录后为 `0x00000000`。`MapUrlToZone` 对源码目录的 Win32 可执行文件路径返回 3、对正常运行目录返回 0；源码文件的标准 `file:` URL 则返回 0，说明是路径的安全区域识别差异，不能据此断言设备权限未打开。内置摄像头在本地运行时下完成真实快照、1280×720/2 秒/60 帧 H.264 编码与独立解封装，正式预览 IPC 同样通过。

`verify:input-camera` 还覆盖边录边编码：编码期间必须继续收到视频帧回调，并能编码紧邻的下一段。摄像头缓冲保留独立克隆的上一段末帧作为边界参考；原帧与克隆分别释放。带摄像头的主进程 E2E 探针开启 `WCS_E2E_CAMERA=1` 后要求真实打开摄像头，并核对每个屏幕分段都有对应的摄像头文件；`WCS_E2E_CAMERA_DEVICE` 可指定同一 userData 下枚举的设备 ID。

## 设备复验

1. 正常 Windows 桌面录制全屏/区域，点击测试目标；暂停时点击、恢复再点击。检查波纹和 events/pointer.jsonl，多屏包含负坐标、不同 DPI。窗口采集时点击其上方其它窗口，不应记录到目标。
2. 打开摄像头确认真实取景，屏幕和摄像头拍摄同一计时器，反复暂停恢复，对比多个段边界与漂移。关闭开关/离开设置页应释放预览，正在录制时保留设备。
3. 强制现代采集动态窗口，检查遮挡、移动缩放、关闭；确认成功时没有回退。自动模式权限拒绝应提示并继续，强制模式应明确失败。
4. 真实工程检查缩略图；拖动和裁剪靠近其它片段/播放头，检查参考线、Alt 取消、碰撞约束、关联轨和撤销。
5. 独占运行至少 60 分钟，记录 Electron 与 grabber/audio/pointer 原生进程工作集。动态源须带帧序号；重复上一帧的输出不计入真实采集帧。
