# 界面改进落地记录（对照 `UI改进建议.md`）

实施日期：2026-10-22。基线提交 `c599302`（与评审所用快照一致）。
所有结论都来自本机真实运行的验证脚本，不是目测。

## 验证入口

```powershell
npm run typecheck      # TypeScript 全仓类型检查
npm test               # 453 个领域层单元测试
npm run build          # 原生 + 主进程 + 界面
npm run verify:ui      # 8 张界面截图 + 控制台错误检查
npm run verify:stage-fit  # 预览 contain 适配（P0 验收）
npm run verify:layout     # 1366×768 / 200% 缩放 / 长文案（P0/P1 验收）
npm run verify:overlay    # 460×132 真实悬浮条不被裁切
npm run verify:icon       # 图标接入（ICO 档位 + 品牌图解码）
npm run verify:all        # 上面五个依次跑
```

最近一次全部结果：`typecheck` 无错误、453/453 测试通过、五个验证脚本 `overall=PASS`，
控制台错误 0。原始 JSON 在 `docs/screenshots/verify-*.json`。

## P0

### 1. 编辑器预览留白过大、源画面与摄像头被截断

**根因（代码事实，不是猜测）。** `.stage-canvas-inner` 原来是 `display:flex` 居中容器，
canvas 用 `max-width/max-height:100%` 约束。百分比高度在 flex 行里没有确定的参照高度，
canvas 按固有尺寸（1280×720）撑开容器，超出部分被 `.stage-canvas-wrap` 的 `overflow:hidden`
裁掉；遮挡层是绝对定位铺满 inner 的，于是和真实画面错位。

**修法。** `EditorView` 用 `ResizeObserver` 量出预览容器的内容盒（已扣 padding），
再按「可用宽高 + 输出画幅」显式算出 contain 盒（`stageFit`），canvas 与遮挡层共用这个盒子：

```
availW/availH → width = availW, height = width / aspect
若 height > availH → height = availH, width = height * aspect
```

画幅比例取自 `evaluateScene` 的 `outputWidth/outputHeight`（与导出同一路径），
所以横屏、方形、竖屏都能完整显示，时间线折叠/展开后重新测量并保持居中。

**实测（`verify-stage-fit.json`）。**

| 场景 | 可用区域 | 显示尺寸 | 显示比例 / 画布比例 | 留白 L/R/T/B |
| --- | --- | --- | --- | --- |
| 16:9 | 1005×427 | 759×427 | 1.778 / 1.778 | 139/139/16/16 |
| 1:1 | 1005×427 | 427×427 | 1.000 / 1.000 | 305/305/16/16 |
| 9:16 | 1005×427 | 240×427 | 0.562 / 0.563 | 399/399/16/16 |
| 16:9（时间线折叠） | 1005×591 | 1005×565 | 1.779 / 1.778 | 16/16/29/29 |

判定项：不裁切、遮挡层与画面矩形一致、左右与上下留白对称、贴住某一对边、显示比例等于画布比例。
四个场景全部通过。

### 2. 录制页设备开关重复

`录制选项` 面板原来的三个 `Toggle`（系统声音 / 麦克风 / 摄像头）与左侧「声音」「摄像头」
面板是同一份状态（`config.systemAudioEnabled` 等），同一个开关出现两次。

现在每项设备只在各自面板保留一处开关，右侧面板只留倒计时与一句说明；
「开始前检查」改成紧凑 chip 一览（来源 / 麦克风 / 系统声音 / 摄像头 / 磁盘 / 编码），
开始按钮只保留顶部一处。

`verify-layout` 会枚举所有 `.wcs-toggle-label` 并断言无重复：实测 `duplicates: []`，
标签为「整屏 / 麦克风 / 系统声音 / 录制摄像头画中画」，各一次。
1366×768 窗口下「开始录制」按钮位于 `top:82 bottom:118`（视口高 706），无需滚动。

## P1

### 3. 首页重复入口与系统信息

- 删除右栏「开始」卡片（与主横幅的「新建录制」重复三次的第 3 处）。
- 主横幅改为「新建录制 / 打开工程 / 继续编辑」；`打开工程` 走 `openProject()` 的真实文件选择，
  原来那个按钮是「打开目录」且调用了 `pickDirectory()`（只是选目录，不会打开工程）。
- 删除右栏「系统」面板（系统信息在设置页已有完整版本）。
- 「当前工程」从五行键值表改成名称 + 一行摘要 + 两个操作。
- 恢复会话保留，但只在存在时显示一条可操作提示。

`verify-layout` 实测：首屏主按钮 `top:190 bottom:230`、最近工程 `top:596 bottom:689`
（视口 706），「新建录制」全页只出现 1 次。

### 4. 快捷卡片标题与说明粘连

原因是标题、说明都是 `<span>`，CSS 没设 `display`，行内元素在同一行内排。
现在 `.quick-action-title` / `.quick-action-desc` 显式 `display:block`，
容器改成 `flex-direction: column`，说明 `overflow-wrap: anywhere` 允许换行。

`verify-layout` 断言 `.quick-action-title` 与 `.quick-action-desc` 均为块级且不重叠
（`problems: []`）。首页已不再使用快捷卡片，但样式规则仍保留并有断言覆盖，
因为空态与后续复用会用到。

### 5. 保存 / 撤销 / 重做重复

原来顶栏和编辑器舞台工具栏各有一组保存、撤销、重做。

现在职责单一：
- 顶栏（仅编辑器视图）：工程名、保存、撤销 / 重做、上次保存时间。
- 舞台工具栏：播放控制 + 遮挡框选提示，不再有保存/撤销/重做。
- 时间线工具栏：分割 / 删除 / 折叠 / 缩放，剪辑工具只在这里。

`verify-ui` 的编辑器检查仍然通过（播放后时间码推进 `00:00.00 → 00:00.71`，分割/撤销交互正常）。

### 6. 字号与控件尺寸

按建议表的逻辑像素值统一（原来大量 10.5px 说明文字、30px 中号按钮）：

| 项 | 旧值 | 新值 |
| --- | --- | --- |
| 正文 | 13px | `--fs-body: 14px` |
| 标签 | 11.5px | `--fs-label: 13px` |
| 辅助文字 | 10.5px | `--fs-aux: 12px` |
| 中号按钮高 | 30px | 36px |
| 小号按钮高 | 25px | 30px |
| 主操作按钮高 | 38px | 40px |
| 图标按钮 | 24/30/36 | 28/34/40 |

`styles.css` 里 9–11.5px 的字号已全部替换为 `--fs-aux` / `--fs-label` 令牌
（`Select-String` 复查计数为 0）。

### 7. 时间线轨道与配色

- 七类轨道原本同时展开、片段用高饱和渐变。现在片段底色改为低饱和中性色，
  类别色只出现在左侧 3px 色条与标签圆点上（`TRACK_STYLE`）。
- 高级轨道（运镜 / 遮挡 / 步骤）保持按需展开（原有 `showAdvanced` 逻辑，验证脚本确认 4 → 7）。
- 时间线初始高度 268px → 204px（建议 180–220px），折叠后 40px。

### 8. 状态栏降噪（P2）

旧状态栏常驻显示「原生采集可用 / 示例数据」「版本 N · 片段 · 效果」「内存可用」「默认档位」
「N 个最近工程 · 时间」，还有顶栏的「主进程已连接」。

现在状态栏只显示：保存状态（已保存 / 有未保存修改 / 保存中）、工程时长、
以及真正需要处理时的「可用内存偏低」告警。进程连接、revision、内存、编码能力等
移到设置页（那里本来就有「系统信息」面板）。

## 图标接入

用户确认的白瓷叠帧稿（`wincapture-current-icon.zip`）已接入，未改动图稿本身：

| 位置 | 实现 |
| --- | --- |
| 主窗口 | `electron/main.ts` 的 `appIconPath()` 解析 `dist/assets/app-icon.ico`（开发态回退 `assets/`），传给 `BrowserWindow({ icon })` |
| 悬浮控制条 | 同上 |
| 任务栏分组 | `app.setAppUserModelId('com.huihui.wincapture-studio')` |
| 应用内品牌位 | 左栏 `.rail-logo` 用 `<img src="./app-icon.png">`（34×34，替换原来的「WC」字母块） |
| 页面 favicon | `index.html` 的 `<link rel="icon">` 指向 `public/app-icon.png` |
| 打包 | `scripts/build-main.mjs` 把 ICO 与三档 PNG 复制到 `dist/assets/` |

`verify-icon` 实测：ICO 头 `reserved:0 type:1 count:9`，含 16/20/24/32/40/48/64/128/256 九档；
品牌图 `naturalWidth:128`（真实解码成功，不是碎图）；favicon 指向存在的文件。
截图见 `docs/screenshots/13-brand-icon.png`。

**仍未做（诚实声明）：** EXE 与安装包的图标需要打包工具（如 electron-builder 的
`win.icon`）单独配置，本仓库没有打包配置，因此只完成了运行时窗口图标与界面品牌位。

## 未做与边界

- 属性面板宽度仍固定 304px，未做「可拖动调整 / 窄窗口改抽屉」。
  建议表里这是方向性建议，改动会牵动 InspectorPanel 的布局假设，本次未纳入。
- 预览与导出的一致性没有变化：仍走同一条 `evaluateScene → drawScene`。
- 截图用的是内置示例数据（无 `window.wcs` 时自动进入），因此颜色与布局可信，
  但素材内容不代表真实采集能力——这一点与评审报告的口径一致。

## 悬浮控制条（顺带复核）

录制悬浮窗在 `electron/main.ts` 里是 460×132，用的是紧凑布局。改字号时容易把它挤爆，
所以加了 `verify:overlay` 专门量：控制条 444×40 居中（left 8 / right 452，窗口宽 460），
暂停 / 标记 / 展开备忘录 / 停止四个按钮全部在窗口内（最右 443 ≤ 460），文字未裁切，
按钮高 27px。截图 `docs/screenshots/14-overlay-real460.png`。

验证过程中发现一个脚本层面的坑并已修正：依次「开窗 → 测量 → 销毁」会触发 Electron 默认的
`window-all-closed` 退出逻辑，脚本会在写结果之前就退出（表现为无输出、无 JSON）。
现在脚本显式接管该事件，自己决定退出时机。
