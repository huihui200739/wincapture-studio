# WinCapture Studio 暂用图标

用户已确认先采用白瓷叠帧、卷边与蓝色流光这一版。此前的 C 形、橙色、抽象丝带和简笔显示器方案均不作为当前图标。

## 文件

- `assets/app-icon.png`：已确认图稿的原始 PNG 副本。
- `assets/app-icon.ico`：Windows 图标，包含 16、20、24、32、40、48、64、128、256px 九档尺寸。
- `assets/app-icon-{size}.png`：对应尺寸的 PNG，供界面品牌图、窗口等位置使用。
- `icon-manifest.json`：本地资产选择记录。
- `prompts.txt`：内置 imagegen 的原始设计提示词与边缘清理提示词。

## 应用配置对照

| 位置 | 建议资源 |
| --- | --- |
| Electron 主窗口 `BrowserWindow` 的 `icon` | `assets/app-icon.ico` 的绝对路径 |
| Windows 可执行程序与安装包 | `assets/app-icon.ico`，按项目实际打包工具配置 |
| 应用内品牌图 | `assets/app-icon-64.png` 或 `assets/app-icon-128.png` |

仅设置主窗口图标不会自动修改 EXE 或安装包图标；两处应分别接入。打包时需要将运行时用到的 ICO 一并复制到应用资源目录，并从该目录解析绝对路径。

## 已接入的位置

源码检出已就位，以下位置已经接入（图稿本身未改动）：

| 位置 | 实现 |
| --- | --- |
| 主窗口 / 悬浮条 | `electron/main.ts` 的 `appIconPath()`，优先 `dist/assets/app-icon.ico`，开发态回退 `assets/` |
| 任务栏分组 | `app.setAppUserModelId('com.huihui.wincapture-studio')` |
| 应用内品牌位 | `src/renderer/App.tsx` 左栏 `.rail-logo` 的 `<img>` |
| 页面 favicon | `index.html` + `public/app-icon.png` |
| 构建产物 | `scripts/build-main.mjs` 复制 ICO 与 32/64/128 PNG 到 `dist/assets/` |

**尚未接入**：EXE 与安装包图标需要打包工具配置（electron-builder 的 `win.icon`），
本仓库此前没有打包配置。接入情况见 `assets/icon-manifest.json` 的 `packaging_integration`。

当前工作目录已是应用源码检出，运行时窗口图标、界面品牌位与 favicon 均已接入；
仅 EXE 与安装包图标待打包配置接入。

## 暂用范围

保留用户确认图稿的外观，本次仅复制文件、生成尺寸版本与 ICO 编码，没有重新生成或改变图标设计。原图透明边缘仍有少量杂点，作为暂用稿保留；后续如做正式发布，可在不改变主体造型的前提下继续精修。
