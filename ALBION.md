# 阿尔比恩桌宠

**版本：v1.0.0**

本仓库是 [Project AIRI](https://github.com/moeru-ai/airi) 的 fork，把 Live2D 模型「阿尔比恩」做成桌面宠物。

## 这一版包含的交互

- 触摸与拖动：按模型包自带的 `HitAreas` / `ParamHit` 判定部位，命中走模型坐标系（`hitTest()`），缩放窗口不错位
- 动作：全部取自作者的 `Motions`，`FileLoop` 循环、`NextMtn` 动作链、`Priority` 打断仲裁、`Interruptable` 可打断标记
- 空闲两层同时播放（身体层 + 特效层）
- 显示开关面板：作者的 `PartOpacity` 三组（披帛 / 发壹 / 发贰），面板内切换，选择记在本地
- 托盘：调整大小 → 推荐；对齐到 → 推荐；把当前布局存为推荐
- 语音与会话：本地 Irodori TTS（日语多音色）、paraformer STT、本地对话后端

## 环境

Windows。壳为 Electron 应用，服务由 `start_all.bat` 拉起（开发）或 `start_all_prod.bat`（打包版）。

## 第三方素材

模型、动作数据与语音来自游戏《碧蓝航线》（皮肤「香气来朱阁」）与模型作者，不随本仓库分发，仅供本地使用；
运行时依赖的 Live2D Cubism Core 版权归 Live2D Inc.，适用其专有许可协议。

本 fork 自身的修改沿用上游 MIT 许可。
