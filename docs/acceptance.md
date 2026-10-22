# 验收记录（对照开发文档 §18 T01–T12）

所有验证均在本机真机执行（Windows build 10.0.26300，1707×1067 @1.5x，NVIDIA GPU），
自动化探针无需人工干预，原始结果保存在 `dist/verify/*.json` 与 `docs/screenshots/`。

## 总览

| 项 | 状态 | 证据 |
|---|---|---|
| T01 来源选择与质量档位 | ✅ 通过 | 界面截图 02-record.png；档位「设置 vs 实际能力」对照 |
| T02 屏幕录制（暂停/恢复/标记） | ✅ 通过 | `dist/verify/record-result.json`：4 分段 / 8 秒 / 暂停 2 秒不计入时长 / 1 标记 |
| T03 系统声音与麦克风 | ✅ 通过 | 双进程 WASAPI 实测（system 137280 帧 / mic 180000 帧）；探针 `npm run verify:capture` |
| T04 摄像头画中画 | ✅ 通过（受限环境用虚拟设备验证） | 设备枚举 → 打开 → 快照 → 2s 编码 → 独立解封装全链路：1280×720 avc 60 包 2.000s；e2e 带摄像头跑通 `cameraAssets:1` / camera 轨道 1 clip |
| T05 时间线编辑与撤销 | ✅ 通过 | 431 个领域测试（含 DeleteRange ripple、undo revision 单调） |
| T06 自动运镜 | ✅ 通过 | zoom.test.ts 26 项（含 1080p 上限 2.4× 边界、无点击停留检测） |
| T07 画布样式与画幅 | ✅ 通过 | 16:9 / 1:1 / 9:16 各自布局；导出实测 1920×1080 |
| T08 隐私遮挡 | ✅ 通过 | 未确认≠已遮挡文案；预览框选；遮挡随运镜求值 |
| T09 MP4 导出 | ✅ 通过 | `e2e-result.json`：300 帧 / 30fps / 1920×1080 / aac 2ch@48k / verified=true |
| T10 图文教程包 | ✅ 通过 | `e2e-recording-tutorial/`：index.html + tutorial.md + steps.json + 2 张 316KB PNG |
| T11 工程保存与恢复 | ✅ 通过 | 原子写 + prev 快照 + journal 重建（recovery.test.ts 31 项） |
| T12 崩溃恢复 | ✅ 通过 | journal 七步提交协议；verifySegment 拒绝坏段；恢复测试覆盖 |

## 关键实测数据

### 录制链路（WCS_RECORDER_PROBE=1，真实 GDI+WASAPI+WebCodecs）

```
分段：4 个，共 1,137,490 字节
每段：avc 1280×720，60 包，aac 2ch@48000，duration 2.0s（mediabunny 独立解封装）
帧数：8 秒 × 30fps = 240 帧 = 实测 240 包（帧率精确无漂移）
工程：project.json / journal.jsonl / pointer.jsonl / media/mic/*.wav 全部落盘
状态：ReadyToEdit，mediaTick 79,977,239（≈8.0s，暂停的 2 秒未计入）
```

### 端到端（WCS_E2E_PROBE=1：录制 → 工程 → 导出 → 教程）

最近一次实测（分段时长改 1.6s 后）：

```
录制：7 分段提交
工程：4 轨 / 3 clip / 2 标记 / 3 素材 / cameraAssets 0（未开摄像头）
导出：2,529,989 字节 / avc 1920×1080 30fps 300 包 + aac 2ch@48000
      encoder = "avc (prefer-hardware)"，verified = true
画面：4 个采样点 distinctColors 355–367（非空白），avgLuma 47
教程：2 张截图
```

不带摄像头的 e2e 全程 `ok=true`；带摄像头（`WCS_E2E_CAMERA=1` + 虚拟设备）时
`cameraAssets:1` / camera 轨道 1 clip / 导出 240 帧 1,390,559 字节 verified=true。

### 导出器专项（scripts/verify-exporter.cjs，48/48 PASS，overall=PASS）

- 取消：渲染中取消 + `.partial` 落盘后取消，均无残留（`leftovers=[]`）
- 磁盘不足：抛 `E_DISK_FULL`，无伪完成文件
- 进度：maxPerSecond=10、单调、5 阶段齐全、saw99=false
- 音频：gain 1→0.5003 / 0.5→0.2501（严格线性，无响度美化）；gain 4→限幅
- 快照：导出中途篡改原工程，输出仍是基线 300 帧（真快照）

### 界面（scripts/verify-ui.cjs，PASS，console 0 错误）

8 张截图：首页 / 录制设置 / 编辑器 / 画布属性 / 导出 / 教程 / 设置 / 悬浮条。
冒烟：播放推进时间码、7 轨道展开、遮挡「未确认」提示、输入框快捷键守卫。

### 领域层测试

```
Test Files  12 passed (12)
Tests       453 passed (453)
覆盖率：timebase 100% / timeMap 100% / commands 93.84%（行）
属性测试：5 处固定种子 × 200 组
```

### 性能基准（§16.2，WCS_PERF_PROBE=1 WCS_PERF_SECONDS=20，1080p@30fps）

| 指标 | 目标 | 实测 | 结论 |
|---|---|---|---|
| 首次有效画面 | ≤2000ms | 160–240ms | ✅ |
| 处理超时丢帧率 | ≤0.5% | 0% | ✅ |
| 音画偏差 | ≤80ms | 2–20ms | ✅ |
| 故障尾部损失 | ≤4s | 1600ms | ✅ |
| 1080p 导出速度 | ≤实时（≥1×） | 5.8–7.5× 实时 | ✅ |
| 录制覆盖率 | — | 100.4% | ✅（记录项） |
| 总工作集（1080p 录制） | ≤1.2GB | 2136MB | ❌ 见下 |
| 内存增长（60 分钟） | <100MB | 未做满 60 分钟长稳 | ⚠️ 未验证 |

**工作集未达标的说明（如实记录，不粉饰）**：
峰值 2136MB 超出 §16.2 的 1.2GB。已定位并修掉其中三处真实缺陷
（都属 §9.5「禁止无限积压帧消耗内存」的范畴）：

1. **编码窗口未复用**：`createRecorderWindow()` 从不给模块级 `recorderWindow`
   赋值，每段都新建一个隐藏窗口（各约 370MB）且永不释放。
   10 秒录制就堆出 7 个窗口、峰值 3.6GB。修复后全程只 1 个窗口。
2. **管道缓冲滞留**：`GrabberWorker` 用 `Buffer.concat` 累积、再 `subarray`
   切走，剩余视图一直引用原来那个大 Buffer，V8 无法回收，
   主进程内存随录制时长线性增长。改为处理完即拷贝出剩余小缓冲。
3. **编码器资源未释放**：每段新建 `SegmentEncoder`（硬件 VideoEncoder 上下文、
   OfflineAudioContext、1080p OffscreenCanvas 后备存储）却从不释放。
   补 `dispose()` + canvas 尺寸置零后主动归还。

三项合计把峰值从 **3633MB 降到 2136MB（-41%）**，40 秒录制从 3058MB 降到 2573MB。

剩余差距主要来自 Electron 多进程工作集的固定开销（主进程约 640MB、
编码渲染进程约 1280MB、GPU 进程、音频与采集子进程），
以及 1080p JPEG 帧在「主进程持有 → base64 序列化 → 渲染进程解码」链路上
不可避免的多份副本。要把峰值压进 1.2GB，需要把编码下沉到采集进程侧
（帧不经过主进程内存）或改用共享内存传递帧，属于结构性重做，
不在本次范围内。**该指标当前不达标，记录为已知限制。**

## 验证中发现并修复的真实缺陷

1. **单实例锁导致应用闪退**：受限环境拒绝在 AppData 创建锁文件 → `requestSingleInstanceLock()` 返回 false → 误判为"已有实例"直接 quit。修复：锁失败时警告并继续启动。
2. **状态机缺 Preparing→Recording**：倒计时为 0 时无法进入录制。修复：始终经过 Countdown 状态。
3. **工作进程路径解析错误**：`resolveWorkerPaths` 多回退一级目录，Electron 主进程找不到 grabber.exe。
4. **Vite 动态 import 404**：`/* @vite-ignore */` 导致运行时模块没打进产物 → 静态 import。
5. **分段编码无错误信息**：`executeJavaScript` 只报 "Script failed to execute" → 包一层 try/catch 把渲染进程堆栈带回来。
6. **渲染进程无 mediabunny**：Node require 不可用 → 静态 import 后 `configureMediabunny()` 注入。
7. **导出画面全黑**（能解码但 distinctColors=6）：工程里的素材是相对路径，渲染进程按绝对路径读失败 → 静默降级成背景。修复：相对路径补全为绝对路径；并新增 `probeVideo` 画面内容检查防止回归。
8. **~/Videos 不可写**：录制直接 EPERM → 工程根目录多级回退（视频 → userData → 主目录 → 临时目录）。
9. **录制成片比墙钟短 10%（覆盖率 88%）**：停止录制时先切段、后停采集进程，
   已写进管道但尚未读走的约 2 秒帧被整段丢弃。修复：先停采集进程并等 stdout 排空
   （`GrabberWorker.stop` 等 `end`/`close`），再切最后一段。
10. **最后一段「已提交但 stop() 已返回」**：`drainSegmentQueue` 在 `draining` 为真时
    直接 return，停止流程误判队列已空。修复：改为等待本轮 drain 完成信号
    （先用了轮询版本，与外层递归互相等待导致进程死锁，已改 Promise 信号）。
11. **段边界随帧抖动逐段后移**：相对累加「上一段结束 + 2s」，每段少最多一帧，
    11 段合计 17.68s（真实 20.05s）。修复：改用绝对时间栅格（原点 + n×段长），
    段起点取栅格边界而非实际首帧时刻。
12. **音画偏差 160ms 且随分段数线性放大**：分段 MP4 的音视频两轨不等长。
    视频轨按 fps 切（时长须为 1/fps 整数倍），音频轨按 AAC 帧（固定 1024 采样）切，
    2 秒 = 96000 采样 = 93.75 个 AAC 帧，编码器补齐到 94 帧后音频轨比视频轨长 5.333ms。
    修复：分段时长改为 **1.6 秒**（= 48 帧 @30fps = 76800 采样 = 恰好 75 个 AAC 帧，
    两者都能整除），偏差降到 2–20ms；顺带尾部损失从 2005ms 降到 1600ms。
13. **音频首段短 0.26 秒、末段只剩 0.04 秒**：WASAPI 进程启动比 GDI 采集慢，
    且停止时刻会截断。修复：`writeWav` 按该段声明时长补齐静音/截断，
    每段音频严格等于该段视频时长。
14. **编码窗口每段崩溃**：隐藏窗口连续做 WebCodecs 硬件编码时，
    Chromium GPU 沙箱在受限环境让渲染进程 exitCode -1。修复：`disable-gpu-sandbox`
    应用内开关（硬件编码仍走 GPU），导出速度同时从 4.2× 提升到 6–7.5×。
15. **每帧 JSON.stringify 阻塞主进程**：一段 1080p 约 12MB 文本，序列化是数百毫秒
    同步操作，期间管道读不进来，采集帧率掉到 25fps、丢帧率 0.9%。
    修复：增量拼接 JS 源码 + 每 8 帧 `setImmediate` 让出事件循环，丢帧率降到 0%。

## 环境限制（非代码缺陷）

- Windows Graphics Capture / desktopCapturer 被策略拒绝（E_ACCESSDENIED），GDI 路线不受影响
- WebCodecs 仅渲染进程可用；Node 侧只做封装级校验
- `%TEMP%` 对 esbuild 拒绝访问，构建时需把 TEMP 指到工作区（`npm run build` 已在 CI 说明中标注）
- Electron 必须带 `--no-sandbox`；`ELECTRON_RUN_AS_NODE` 必须清除
