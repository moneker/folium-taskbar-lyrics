# 任务栏抽屉歌词 (Taskbar Lyrics Mod for Folia)

> 为 Windows 任务栏量身定制的沉浸式抽屉替换动态歌词模组（仅支持 Windows 平台）。基于 Folia / Folium 2.1 公开接口规范开发。

### 抽屉展开状态（完全覆盖任务栏、流体封面背景与四标签快捷控制弹窗）
![抽屉展开演示](preview.png)

### 抽屉收起状态（最左侧常驻透明微光抽屉替换开关）
![抽屉收起演示](preview-collapsed.png)

---

## 核心特性

- **抽屉式无缝替换与悬停避让**：
  - **常规交互模式**：在 Windows 任务栏最左侧提供常驻透明微光抽屉开关（默认透明融入任务栏，鼠标悬停时胶囊边缘与图标柔和透光），点击后歌词栏从右向左顺滑覆盖整段任务栏，支持直接点击控制、红心点赞与拖拽进度。
  - **鼠标悬停自动隐藏（Hover 隐藏）**：可在模组设置中开启，鼠标移入任务栏区域时歌词抽屉自动隐藏并穿透点击到底层原生 Windows 任务栏，鼠标移出任务栏后自动恢复显示。
- **多显示器切换、竖排任务栏与纯 Electron 置顶守护**：支持在主显示器、副显示器、指定编号显示器之间切换，快捷控制菜单底部支持一键切屏；完全采用 Electron 原生 `screen` 与 `BrowserWindow` 接口（`screen-saver` 层级 + 失焦短延迟重提）完成任务栏定位、置顶保活与 Folia 全屏窗口避让，不借用任何宿主私有原生模块。
- **高保真流体封面背景与任务栏红心**：深度复刻 Folia 官方歌词舞台质感，通过 `folium.omni.describeSong()` 同步读取当前曲目封面并实时生成高斯模糊流体亚克力背景；控制区内置同步宿主的红心点赞按钮（`folium.playback.toggleLike()`）。
- **逐字平滑卡拉OK过渡、时间轴偏移微调与后台防抖**：支持 TTML / 逐字时间戳双行歌词（原文 + 翻译）与 `FoliumLine.renderHints.renderEndTime` 行尾保持提示；支持在模组设置中配置全局歌词偏移（ms，补偿蓝牙等输出延迟）并在弹窗底部按单曲快捷微调 `±200ms`（自动记住单曲偏移并与全局偏移叠加）；内置单调时间推进与缓冲冻结保护，即使 Folia 最小化在后台、长时间暂停恢复或网络加载中，进度条与逐字扫光依然精准同步。
- **四标签快捷控制面板（100% 公开接口）**：
  - **队列**：分页查看当前播放队列（每页 50 首），支持一键定位正在播放曲目、单击点播（带 `expectedRef` 校验）、行内快速收藏与一键打乱顺序。
  - **搜索**：通过 `folium.omni.searchSongs()` 与 `listProviders()` 在弹窗内切换已配置音源直接搜歌，支持单击立即播放、加入播放队列、加入任务栏收藏与游标翻页。
  - **探索**：通过 `folium.omni.getAlbum()` / `getArtists()` / `getTracks()` / `getArtistAlbums()` 浏览当前播放曲目所属专辑的全部曲目、歌手热门歌曲与歌手专辑，支持单曲点播或整张专辑替换播放队列。
  - **收藏**：基于模组自有存储（`folium.storage`）自动记录「最近播放」并维护跨平台「快捷收藏夹」（仅保存可移植键 `{ source, id }`，播放时通过 `folium.omni.resolveSongs()` 还原），支持一键收藏当前曲目与整表播放。

---

## 平台与兼容性

- **运行平台**：Windows 10 / 11（win32）
- **宿主版本要求**：Folia `>=0.8.0`（严格遵循 **Folium 2.1** 正式发布公开接口规范）

---

## 安装方式

1. 直接在 Folia「设置 → 模组」市场内一键安装，或下载模组发布包 `taskbar-lyrics.zip`；
2. 若手动安装压缩包，打开 Folia 进入「设置 → 模组」，将 zip 压缩包拖入模组页面完成安装并启用即可生效。

---

## 权限声明

本模组严格遵循最小权限原则，仅声明运行所需的四项官方权限：

- `playback.read`：用于在主进程启动时经 `api.runtime.getPlaybackSnapshot()` 读取当前播放曲目、播放进度快照、歌词与主题初始状态。
- `playback.control`：用于抽屉按键与快捷菜单控制播放/暂停、上一曲/下一曲、进度拖拽（Seek）、红心点赞（`toggleLike`）、音量与静音调节、循环模式切换、队列打乱、队列点播（`playQueueItem`）以及在线搜歌点播/入队（`playSong` / `enqueue`）。
- `playback.queue`：用于在「探索」专辑/歌手页或「收藏」列表点击「播放全部」时，经官方 `folium.playback.replaceQueue()` 整表替换播放队列（支持宿主撤销并自动退出私人 FM）。
- `filesystem.data`：用于经官方 `folium.storage` 在本模组专属数据文件中持久化「最近播放」、「快捷收藏夹」曲目键列表以及任务栏单曲歌词时间轴偏移（不读写宿主或其他模组的任何文件）。

> 注：本模组还会使用无需额外权限的 `folium.omni` 公开目录接口（`listProviders`、`searchSongs`、`resolveSongs`、`describeSong`、`getAlbum`、`getArtists`、`resolveCollection`、`getTracks`、`getArtistAlbums`），以你在 Folia 中登录的在线音源账号发起公开搜索与专辑/歌手查询，不读取账号私有库也不上传任何数据。

---

## 官方 API 覆盖与接口边界说明

本模组完全基于 Folium 2.1 公开契约实现（零 `folium.internals`、零宿主 `IndexedDB` 直读、零宿主私有原生模块 `koffi`、零宿主 `localStorage`、零宿主 `config.json` 与窗口私有属性访问），并经 `npm run folium:check mods/taskbar-lyrics` 静态检查通过：

- **实时主题与字体**：通过 `folium.theme.getCurrent()`、`theme.changed`、`folium.theme.resolveFontStack()` 与 `folium.theme.resolveTranslationFontStack()` 同步屏幕主题与正副行字体栈。
- **播放状态、红心与队列控制**：通过 `folium.playback.getState()` / `getQueue()` / `playQueueItem()` / `playSong()` / `enqueue()` / `replaceQueue()` / `shuffleQueue()` / `toggleLike()` / `getVolume()` / `setVolume()` / `setMuted()` / `getLoopMode()` / `setLoopMode()`，配合 `playback.*` 事件驱动。
- **实时歌词**：通过 `folium.lyrics.getLines()`、`folium.lyrics.getLineRenderEndTime()` 与 `lyrics.loaded` 事件同步逐字歌词与行尾保持时间。
- **公开在线目录与自有存储**：通过 `folium.omni` 实现切音源搜歌、当前曲目专辑/歌手浏览与曲目解析；通过 `folium.storage` 存储模组自有的最近播放与快捷收藏。
- **全局快捷键与命令面板**：向 `folium.registries.commands` 注册支持 `globalShortcut: true` 的「展开/收起任务栏歌词」、「切换任务栏歌词显示器」与「显示/隐藏任务栏歌词正文」命令，由宿主统一管理热键绑定（外部程序全屏时可一键收起，听无标准歌词的二创音频时可一键仅展示歌名与作者）。
- **尚未开放公开接口的功能说明**：账号个人歌单、私人 FM、宿主本地曲库、宿主主界面歌词偏移同步及外部进程全屏检测目前尚不在 Folium 2.1 公开接口范围内（其中歌词偏移已提供模组自有的全局设置 + 单曲微调替代），待后续宿主开放公开接口后再接入。

---

## 更新日志 (Changelog)

### v1.0.9
- **全面对齐 Folium 2.1 正式发布审查规范，移除全部宿主私有依赖，并以公开接口补齐弹窗与任务栏功能**：
  - 移除 `client.mjs` 中所有 `folium.internals` 访问、宿主 IndexedDB（`FoliaPlaylistsDB` / `KineticPlayerDB`）直读与宿主 `localStorage` 旧版回退；
  - 移除 `index.cjs` 中 `koffi` / `user32.dll` 加载、宿主 `<userData>/config.json` 读取与 `win.__wallpaperGeometry` 私有窗口属性依赖，统一使用纯 Electron `screen` 与 `BrowserWindow` 接口实现多屏定位、置顶重提（`screen-saver` 层级 + 失焦短延迟补提）、Folia 全屏避让与主窗口退出自动回收；
  - 修复全屏避让与悬停隐藏状态机冲突、静音状态下调音量未同步清 `isMuted` 导致滑块回弹、暂停态异步时长就绪未推送、无歌词态舞台居中与暗灰显示、以及抽屉收起动画帧循环提前中断等问题；
  - **新增 4 项 100% 公开接口功能**：
    1. **任务栏红心点赞按钮**（`folium.playback.toggleLike()` + `playback.likeChanged`）；
    2. **在线搜歌与音源切换**（`folium.omni.searchSongs()` + `listProviders()`，支持点播、入队与翻页）；
    3. **当前曲目专辑 / 歌手浏览**（`folium.omni.getAlbum()` / `getArtists()` / `getTracks()` / `getArtistAlbums()` + `replaceQueue()` 整表播放）；
    4. **模组自有「最近播放」与「快捷收藏夹」**（`folium.storage` + `folium.omni.resolveSongs()` 跨平台还原点播）；
    5. **模组自有歌词时间轴偏移与歌词显隐开关**：支持设置页全局 `ms` 偏移 + 弹窗底部单曲 `±0.2s` 快捷微调/重置（按曲目持久化于 `folium.storage` 并与全局偏移叠加生效）；新增歌词显示开关（弹窗底部眼睛图标按钮、设置页 `showLyrics` 开关与 `toggle-lyrics` 全局热键命令，隐藏时中央静态展示歌名与作者）；
  - 重构播放时钟同步逻辑与弹窗字体/对比度：修复变量名拼写导致后续进度锚点停推、暂停后恢复播放进度条跳变、在线歌曲长时间加载或缓冲卡顿时进度条偷跑、暂停/播放态小幅回拖不同步，以及弹窗按钮因混用日文/非标字重导致的字形异常。

### v1.0.8
- **适配 Folia 0.8.0 与 Folium 2.1 规范及交互视觉优化**：
  - 清单升级为 `"folium": 2`、`"folia": ">=0.8.0"`，新增 `"contexts": ["main"]` 避免导出窗口加载 `client.mjs`；
  - 重构最左侧常驻抽屉开关按钮视觉逻辑：展开与收起状态下默认背景完全透明、无突兀底色边框，鼠标移入悬停时胶囊边缘与音律/箭头图案同步呈现柔和透光效果；
  - 接入官方 `playback.failed`、`FoliumLine.renderHints.renderEndTime` 与 `folium.theme.resolveTranslationFontStack()`；
  - 修复 Folium `2.x` 下 `folium.host.folium.minor` 重置为 `1` 导致能力检测失效的问题。

### v1.0.7
- **对齐 Folium 1.7–1.10 官方接口**：接入 `folium.theme.getCurrent()`、`folium.lyrics.getLines()`、`globalShortcut: true` 全局快捷键命令、双向 RPC 推送及竖屏任务栏适配。

### v1.0.6 (2026-11-04)
- **新增 Hover 隐藏模式与多显示器切换**，优化切歌/Seek 与后台歌词单调时间防抖及内存占用。

### v1.0.0 – v1.0.5 (2026-10-14 – 2026-10-18)
- 初始正式版本发布及基础播放器同步、分页列表与音量/循环模式控制迭代。

---

## 运行时与性能说明

- **轻量置顶守护**：基于 Electron `BrowserWindow` 失焦短延迟补提与 600ms 定时保活，空闲时 CPU 与电量占用极低。
- **定时同步与推送**：渲染端常驻定时器每 200ms 校验播放时钟锚点，操作调度走 `folium.rpc.on` / `api.rpc.send` 双向推送；所有 `folium.omni` 异步查询均绑定 `AbortController` 在切词或停用时及时中止。
- **音量设置合并**：拖动滑块时仅实时更新本地显示数值，在松手（`change`）时才向宿主触发 `setVolume`；滚轮调节配备 120ms 防抖合并。
- **合成器图层渲染**：亚克力流体背景使用 CSS 合成器层渲染，播放暂停时零多余重绘。

---

## 许可证

[MIT License](LICENSE)
