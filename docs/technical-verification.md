# 技术验证记录（WP00）

本文记录开发启动前在本机完成的采集与编码能力验证。所有数字都是本机实测，不是文档中的规划目标。

- 验证日期：2026-10-21
- 验证机器：Windows 11（10.0.26300），x64，单显示器 1707×1067 @ 150% 缩放
- 参考文档：《Windows录屏工具完整开发文档》§7、§9、§11

## 1 结论摘要

| 能力 | 结论 | 依据 |
| --- | --- | --- |
| GDI 屏幕采集 | **可用**，720p 实测 95 fps | `spike-native.cs`、`spike-mb.cjs` |
| Windows.Graphics.Capture | **本机不可用** | `spike-capture.cjs`、`spike-wgc.cjs` |
| Chromium `getDisplayMedia` | **本机不可用** | `spike-capture.cjs` |
| 传统 `chromeMediaSource: desktop` | **本机不可用** | `spike-legacy.cjs` |
| WASAPI 系统回环 | **可用**（Initialize 成功，需有音频播放才有数据包） | `spike-wasapi2.cs`、`spike-loopback.cs` |
| WASAPI 麦克风 | **可用**，1.49 秒采到 71520 帧 | `spike-wasapi2.cs` |
| WebCodecs H.264 硬件编码 | **可用**（`avc1.640028` prefer-hardware = true） | `spike-capture.cjs` |
| WebCodecs H.264 软件编码 | **可用**（`avc1.640028` prefer-software = true） | `spike-capture.cjs` |
| WebCodecs AAC 编码 | **可用**（`mp4a.40.2`） | `spike-capture.cjs` |
| MP4 封装 | **可用**，30 帧含 AAC 音轨产出 165919 字节 | `spike-mb.cjs` |
| 全局快捷键 | **可用**（`Control+Alt+F9` 注册成功） | `spike.cjs` |
| 内容保护 `setContentProtection` | API 调用成功 | `spike.cjs` |

## 2 Windows.Graphics.Capture 不可用的原因

Chromium 的 WGC 后端在调用 `CreateForMonitor` / `CreateForWindow` 时返回 `E_ACCESSDENIED`：

```text
ERROR:third_party\webrtc\modules\desktop_capture\win\wgc_capture_source.cc:238
  CreateForMonitor failed with hr: -2147024891: [0x00000000]
ERROR:third_party\webrtc\modules\desktop_capture\win\wgc_capturer_win.cc:348
  Source is not capturable.
```

`-2147024891` = `0x80070005` = `E_ACCESSDENIED`。三种路径都失败：

1. `navigator.mediaDevices.getDisplayMedia()` + `setDisplayMediaRequestHandler` → `NotReadableError: Could not start video source`
2. 传统 `getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', ... } } })` → 同样 `NotReadableError`
3. 只取系统声音的 loopback（`audio: 'loopback'`）也会挂起

`desktopCapturer.getSources()` 本身能枚举出源和缩略图（说明 DWM 缩略图路径可用），但建立采集会话被拒。

**这不是本项目的代码缺陷**，而是该运行环境对 WGC 的权限限制。文档 §9.5 已经把「降级路径」列为要求（窗口不可采集时退回显示器裁切），本文据此确认降级路径必须作为**一等实现**，而不是兜底。

## 3 采用方案：原生采集工作进程

文档 §7.1 把区域录制定义为「选定显示器上的矩形裁切」，因此用 GDI `BitBlt` 从显示器 DC 上取指定矩形，完全符合该定义。实现为常驻子进程，避免每帧启动进程的开销：

```text
Electron 主进程  ──stdin "g\n"──▶  采集工作进程（GDI BitBlt → JPEG）
                ◀─stdout 长度+JPEG─┘
```

实测数据：

| 分辨率 | 帧数 | 耗时 | 帧率 | JPEG 平均大小 |
| --- | --- | --- | --- | --- |
| 1280×720 | 60 | 721 ms | 83.2 fps | 94 KB |
| 1280×720 | 30 | 315 ms | 95.2 fps | 104 KB |

720p 下 95 fps 有约 3 倍余量覆盖 30 fps，约 1.6 倍余量覆盖 60 fps。1080p 按像素数推算约 40 fps，可满足 30 fps；60 fps 需要实测复核（已列入待验证项）。

**限制**：GDI 是 CPU 拷贝路径，不经过 GPU。文档 §16.1 的 CPU 目标（平均不高于 20%）需要在实际录制中测量，目前未验证。Windows 10 1803 之后 `BitBlt` 走的是 DWM 合成后的桌面，窗口遮挡关系正确，但独占全屏游戏与受保护内容会被跳过——这与文档 §18.2 把「独占全屏游戏」列为限制项一致。

## 4 WASAPI 系统回环的注意事项

`GetMixFormat` 在本机返回 `wFormatTag = -2`（`WAVE_FORMAT_EXTENSIBLE` 的前身 IEEE float）、32 bit、48 kHz、立体声、blockAlign = 8。

回环端点初始化成功，但**无音频播放时采集不到数据包**（`packets=0`）。这是 WASAPI 回环的预期行为：只有渲染端点有流时才有数据。因此：

- 录制前不能因为「回环没数据」判定设备故障
- 界面电平表在静音时应显示为静音，而不是报错
- 需要单独验证「有音频播放时回环确实有数据」（`spike-loopback.cs` 通过 `SoundPlayer` 播放 440 Hz 音调来验证）

麦克风路径正常：1.5 秒采到 149 个包、71520 帧、峰值 1.0000。

## 5 WebCodecs 编码能力实测

```json
{
  "avc1.640028 prefer-hardware": true,
  "avc1.640028 prefer-software": true,
  "avc1.42E01E": false,
  "avc1.4D401F": false,
  "vp09.00.10.08": true,
  "mp4a.40.2 (AAC)": true,
  "opus": true
}
```

只有 `avc1.640028`（H.264 High Profile Level 4.0）可用，Baseline/Main Profile 的配置字符串不被支持。因此编码器固定使用 `avc1.640028`，并按 `prefer-hardware → no-preference → prefer-software` 顺序降级。

## 6 MP4 封装实测

用 mediabunny 的 `Output + Mp4OutputFormat + BufferTarget + CanvasSource + AudioBufferSource` 产出：

```text
frames=30  fps=30  video=avc  audio=aac  bytes=165919
mux elapsed=828ms
```

并用 `Input + FilePathSource + ALL_FORMATS` 读回成功，说明封装产物可被自身解析器解封装，满足文档 §11.4 的完整性检查要求。

## 7 环境相关的运行约束

| 约束 | 说明 |
| --- | --- |
| Electron 启动参数 | 必须带 `--no-sandbox`，否则进程以 `-2147483645` 退出 |
| `ELECTRON_RUN_AS_NODE` | 运行前必须清除，否则 `require('electron')` 返回路径字符串 |
| C# 编译器 | 只有 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，**C# 5 语法**：不能用 `$"..."`、`nameof`、`?.`、表达式体成员 |
| 编译输出目录 | 必须在构建期编译；Electron 子进程内调用 csc 会因权限被拒绝写入 |
| 临时目录 | `%TEMP%` 下写入被拒，工作文件放工程目录内 |

## 8 待验证项（未完成，不得当作已达标）

以下项目**尚未**实测，交付说明中不能声称达标：

- 1080p60 实际帧率与掉帧率
- 录制时 CPU 占用与工作集（文档 §16.1 目标）
- 长时（60 分钟）录制稳定性与内存增长
- 硬件编码器在 NVIDIA/AMD/Intel 三种 GPU 上的实际表现
- 多显示器与混合 DPI 场景
- 音频与视频的长时间漂移
- 内容保护窗口是否真的被 GDI 采集排除（GDI 路径下 `setContentProtection` 的行为需要单独验证）
