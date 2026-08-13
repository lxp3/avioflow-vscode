# Avioflow Audio Preview

Avioflow Audio Preview 是一款面向 Visual Studio Code 的音频可视化插件。直接在资源管理器中打开音频文件，即可查看元信息、多通道波形并进行播放、定位与缩放。

![Avioflow Audio Preview](https://raw.githubusercontent.com/lxp3/avioflow-vscode/main/resources/image-20260813.gif)

## 功能特性

- **多通道波形**：每个音频通道独立成轨并使用不同颜色，便于观察声道差异。
- **音频元信息**：显示文件大小、容器、通道数、编码、采样率、样本格式、时长和码率。
- **交互式时间轴**：点击或拖动播放位置线可精确定位，水平拖动画布可浏览放大后的波形。
- **自由缩放**：支持鼠标滚轮、缩放按钮和直接输入 `1–50×` 缩放倍数。
- **播放与音量控制**：支持播放、暂停、进度调整和音量调节，播放器时间精确到毫秒。
- **长音频分页**：根据采样率和通道数动态控制单页内存占用，可通过左右按钮切换音频分段。
- **可调轨道高度**：拖动画布底部手柄可同时调整所有通道轨道高度。
- **快速加载**：元信息优先显示，波形数据在 WebAssembly 解码完成后加载。

## 支持格式

插件使用 Avioflow WebAssembly 解码核心，支持当前 WASM 构建提供的音频编码与容器格式，包括：

- MP3、WAV、FLAC、AAC、M4A
- Ogg Vorbis、Opus、WebM、Matroska
- AIFF、APE、WMA、Musepack、WavPack
- AC-3、DSF、Shorten、TAK、TTA
- 多种原始 PCM 格式

实际支持能力由随插件发布的 Avioflow WASM 版本决定。

## 使用方法

1. 在 VS Code 资源管理器中找到音频文件。
2. 单击文件，Avioflow 会作为自定义编辑器打开。
3. 等待波形生成后即可播放、定位、缩放或调整轨道高度。

如果文件没有自动使用 Avioflow 打开，可在文件标签或资源管理器菜单中选择 **Reopen Editor With...**，然后选择 **Avioflow Audio Preview**。

### 常用操作

| 操作 | 功能 |
| --- | --- |
| 空格 | 播放或暂停 |
| 单击波形 | 修改播放位置 |
| 拖动播放位置线 | 连续调整播放进度 |
| 水平拖动画布 | 浏览放大后的波形区域 |
| 鼠标滚轮 | 缩放时间轴 |
| 输入缩放倍数 | 直接设置 `1–50×` 缩放 |
| 拖动画布底部 | 调整通道轨道高度 |
| 左右分段按钮 | 切换长音频的当前解码区间 |

## 工作原理

音频解码由基于 C++、FFmpeg 和 WebAssembly 的 [Avioflow](https://github.com/lxp3/avioflow) 完成。扩展使用 WASM 输出的 PCM samples 构建多级峰值数据，并在 Svelte Webview 中通过 Canvas 绘制波形。

长音频不会一次性把完整 PCM 发送到界面。插件根据内存预算动态划分时间区间，每次只解码和展示当前分段，以降低 WASM、Extension Host 和 Webview 的内存压力。

## 本地开发

环境要求：Node.js 22 或兼容版本，以及 npm。

```bash
npm ci
npm run build
```

在 VS Code 中按 `F5` 启动 Extension Development Host，然后打开音频文件进行调试。

生成 VSIX：

```bash
npm run package
```

安装本地 VSIX：

```bash
code --install-extension avioflow-<version>.vsix
```

## License

本项目使用仓库中 [LICENSE](LICENSE) 所声明的许可证。
