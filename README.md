# 任务栏抽屉歌词 (Taskbar Lyrics Mod for Folia)

> 为 Windows 任务栏打造的沉浸式抽屉替换动态歌词模组（仅支持 Windows 平台）。基于 Folia / Folium 模组体系开发。

### 抽屉展开状态（完全覆盖任务栏、流体背景与快捷控制弹窗）
![抽屉展开演示](preview.png)

### 抽屉收起状态（最左侧常驻微型抽屉替换开关）
![抽屉收起演示](preview-collapsed.png)

## 特性

- **抽屉式无缝替换**：在 Windows 任务栏最左侧提供常驻微型抽屉开关，点击后歌词栏从右向左覆盖任务栏，再次点击顺畅收回，彻底告别传统悬浮歌词遮挡工作区或误触穿透的问题。
- **点击任务栏不沉降**：采用原生 Windows 任务栏层级置顶守护，点击任务栏任意空白区域或切换应用，开关与抽屉绝不沉底或消失。
- **高保真流体封面背景**：高度复刻 Folia 官方歌词舞台质感，根据当前播放歌曲封面生成高斯模糊流体动态亚克力背景。
- **逐字平滑卡拉OK过渡**：支持 TTML / 逐字时间戳双行歌词（原文 + 翻译），字词级动态渐变扫光推进，智能处理中英西文间距。
- **常驻弹窗快捷控制面板**：右侧集成快捷功能弹窗，支持切歌、播放列表滚轮滚动直接点播、一键打开系统音量调节面板与随机换歌。

## 平台与兼容性

- **运行平台**：Windows 10 / 11（win32）
- **宿主版本要求**：Folia `>=0.7.20 <0.8.0`（基于 Folium 1.5 标准接口）

## 安装方式

1. 下载模组发布包 `taskbar-lyrics.zip`；
2. 打开 Folia，进入左侧导航栏的「模组」面板；
3. 将 zip 压缩包直接拖入模组页面即可自动完成原子化安全安装，确认启用即可生效。

## 权限声明

- `runtime.playback`: 主进程在模组激活初始化时尝试通过 `api.runtime.getPlaybackSnapshot()` 读取当前音轨元数据与状态（在重载或热重启时快速恢复当前进度与歌词）；冷启动渲染端尚未推送时安全回退并等待事件。
- `playback.control`: 抽屉按键与快捷菜单控制播放/暂停、上一曲/下一曲、进度拖拽、设置音量/静音（`setVolume` / `setMuted`）、切换循环模式（`setLoopMode`）、打乱队列（`shuffleQueue`）与通过 `folium.playback.playQueueItem(index, ref)` 点播队列曲目。

## 内部接口（Internals）使用声明

由于使用 `folium.internals` 的模块没有跨大版本的兼容承诺，本模组在 `mod.json` 中将宿主版本严格锁定在 `"folia": ">=0.7.20 <0.8.0"`。

模组仅在以下位置受控读取 `stores.playback`：
1. **专辑封面 URL**：读取 `state.transitionDisplay?.coverUrl`、`state.cachedCoverUrl`、`state.currentSong?.album?.coverUrl`、`state.currentSong?.coverUrl`、`state.currentSong?.picUrl`（供抽屉生成流体毛玻璃亚克力背景）；
2. **歌词时间轴偏移**：读取 `state.lyricTimelineOffsetMs`（用于对齐用户在 Folia 界面手动调节的歌词时延）；
3. **状态变动订阅**：通过 `folium.internals.stores.playback.subscribe` 仅在上述字段变动时向任务栏窗口推送增量快照。

所有播放控制（播放、暂停、切歌、seek）、音量与静音（`getVolume` / `setVolume` / `setMuted`）、循环模式（`getLoopMode` / `setLoopMode`）、打乱队列（`shuffleQueue`）及队列获取与点播（`getQueue` / `playQueueItem`）均 100% 采用 Folium 1.5 官方标准接口，不包含任何对私有 store 的回退反射，也不读写任何 localStorage 键。

## 运行时与性能说明

- **轻量置顶守护**：Windows 任务栏 Z-order 守护采用 1000ms 轻量级层级保活（仅调用原生层级调整，单次耗时 < 0.05ms），并配合鼠标移入交互即时提升，确保抽屉开关稳定覆盖在系统任务栏上层，空闲与后台时对电池和 CPU 消耗极低。
- **定时同步与排空**：渲染端常驻定时器每 250ms 调用一次 `folium.playback.getState()` 同步播放进度差值，并排空 `drainActions` 用户操作队列；曲目、播放状态、音量、循环模式及队列刷新则完全由 `playback.*Changed` 事件驱动推送。
- **音量设置合并**：拖动滑块时仅实时更新本地显示数值，在松手（`change`）时才向宿主触发 `setVolume` 避免高频落盘；滚轮调节配备 150ms 防抖合并。
- **流体封面合成器图层**：亚克力流体背景使用 CSS 合成器层渲染，播放暂停时零多余重绘，对轻薄本与电池设备友好。

## 许可证

[MIT License](LICENSE)
