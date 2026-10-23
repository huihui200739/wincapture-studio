# 开发与验证

## 模块

| 路径 | 作用 |
| --- | --- |
| electron/main.ts、preload.ts | 权限边界、IPC、窗口、文件与运行时协调 |
| electron/native/ | grabber：GDI/PrintWindow；audio：WASAPI；pointer：鼠标钩子；统一 QPC |
| electron/capture/ | 状态机、媒体时钟、分段调度、现代采集和摄像头协调 |
| src/domain/ | 工程、命令、时间映射、关联剪辑、磁吸、场景与投影 |
| src/media/ | 解码、帧缓存、编码、混音、合成和导出 |
| src/renderer/ | 界面、时间线及独立 recorder/camera/desktop/exporter 运行时 |
| tests/、scripts/verify-* | 单测、原生联调、真实编解码、界面与交付检查 |

工程使用 100ns 整数 tick 表示媒体时间，QPC 锚定后排除暂停区间。常用段长 1.6 秒，在 30 FPS / 48 kHz AAC 下对齐帧和采样。屏幕为独立 MP4，声音为 WAV，摄像头按相同起点和时长切片。提交使用临时文件、校验和原子替换；恢复依赖 journal。

## 自动验证

先运行 npm run check 和 npm run build。本批 880 项单测、55 条 IPC 契约；测试数量不代表所有硬件均已验收。

| 命令 | 检查 |
| --- | --- |
| npm run verify:input-camera | 编译点击测试程序；钩子启停、点击送达；可控视频流暂停、切片和像素解码。系统拒绝输入时单列 unavailable，不算送达通过。 |
| npm run verify:camera | 物理设备枚举、打开、快照、2 秒采样/编码/解封装。无设备或权限失败会返回失败。 |
| npm run verify:record | 正式主进程真实采集、暂停恢复、落盘和逐段封装校验。 |
| npm run verify:parity | 真实素材解码、三画幅、指针、多消费者缩略图、4K60 倍速导出。 |
| npm run verify:remaining | M4A 与取消清理、音频调度、GPU/软件 3D、实际 PrintWindow 移动缩放关闭。 |
| npm run verify:all | 各页截图、画布适配、1366×768、200% 缩放、悬浮条和图标。 |
| npm run verify:performance | 默认 20 秒录制和导出，报告实际采集 FPS、音画时长、Electron 工作集；WCS_PERF_SECONDS 可调整。 |
| npm run release | 完整构建、NSIS、三个原生进程、归档完整性、解压版真实启动与正式 preload。 |

结果统一在 dist/verify/，截图在其 screenshots/ 子目录。探针数据在 .tmp/ 或 .verify-*，与 .appdata/projects 用户工程分开。

本机系统 TEMP 可能拒绝 esbuild 写入，包装脚本改用工作区临时目录。验收 Electron 清除 ELECTRON_RUN_AS_NODE 并传 --no-sandbox。打包缓存 .tmp/eb-cache 属于构建依赖；安装包尚无签名或更新服务。

## 设备复验

1. 正常 Windows 桌面录制全屏/区域，点击测试目标；暂停时点击、恢复再点击。检查波纹和 events/pointer.jsonl，多屏包含负坐标、不同 DPI。窗口采集时点击其上方其它窗口，不应记录到目标。
2. 打开摄像头确认真实取景，屏幕和摄像头拍摄同一计时器，反复暂停恢复，对比多个段边界与漂移。关闭开关/离开设置页应释放预览，正在录制时保留设备。
3. 强制现代采集动态窗口，检查遮挡、移动缩放、关闭；确认成功时没有回退。自动模式权限拒绝应提示并继续，强制模式应明确失败。
4. 真实工程检查缩略图；拖动和裁剪靠近其它片段/播放头，检查参考线、Alt 取消、碰撞约束、关联轨和撤销。
5. 独占运行至少 60 分钟，记录 Electron 与 grabber/audio/pointer 原生进程工作集。动态源须带帧序号；重复上一帧的输出不计入真实采集帧。
