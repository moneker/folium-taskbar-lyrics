// mods/taskbar-lyrics/index.cjs
// Main process entry for Taskbar Lyrics Drawer mod.
// Calculates Windows taskbar geometry across multiple displays, manages the drawer overlay window,
// coordinates hover-hide click-through behavior, and bridges playback actions securely.
// Note: Supported exclusively on Windows (win32).

'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen, ipcMain } = require('electron');

const COLLAPSED_WIDTH = 56; // Width of the permanent left replacement button
const VERTICAL_BAR_HEIGHT = 48; // Height of the floating capsule/bar when taskbar is vertical (left/right)
const MAX_PENDING_ACTIONS = 50;
const MENU_IDLE_DESTROY_MS = 10000; // Free menuWindow renderer process after 10s idle (reclaims ~45MB)

const SHELL_WINDOW_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'SecondaryTrayWnd',
  'Windows.UI.Core.CoreWindow',
  'XamlExplorerHostIslandWindow',
  'MultitaskingViewFrame',
  'ForegroundStaging',
  'TaskListThumbnailWnd',
  'NotifyIconOverflowWindow',
]);

let win32Inspector = null;

function getWin32Inspector() {
  if (win32Inspector !== null) return win32Inspector;
  if (process.platform !== 'win32') {
    win32Inspector = false;
    return false;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const RectStruct = koffi.struct({
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long',
    });
    const MonitorInfoStruct = koffi.struct({
      cbSize: 'uint32_t',
      rcMonitor: RectStruct,
      rcWork: RectStruct,
      dwFlags: 'uint32_t',
    });
    win32Inspector = {
      GetForegroundWindow: user32.func('GetForegroundWindow', 'intptr_t', []),
      GetWindowRect: user32.func('GetWindowRect', 'bool', ['intptr_t', koffi.out(koffi.pointer(RectStruct))]),
      GetClassNameW: user32.func('GetClassNameW', 'int', ['intptr_t', koffi.out(koffi.pointer('uint16_t')), 'int']),
      IsWindowVisible: user32.func('IsWindowVisible', 'bool', ['intptr_t']),
      GetWindowLongW: user32.func('GetWindowLongW', 'long', ['intptr_t', 'int']),
      MonitorFromWindow: user32.func('MonitorFromWindow', 'intptr_t', ['intptr_t', 'uint32_t']),
      GetMonitorInfoW: user32.func('GetMonitorInfoW', 'bool', ['intptr_t', koffi.inout(koffi.pointer(MonitorInfoStruct))]),
      SetWindowPos: user32.func('SetWindowPos', 'bool', ['intptr_t', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32_t']),
      monitorInfoSize: koffi.sizeof(MonitorInfoStruct),
      classNameBuf: Buffer.alloc(512),
    };
    return win32Inspector;
  } catch {
    win32Inspector = false;
    return false;
  }
}

function readNativeHwnd(win) {
  try {
    if (!win || win.isDestroyed()) return 0;
    const buf = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(buf)) return 0;
    if (buf.length >= 8) return Number(buf.readBigInt64LE(0));
    if (buf.length >= 4) return buf.readInt32LE(0);
  } catch {}
  return 0;
}

const TASKBAR_SNAPSHOT_KEYS = [
  'song',
  'playerState',
  'isAdvancing',
  'currentTime',
  'duration',
  'lyricOffsetMs',
  'updatedAt',
  'isSeek',
  'lyrics',
  'theme',
  'settings',
  'displayInfo',
];

const MENU_SNAPSHOT_KEYS = [
  'theme',
  'queue',
  'queueTotal',
  'queuePage',
  'queuePageSize',
  'currentIndex',
  'loopMode',
  'volume',
  'isMuted',
  'librarySummary',
  'libraryCategoryData',
  'libraryDetailData',
  'settings',
  'displayInfo',
  'hasPlaybackControls',
];

/**
 * Taskbar Lyrics Mod Main Entry
 * @param {import('../../src/mods/folium/contract').FoliumNodeApi} api
 */
module.exports = function activate(api) {
  // Enforce Windows platform limitation
  if (process.platform !== 'win32') {
    api.log.info('Taskbar Lyrics mod is only supported on Windows (win32). Inactive on this platform.');
    return () => {};
  }

  api.log.info(`Activating Taskbar Lyrics Drawer mod (v${api.manifest.version})`);

  let taskbarWindow = null;
  let menuWindow = null;
  let isEnabled = true;
  let isDrawerExpanded = false;
  let interactionMode = 'standard'; // 'standard' | 'hover-hide'
  let currentDisplayTarget = 'primary'; // 'primary' | 'secondary' | 'wallpaper' | 'display:<idx>'
  let isHoverHidden = false;
  let isFullscreenHidden = false;
  let verticalTaskbarOffsetY = null;

  const pendingActions = [];
  let clientRpcReady = false;
  let collapseTimer = null;
  let hoverWatchTimer = null;
  let menuDestroyTimer = null;
  let lastMenuBlurTime = 0;

  function dispatchClientAction(actionObj) {
    if (!actionObj || !actionObj.action) return;
    if (clientRpcReady && typeof api.rpc?.send === 'function') {
      try {
        api.rpc.send('clientAction', actionObj);
        return;
      } catch {}
    }
    if (pendingActions.length < MAX_PENDING_ACTIONS) {
      pendingActions.push(actionObj);
    }
  }

  let cachedWallpaperDisplayChoice = null;
  let lastWallpaperConfigReadAt = 0;

  /**
   * Reads Folia's configured wallpaper display from userData/config.json if available.
   */
  function readFoliaWallpaperDisplayChoice() {
    const now = Date.now();
    if (now - lastWallpaperConfigReadAt < 2500) {
      return cachedWallpaperDisplayChoice;
    }
    lastWallpaperConfigReadAt = now;
    try {
      if (!app || typeof app.getPath !== 'function') return null;
      const configPath = path.join(app.getPath('userData'), 'config.json');
      if (!fs.existsSync(configPath)) {
        cachedWallpaperDisplayChoice = null;
        return null;
      }
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      cachedWallpaperDisplayChoice = parsed?.wallpaper_display || null;
      return cachedWallpaperDisplayChoice;
    } catch {
      return cachedWallpaperDisplayChoice;
    }
  }

  /**
   * Resolves the target Electron Display object based on user preference.
   * @param {string} [targetChoice]
   */
  function resolveTargetDisplay(targetChoice = currentDisplayTarget) {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const allDisplays = screen.getAllDisplays();
      if (!Array.isArray(allDisplays) || allDisplays.length <= 1) {
        return primaryDisplay;
      }

      const choice = targetChoice || 'primary';
      if (choice === 'primary') {
        return primaryDisplay;
      }

      if (choice === 'secondary') {
        return allDisplays.find((d) => d.id !== primaryDisplay.id) || primaryDisplay;
      }

      if (choice === 'wallpaper') {
        const wp = readFoliaWallpaperDisplayChoice();
        if (wp) {
          if (Number.isInteger(wp.id) && wp.id > 0) {
            const byId = allDisplays.find((d) => d.id === wp.id);
            if (byId) return byId;
          }
          if (wp.bounds) {
            const byBounds = allDisplays.find((d) => (
              d.bounds
              && d.bounds.x === wp.bounds.x
              && d.bounds.y === wp.bounds.y
              && d.bounds.width === wp.bounds.width
              && d.bounds.height === wp.bounds.height
            ));
            if (byBounds) return byBounds;
          }
        }
        return allDisplays.find((d) => d.id !== primaryDisplay.id) || primaryDisplay;
      }

      if (typeof choice === 'string' && choice.startsWith('display:')) {
        const token = choice.slice('display:'.length);
        const idx = parseInt(token, 10);
        if (Number.isInteger(idx) && idx >= 0 && idx < allDisplays.length) {
          return allDisplays[idx];
        }
        const byId = allDisplays.find((d) => String(d.id) === token);
        if (byId) return byId;
      }

      return primaryDisplay;
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  /**
   * Builds a summary of connected displays and the currently active display.
   */
  function buildDisplayInfo() {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const allDisplays = screen.getAllDisplays() || [primaryDisplay];
      const activeDisplay = resolveTargetDisplay();
      const tbBounds = resolveTaskbarBounds(activeDisplay);
      const activeIdx = Math.max(0, allDisplays.findIndex((d) => d.id === activeDisplay.id));
      const isPrimary = activeDisplay.id === primaryDisplay.id;
      const activeLabel = allDisplays.length <= 1
        ? '主屏'
        : (isPrimary ? `主屏 (${activeIdx + 1}/${allDisplays.length})` : `副屏 ${activeIdx + 1} (${activeIdx + 1}/${allDisplays.length})`);

      return {
        target: currentDisplayTarget,
        activeId: activeDisplay.id,
        activeIndex: activeIdx,
        totalDisplays: allDisplays.length,
        isPrimary,
        activeLabel,
        taskbarEdge: tbBounds.edge || 'bottom',
        taskbarOrientation: tbBounds.orientation || 'horizontal',
        displays: allDisplays.map((d, idx) => ({
          id: d.id,
          index: idx,
          isPrimary: d.id === primaryDisplay.id,
          label: d.label || (d.id === primaryDisplay.id ? `主显示器 (${idx + 1})` : `副显示器 (${idx + 1})`),
          bounds: d.bounds,
        })),
      };
    } catch {
      return {
        target: currentDisplayTarget,
        activeId: 0,
        activeIndex: 0,
        totalDisplays: 1,
        isPrimary: true,
        activeLabel: '主屏',
        taskbarEdge: 'bottom',
        taskbarOrientation: 'horizontal',
        displays: [],
      };
    }
  }

  /**
   * Calculates the bounding rectangle of the Windows taskbar on the target display.
   * @param {Electron.Display} [targetDisplay]
   * @returns {{ x: number, y: number, width: number, height: number, edge: 'bottom'|'top'|'left'|'right', orientation: 'horizontal'|'vertical' }}
   */
  function resolveTaskbarBounds(targetDisplay) {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const display = targetDisplay || resolveTargetDisplay();
      const { bounds, workArea } = display;

      // Taskbar at the bottom of the screen (standard Windows configuration)
      if (workArea.y === bounds.y && workArea.height < bounds.height) {
        return {
          x: bounds.x,
          y: bounds.y + workArea.height,
          width: bounds.width,
          height: bounds.height - workArea.height,
          edge: 'bottom',
          orientation: 'horizontal',
        };
      }

      // Taskbar at the top
      if (workArea.y > bounds.y) {
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: workArea.y - bounds.y,
          edge: 'top',
          orientation: 'horizontal',
        };
      }

      // Taskbar on the left
      if (workArea.x > bounds.x) {
        return {
          x: bounds.x,
          y: bounds.y,
          width: workArea.x - bounds.x,
          height: bounds.height,
          edge: 'left',
          orientation: 'vertical',
        };
      }

      // Taskbar on the right
      if (workArea.x === bounds.x && workArea.width < bounds.width) {
        return {
          x: bounds.x + workArea.width,
          y: bounds.y,
          width: bounds.width - workArea.width,
          height: bounds.height,
          edge: 'right',
          orientation: 'vertical',
        };
      }

      // Fallback (e.g., secondary monitor without workArea inset or auto-hide taskbar):
      // Infer taskbar height from primary display if available, otherwise 48px.
      let defaultHeight = 48;
      if (primaryDisplay && primaryDisplay.bounds.height > primaryDisplay.workArea.height) {
        const primaryTbHeight = primaryDisplay.bounds.height - primaryDisplay.workArea.height;
        if (primaryTbHeight >= 32 && primaryTbHeight <= 96) {
          defaultHeight = primaryTbHeight;
        }
      }
      return {
        x: bounds.x,
        y: bounds.y + bounds.height - defaultHeight,
        width: bounds.width,
        height: defaultHeight,
        edge: 'bottom',
        orientation: 'horizontal',
      };
    } catch {
      return { x: 0, y: 0, width: 1920, height: 48, edge: 'bottom', orientation: 'horizontal' };
    }
  }

  /**
   * Resolves the actual BrowserWindow bounds for the drawer in collapsed or expanded state.
   * For vertical taskbars (left/right):
   * - Collapsed: `tb.width × 56px` capsule at the top (or user-dragged Y) so the rest of the taskbar stays clickable.
   * - Expanded: full vertical taskbar (`tb.width × tb.height`) with vertical lyrics layout.
   * @param {boolean} [expanded]
   * @param {Electron.Display} [targetDisplay]
   */
  function resolveDrawerWindowBounds(expanded = isDrawerExpanded, targetDisplay) {
    const display = targetDisplay || resolveTargetDisplay();
    const tb = resolveTaskbarBounds(display);

    if (tb.orientation === 'vertical') {
      if (expanded) {
        return {
          x: tb.x,
          y: tb.y,
          width: tb.width,
          height: tb.height,
          edge: tb.edge,
          orientation: 'vertical',
        };
      }

      const collapsedHeight = COLLAPSED_WIDTH;
      const minY = tb.y;
      const maxY = Math.max(minY, tb.y + tb.height - collapsedHeight);
      const rawY = typeof verticalTaskbarOffsetY === 'number' && Number.isFinite(verticalTaskbarOffsetY)
        ? verticalTaskbarOffsetY
        : tb.y;
      const y = Math.max(minY, Math.min(maxY, Math.round(rawY)));

      return {
        x: tb.x,
        y,
        width: tb.width,
        height: collapsedHeight,
        edge: tb.edge,
        orientation: 'vertical',
      };
    }

    return {
      x: tb.x,
      y: tb.y,
      width: expanded ? tb.width : COLLAPSED_WIDTH,
      height: tb.height,
      edge: tb.edge,
      orientation: 'horizontal',
    };
  }

  let latestTaskbarSnapshot = {
    song: null,
    playerState: 'paused',
    isAdvancing: false,
    currentTime: 0,
    duration: 0,
    lyricOffsetMs: 0,
    updatedAt: Date.now(),
    lyrics: null,
    theme: null,
    settings: {
      showTranslation: true,
      useCoverBackground: true,
      interactionMode: 'standard',
      targetDisplay: 'primary',
    },
    displayInfo: buildDisplayInfo(),
  };

  let latestMenuSnapshot = {
    theme: null,
    queue: [],
    queueTotal: 0,
    queuePage: 0,
    queuePageSize: 50,
    currentIndex: -1,
    loopMode: 'all',
    volume: 100,
    isMuted: false,
    librarySummary: null,
    libraryCategoryData: null,
    libraryDetailData: null,
    settings: latestTaskbarSnapshot.settings,
    displayInfo: latestTaskbarSnapshot.displayInfo,
    hasPlaybackControls: true,
  };

  // Initialize playback snapshot from api.runtime if host has playback running
  try {
    if (api.runtime && typeof api.runtime.getPlaybackSnapshot === 'function') {
      const snap = api.runtime.getPlaybackSnapshot();
      if (snap) {
        latestTaskbarSnapshot = {
          ...latestTaskbarSnapshot,
          song: snap.song ? {
            title: snap.song.title || '未知曲目',
            artist: snap.song.artist || 'Folia',
            coverUrl: null,
          } : null,
          playerState: snap.state || 'paused',
          currentTime: typeof snap.position === 'number' ? snap.position : 0,
          duration: typeof snap.duration === 'number' ? snap.duration : 0,
          theme: snap.theme || null,
          updatedAt: Date.now(),
          lyrics: Array.isArray(snap.lines) && snap.lines.length > 0 ? {
            lines: snap.lines.map((line) => ({
              startTime: line.startTime,
              endTime: line.endTime,
              fullText: line.fullText || line.text || '',
              text: line.text || '',
              translation: line.translation || '',
              words: Array.isArray(line.words) ? line.words.map((w) => ({
                text: w.text,
                startTime: w.startTime,
                endTime: w.endTime,
              })) : null,
            })),
          } : null,
        };
        latestMenuSnapshot = {
          ...latestMenuSnapshot,
          volume: typeof snap.volume === 'number' ? Math.round(snap.volume * 100) : 100,
          isMuted: Boolean(snap.muted),
          loopMode: snap.loopMode || 'all',
          theme: snap.theme || null,
        };
      }
    }
  } catch (err) {
    api.log.warn('Could not read initial playback snapshot from api.runtime', err);
  }

  /**
   * Detects whether a fullscreen application is currently active on the target display.
   * @param {Electron.Display} [targetDisplay]
   * @param {boolean} [wasFullscreen]
   */
  function isTargetDisplayFullscreen(targetDisplay, wasFullscreen = false) {
    try {
      const display = targetDisplay || resolveTargetDisplay();
      if (!display || !display.bounds) return false;

      // 1. Check Electron windows (e.g. Folia itself in fullscreen mode on this display)
      const allWindows = BrowserWindow.getAllWindows();
      for (let i = 0; i < allWindows.length; i++) {
        const w = allWindows[i];
        if (!w || w.isDestroyed() || w === taskbarWindow || w === menuWindow) continue;
        if (w.isVisible() && w.isFullScreen()) {
          try {
            const matched = screen.getDisplayMatching(w.getBounds());
            if (matched && matched.id === display.id) {
              return true;
            }
          } catch {}
        }
      }

      // 2. Check active Win32 foreground window via user32.dll
      const inspector = getWin32Inspector();
      if (!inspector) return false;

      const hwnd = inspector.GetForegroundWindow();
      if (!hwnd) return wasFullscreen;

      if (hwnd === readNativeHwnd(taskbarWindow) || hwnd === readNativeHwnd(menuWindow)) {
        return false;
      }

      if (!inspector.IsWindowVisible(hwnd)) return false;

      const len = inspector.GetClassNameW(hwnd, inspector.classNameBuf, 255);
      const className = len > 0 ? inspector.classNameBuf.toString('utf16le', 0, len * 2) : '';
      if (SHELL_WINDOW_CLASSES.has(className)) return false;

      const rect = { left: 0, top: 0, right: 0, bottom: 0 };
      if (!inspector.GetWindowRect(hwnd, rect)) return false;
      if (rect.right <= rect.left || rect.bottom <= rect.top) return false;

      // Resolve Win32 monitor bounds in the exact same coordinate space as GetWindowRect
      const MONITOR_DEFAULTTONEAREST = 2;
      const fgMon = inspector.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      if (!fgMon) return false;

      const taskbarHwnd = readNativeHwnd(taskbarWindow);
      if (taskbarHwnd) {
        const tbMon = inspector.MonitorFromWindow(taskbarHwnd, MONITOR_DEFAULTTONEAREST);
        if (tbMon && fgMon !== tbMon) {
          return false;
        }
      }

      const mi = { cbSize: inspector.monitorInfoSize };
      if (!inspector.GetMonitorInfoW(fgMon, mi) || !mi.rcMonitor) return false;
      const monRect = mi.rcMonitor;

      const tol = 2;
      const coversDisplay = (
        rect.left <= monRect.left + tol
        && rect.top <= monRect.top + tol
        && rect.right >= monRect.right - tol
        && rect.bottom >= monRect.bottom - tol
      );
      if (!coversDisplay) return false;

      // On auto-hide taskbars (rcWork equals rcMonitor), distinguish a normal maximized window
      // with a title bar (WS_MAXIMIZE | WS_CAPTION) from a true fullscreen window.
      const workRect = mi.rcWork || monRect;
      const isAutoHideTaskbar = (
        workRect.left === monRect.left
        && workRect.top === monRect.top
        && workRect.right === monRect.right
        && workRect.bottom === monRect.bottom
      );
      if (isAutoHideTaskbar) {
        const GWL_STYLE = -16;
        const WS_MAXIMIZE = 0x01000000;
        const WS_CAPTION = 0x00C00000;
        const style = inspector.GetWindowLongW(hwnd, GWL_STYLE);
        if ((style & WS_MAXIMIZE) !== 0 && (style & WS_CAPTION) !== 0) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Hides the taskbar lyrics window (opacity 0 + mouse click-through) while a fullscreen
   * application occupies the target display, and restores interactive Z-order once fullscreen ends.
   */
  function syncFullscreenAvoidance() {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return false;
    const display = resolveTargetDisplay();
    const fullscreenActive = isTargetDisplayFullscreen(display, isFullscreenHidden);
    if (fullscreenActive) {
      if (!isFullscreenHidden) {
        isFullscreenHidden = true;
        closeMenuWindow();
        try {
          taskbarWindow.setIgnoreMouseEvents(true, { forward: true });
        } catch {}
        try {
          taskbarWindow.webContents.send('taskbar-lyrics:hover-hidden', true);
        } catch {}
      }
      return true;
    }

    if (isFullscreenHidden) {
      isFullscreenHidden = false;
      if (!isHoverHidden) {
        try {
          taskbarWindow.setIgnoreMouseEvents(false);
        } catch {}
        try {
          taskbarWindow.webContents.send('taskbar-lyrics:hover-hidden', false);
        } catch {}
      }
      assertTopmost(true);
      setTimeout(() => {
        if (!isFullscreenHidden && !isHoverHidden) {
          assertTopmost(true);
        }
      }, 150);
      setTimeout(() => {
        if (!isFullscreenHidden && !isHoverHidden) {
          assertTopmost(true);
        }
      }, 450);
    }
    return false;
  }

  /**
   * Asserts the window to floating level above Windows taskbar (Shell_TrayWnd).
   * @param {boolean} [forceReset]
   */
  function assertTopmost(forceReset = false) {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return;
    if (isHoverHidden || isFullscreenHidden) return;
    try {
      if (!taskbarWindow.isVisible()) {
        taskbarWindow.showInactive();
      }
      if (forceReset) {
        taskbarWindow.setAlwaysOnTop(false);
        taskbarWindow.setAlwaysOnTop(true, 'screen-saver');
      } else if (!taskbarWindow.isAlwaysOnTop()) {
        taskbarWindow.setAlwaysOnTop(true, 'screen-saver');
      }
      const inspector = getWin32Inspector();
      const hwnd = readNativeHwnd(taskbarWindow);
      if (inspector && hwnd) {
        // HWND_TOPMOST = -1, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE = 0x0013
        inspector.SetWindowPos(hwnd, -1, 0, 0, 0, 0, 0x0013);
      }
      if (typeof taskbarWindow.moveTop === 'function') {
        taskbarWindow.moveTop();
      }
    } catch {
      // Ignored if window is mid-transition or destroying
    }
  }

  /**
   * Checks whether the mouse cursor is currently inside the active drawer window bounds.
   */
  function isCursorInsideTaskbar(margin = 2) {
    try {
      const pt = screen.getCursorScreenPoint();
      const b = resolveDrawerWindowBounds(isDrawerExpanded);
      return (
        pt.x >= b.x - margin
        && pt.x <= b.x + b.width + margin
        && pt.y >= b.y - margin
        && pt.y <= b.y + b.height + margin
      );
    } catch {
      return false;
    }
  }

  /**
   * Activates hover-hide click-through so the user can interact with the native Windows taskbar underneath.
   */
  function enterHoverHide() {
    if (interactionMode !== 'hover-hide' || !isEnabled) return;
    if (!taskbarWindow || taskbarWindow.isDestroyed()) return;

    if (!isHoverHidden) {
      isHoverHidden = true;
      closeMenuWindow();
      try {
        taskbarWindow.setIgnoreMouseEvents(true, { forward: true });
      } catch {}
      try {
        taskbarWindow.webContents.send('taskbar-lyrics:hover-hidden', true);
      } catch {}
    }

    if (!hoverWatchTimer) {
      hoverWatchTimer = setInterval(() => {
        if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled || interactionMode !== 'hover-hide') {
          leaveHoverHide();
          return;
        }
        if (!isCursorInsideTaskbar(4)) {
          leaveHoverHide();
        }
      }, 80);
    }
  }

  /**
   * Restores the taskbar lyrics window once the mouse cursor leaves the taskbar area.
   */
  function leaveHoverHide() {
    if (hoverWatchTimer) {
      clearInterval(hoverWatchTimer);
      hoverWatchTimer = null;
    }
    if (isHoverHidden) {
      isHoverHidden = false;
      if (taskbarWindow && !taskbarWindow.isDestroyed()) {
        try {
          taskbarWindow.setIgnoreMouseEvents(false);
        } catch {}
        try {
          taskbarWindow.webContents.send('taskbar-lyrics:hover-hidden', false);
        } catch {}
        assertTopmost();
      }
    }
  }

  function resolveMenuBounds() {
    const display = resolveTargetDisplay();
    const drawerBounds = resolveDrawerWindowBounds(true, display);
    const dispBounds = display?.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
    const menuWidth = 360;
    const menuHeight = 460;
    const margin = 12;

    if (drawerBounds.orientation === 'vertical') {
      const x = drawerBounds.edge === 'right'
        ? Math.max(dispBounds.x + margin, drawerBounds.x - menuWidth - 8)
        : Math.min(dispBounds.x + dispBounds.width - menuWidth - margin, drawerBounds.x + drawerBounds.width + 8);
      const y = Math.max(
        dispBounds.y + margin,
        Math.min(
          dispBounds.y + dispBounds.height - menuHeight - margin,
          drawerBounds.y + drawerBounds.height - menuHeight - margin,
        ),
      );
      return { x, y, width: menuWidth, height: menuHeight };
    }

    const minX = dispBounds.x + margin;
    const maxX = Math.max(minX, dispBounds.x + dispBounds.width - menuWidth - margin);
    const x = Math.max(minX, Math.min(maxX, drawerBounds.x + drawerBounds.width - menuWidth - margin));

    let y = drawerBounds.y - menuHeight - 8;
    if (y < dispBounds.y + margin) {
      y = Math.min(
        dispBounds.y + dispBounds.height - menuHeight - margin,
        drawerBounds.y + drawerBounds.height + 8,
      );
    }
    return { x, y, width: menuWidth, height: menuHeight };
  }

  /**
   * Applies bounds to the frameless non-resizable taskbar window, opening min/max size constraints
   * first and snapping expanded vertical/horizontal bounds to exact Win32 physical monitor edges.
   * @param {{ x: number, y: number, width: number, height: number, edge?: string, orientation?: string }} winBounds
   */
  function applyTaskbarWindowBounds(winBounds) {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !winBounds) return;
    const target = {
      x: Math.round(winBounds.x),
      y: Math.round(winBounds.y),
      width: Math.max(1, Math.round(winBounds.width)),
      height: Math.max(1, Math.round(winBounds.height)),
    };
    try {
      taskbarWindow.setMinimumSize(1, 1);
      taskbarWindow.setMaximumSize(10000, 10000);
    } catch {}
    taskbarWindow.setBounds(target);

    if (isDrawerExpanded) {
      try {
        const inspector = getWin32Inspector();
        const hwnd = readNativeHwnd(taskbarWindow);
        if (inspector && hwnd) {
          const MONITOR_DEFAULTTONEAREST = 2;
          const hMon = inspector.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
          const mi = { cbSize: inspector.monitorInfoSize };
          if (hMon && inspector.GetMonitorInfoW(hMon, mi) && mi.rcMonitor && mi.rcWork) {
            const mon = mi.rcMonitor;
            const work = mi.rcWork;
            const scaleFactor = resolveTargetDisplay()?.scaleFactor || 1;
            let physX = mon.left;
            let physY = mon.top;
            let physW = mon.right - mon.left;
            let physH = mon.bottom - mon.top;

            if (winBounds.orientation === 'vertical') {
              physY = mon.top;
              physH = mon.bottom - mon.top;
              if (winBounds.edge === 'left') {
                physX = mon.left;
                physW = work.left > mon.left ? (work.left - mon.left) : Math.max(48, Math.round(target.width * scaleFactor));
              } else {
                physW = mon.right > work.right ? (mon.right - work.right) : Math.max(48, Math.round(target.width * scaleFactor));
                physX = mon.right - physW;
              }
            } else if (winBounds.edge === 'top') {
              physX = mon.left;
              physY = mon.top;
              physW = mon.right - mon.left;
              physH = work.top > mon.top ? (work.top - mon.top) : Math.max(40, Math.round(target.height * scaleFactor));
            } else {
              physX = mon.left;
              physW = mon.right - mon.left;
              physH = mon.bottom > work.bottom ? (mon.bottom - work.bottom) : Math.max(40, Math.round(target.height * scaleFactor));
              physY = mon.bottom - physH;
            }

            // HWND_TOPMOST = -1, SWP_NOACTIVATE = 0x0010
            inspector.SetWindowPos(hwnd, -1, physX, physY, physW, physH, 0x0010);
          }
        }
      } catch {}
    }
  }

  function repositionWindowsToActiveDisplay() {
    const display = resolveTargetDisplay();
    const winBounds = resolveDrawerWindowBounds(isDrawerExpanded, display);
    const displayInfo = buildDisplayInfo();
    latestTaskbarSnapshot.displayInfo = displayInfo;
    latestMenuSnapshot.displayInfo = displayInfo;

    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      applyTaskbarWindowBounds(winBounds);
      assertTopmost();
      try {
        taskbarWindow.webContents.send('taskbar-lyrics:snapshot', { displayInfo });
      } catch {}
    }

    if (menuWindow && !menuWindow.isDestroyed()) {
      const menuBounds = resolveMenuBounds();
      menuWindow.setBounds(menuBounds);
      if (menuWindow.isVisible()) {
        try {
          menuWindow.webContents.send('taskbar-lyrics:snapshot', { displayInfo });
        } catch {}
      }
    }
  }

  function cycleTargetDisplay() {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const allDisplays = screen.getAllDisplays() || [primaryDisplay];
      if (allDisplays.length <= 1) {
        currentDisplayTarget = 'primary';
        repositionWindowsToActiveDisplay();
        return buildDisplayInfo();
      }

      const activeDisplay = resolveTargetDisplay();
      const currentIdx = Math.max(0, allDisplays.findIndex((d) => d.id === activeDisplay.id));
      const nextIdx = (currentIdx + 1) % allDisplays.length;
      const nextDisplay = allDisplays[nextIdx];

      if (nextDisplay.id === primaryDisplay.id) {
        currentDisplayTarget = 'primary';
      } else if (allDisplays.length === 2) {
        currentDisplayTarget = 'secondary';
      } else {
        currentDisplayTarget = `display:${nextIdx}`;
      }

      latestTaskbarSnapshot.settings = {
        ...latestTaskbarSnapshot.settings,
        targetDisplay: currentDisplayTarget,
      };
      latestMenuSnapshot.settings = latestTaskbarSnapshot.settings;

      repositionWindowsToActiveDisplay();

      dispatchClientAction({
        action: 'syncDisplayTarget',
        payload: currentDisplayTarget,
      });

      return latestTaskbarSnapshot.displayInfo;
    } catch {
      return buildDisplayInfo();
    }
  }

  function applySettingsUpdate(settings) {
    if (!settings || typeof settings !== 'object') return;

    const nextMode = settings.interactionMode === 'hover-hide' ? 'hover-hide' : 'standard';
    const nextDisplay = typeof settings.targetDisplay === 'string' && settings.targetDisplay
      ? settings.targetDisplay
      : currentDisplayTarget;

    const displayChanged = nextDisplay !== currentDisplayTarget;
    const modeChanged = nextMode !== interactionMode;

    interactionMode = nextMode;
    currentDisplayTarget = nextDisplay;

    if (displayChanged) {
      repositionWindowsToActiveDisplay();
    }

    if (interactionMode === 'hover-hide') {
      if (!isDrawerExpanded) {
        expandDrawer();
      }
      if (isCursorInsideTaskbar(0)) {
        enterHoverHide();
      }
    } else if (modeChanged) {
      leaveHoverHide();
    }
  }

  function clearMenuDestroyTimer() {
    if (menuDestroyTimer) {
      clearTimeout(menuDestroyTimer);
      menuDestroyTimer = null;
    }
  }

  function scheduleMenuIdleDestroy() {
    clearMenuDestroyTimer();
    menuDestroyTimer = setTimeout(() => {
      menuDestroyTimer = null;
      if (menuWindow && !menuWindow.isDestroyed() && !menuWindow.isVisible()) {
        try {
          menuWindow.close();
        } catch {}
        menuWindow = null;
      }
    }, MENU_IDLE_DESTROY_MS);
  }

  function createMenuWindow() {
    clearMenuDestroyTimer();
    if (menuWindow && !menuWindow.isDestroyed()) {
      return menuWindow;
    }

    const bounds = resolveMenuBounds();
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'Folia Taskbar Menu',
      autoHideMenuBar: true,
      resizable: false,
      movable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'view', 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: true,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true);
    }

    win.loadFile(path.join(__dirname, 'view', 'menu.html'));

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        latestMenuSnapshot.displayInfo = buildDisplayInfo();
        win.webContents.send('taskbar-lyrics:snapshot', latestMenuSnapshot);
      }
    });

    win.on('blur', () => {
      lastMenuBlurTime = Date.now();
      closeMenuWindow();
    });

    win.on('closed', () => {
      clearMenuDestroyTimer();
      menuWindow = null;
    });

    menuWindow = win;
    return win;
  }

  function showMenuWindow() {
    clearMenuDestroyTimer();
    if (menuWindow && !menuWindow.isDestroyed()) {
      const bounds = resolveMenuBounds();
      menuWindow.setBounds(bounds);
      menuWindow.show();
      menuWindow.focus();
      latestMenuSnapshot.displayInfo = buildDisplayInfo();
      menuWindow.webContents.send('taskbar-lyrics:snapshot', latestMenuSnapshot);
      return menuWindow;
    }
    return createMenuWindow();
  }

  function toggleMenuWindow() {
    const now = Date.now();
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      closeMenuWindow();
      return;
    }
    // Prevent toggle bounce: if the menu just blurred within 350ms, the toggle click caused the blur.
    if (now - lastMenuBlurTime < 350) {
      return;
    }
    showMenuWindow();
  }

  function closeMenuWindow() {
    const wasVisible = Boolean(menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible());
    const hadCachedLibrary = Boolean(
      latestMenuSnapshot.libraryCategoryData || latestMenuSnapshot.libraryDetailData,
    );

    // Drop cached heavy library lists from main process snapshot when menu closes
    latestMenuSnapshot.libraryCategoryData = null;
    latestMenuSnapshot.libraryDetailData = null;

    if (wasVisible || hadCachedLibrary) {
      dispatchClientAction({ action: 'releaseMenuMemory' });
    }

    if (menuWindow && !menuWindow.isDestroyed()) {
      if (wasVisible) {
        try {
          menuWindow.webContents.send('taskbar-lyrics:menu-closed');
        } catch {}
        menuWindow.hide();
      }
      scheduleMenuIdleDestroy();
    }
  }

  /**
   * Expands the drawer: resizes the window to full taskbar width and animates.
   */
  function expandDrawer() {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return;
    if (isDrawerExpanded) return;

    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }

    isDrawerExpanded = true;
    const winBounds = resolveDrawerWindowBounds(true);
    applyTaskbarWindowBounds(winBounds);

    assertTopmost();
    taskbarWindow.webContents.send('taskbar-lyrics:state', 'expanded');
  }

  /**
   * Collapses the drawer: notifies view to slide out, then resizes back to 56px.
   */
  function collapseDrawer() {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return;
    if (!isDrawerExpanded || interactionMode === 'hover-hide') return;

    closeMenuWindow();
    leaveHoverHide();
    isDrawerExpanded = false;
    taskbarWindow.webContents.send('taskbar-lyrics:state', 'collapsed');

    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      if (taskbarWindow && !taskbarWindow.isDestroyed() && !isDrawerExpanded) {
        const winBounds = resolveDrawerWindowBounds(false);
        applyTaskbarWindowBounds(winBounds);
        assertTopmost();
      }
    }, 420);
  }

  function toggleDrawer() {
    if (isDrawerExpanded) {
      collapseDrawer();
    } else {
      expandDrawer();
    }
  }

  function createWindow() {
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      return taskbarWindow;
    }

    const winBounds = resolveDrawerWindowBounds(isDrawerExpanded);
    const win = new BrowserWindow({
      x: winBounds.x,
      y: winBounds.y,
      width: winBounds.width,
      height: winBounds.height,
      minWidth: 1,
      minHeight: 1,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      title: 'Folia Taskbar Lyrics Drawer',
      autoHideMenuBar: true,
      resizable: false,
      movable: false,
      focusable: true,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'view', 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true);
    }

    win.loadFile(path.join(__dirname, 'view', 'taskbar.html'));

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        applyTaskbarWindowBounds(resolveDrawerWindowBounds(isDrawerExpanded));
        if (!syncFullscreenAvoidance() && isEnabled) {
          assertTopmost();
          win.showInactive();
        }
        win.webContents.send('taskbar-lyrics:state', isDrawerExpanded ? 'expanded' : 'collapsed');
        latestTaskbarSnapshot.displayInfo = buildDisplayInfo();
        win.webContents.send('taskbar-lyrics:snapshot', latestTaskbarSnapshot);
        if (interactionMode === 'hover-hide') {
          if (!isDrawerExpanded) expandDrawer();
          if (isCursorInsideTaskbar(0)) enterHoverHide();
        }
      }
    });

    win.on('minimize', () => {
      if (taskbarWindow && !taskbarWindow.isDestroyed() && isEnabled && !isFullscreenHidden) {
        taskbarWindow.restore();
        assertTopmost();
      }
    });

    win.on('blur', () => {
      if (taskbarWindow && !taskbarWindow.isDestroyed() && isEnabled && !isHoverHidden) {
        if (!syncFullscreenAvoidance()) {
          taskbarWindow.moveTop();
        }
      }
    });

    win.webContents.on('render-process-gone', (_event, details) => {
      api.log.warn(`Taskbar lyrics renderer process gone (${details.reason}), recreating window...`);
      if (taskbarWindow && !taskbarWindow.isDestroyed()) {
        try { taskbarWindow.destroy(); } catch {}
      }
      taskbarWindow = null;
      if (isEnabled) {
        createWindow();
      }
    });

    win.on('unresponsive', () => {
      api.log.warn('Taskbar lyrics window unresponsive, reloading webContents...');
      if (taskbarWindow && !taskbarWindow.isDestroyed()) {
        try { taskbarWindow.webContents.reload(); } catch {}
      }
    });

    win.on('closed', () => {
      taskbarWindow = null;
      clearMenuDestroyTimer();
      if (menuWindow && !menuWindow.isDestroyed()) {
        menuWindow.close();
      }
    });

    taskbarWindow = win;
    return win;
  }

  const isAuthorizedSender = (event) => {
    if (!event || !event.sender) return false;
    const senderId = event.sender.id;
    const taskbarId = taskbarWindow && !taskbarWindow.isDestroyed() ? taskbarWindow.webContents.id : null;
    const menuId = menuWindow && !menuWindow.isDestroyed() ? menuWindow.webContents.id : null;
    return Boolean(senderId && (senderId === taskbarId || senderId === menuId));
  };

  // IPC Event Handlers with Sender Verification
  const onToggleDrawer = (event) => {
    if (isAuthorizedSender(event)) toggleDrawer();
  };
  const onExpandDrawer = (event) => {
    if (isAuthorizedSender(event)) expandDrawer();
  };
  const onCollapseDrawer = (event) => {
    if (isAuthorizedSender(event)) collapseDrawer();
  };
  const onAnimationDone = (event, finalState) => {
    if (!isAuthorizedSender(event)) return;
    if (finalState === 'collapsed' && !isDrawerExpanded) {
      if (taskbarWindow && !taskbarWindow.isDestroyed()) {
        const winBounds = resolveDrawerWindowBounds(false);
        applyTaskbarWindowBounds(winBounds);
        assertTopmost();
      }
    }
  };

  const onPlaybackAction = (event, payload) => {
    if (isAuthorizedSender(event)) {
      dispatchClientAction(payload);
    }
  };

  const onToggleMenu = (event) => {
    if (isAuthorizedSender(event)) toggleMenuWindow();
  };
  const onCloseMenu = (event) => {
    if (isAuthorizedSender(event)) closeMenuWindow();
  };

  const onAssertTop = (event) => {
    if (isAuthorizedSender(event)) assertTopmost();
  };

  const onHoverEnter = (event) => {
    if (isAuthorizedSender(event)) enterHoverHide();
  };

  const onSwitchDisplay = (event) => {
    if (isAuthorizedSender(event)) cycleTargetDisplay();
  };

  const onMoveVertical = (event, targetY) => {
    if (!isAuthorizedSender(event)) return;
    if (typeof targetY !== 'number' || !Number.isFinite(targetY)) return;
    verticalTaskbarOffsetY = Math.round(targetY);
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      const winBounds = resolveDrawerWindowBounds(isDrawerExpanded);
      if (winBounds.orientation === 'vertical') {
        taskbarWindow.setBounds({
          x: winBounds.x,
          y: winBounds.y,
          width: winBounds.width,
          height: winBounds.height,
        });
        if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
          menuWindow.setBounds(resolveMenuBounds());
        }
      }
    }
  };

  ipcMain.on('taskbar-lyrics:toggle', onToggleDrawer);
  ipcMain.on('taskbar-lyrics:expand', onExpandDrawer);
  ipcMain.on('taskbar-lyrics:collapse', onCollapseDrawer);
  ipcMain.on('taskbar-lyrics:animation-done', onAnimationDone);
  ipcMain.on('taskbar-lyrics:playback-action', onPlaybackAction);
  ipcMain.on('taskbar-lyrics:toggle-menu', onToggleMenu);
  ipcMain.on('taskbar-lyrics:close-menu', onCloseMenu);
  ipcMain.on('taskbar-lyrics:assert-top', onAssertTop);
  ipcMain.on('taskbar-lyrics:hover-enter', onHoverEnter);
  ipcMain.on('taskbar-lyrics:switch-display', onSwitchDisplay);
  ipcMain.on('taskbar-lyrics:move-vertical', onMoveVertical);

  // Screen metrics & hotplug listeners
  const onDisplayChanged = () => {
    repositionWindowsToActiveDisplay();
  };
  screen.on('display-metrics-changed', onDisplayChanged);
  screen.on('display-added', onDisplayChanged);
  screen.on('display-removed', onDisplayChanged);

  // Register RPC for renderer client (`client.mjs`)
  api.rpc.handle('syncSnapshot', (snapshot) => {
    clientRpcReady = true;
    if (!snapshot || typeof snapshot !== 'object') return false;

    if (snapshot.settings) {
      applySettingsUpdate(snapshot.settings);
    }

    const taskbarDelta = {};
    let hasTaskbarDelta = false;
    for (let i = 0; i < TASKBAR_SNAPSHOT_KEYS.length; i++) {
      const k = TASKBAR_SNAPSHOT_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(snapshot, k)) {
        taskbarDelta[k] = snapshot[k];
        hasTaskbarDelta = true;
      }
    }

    if (hasTaskbarDelta) {
      latestTaskbarSnapshot = {
        ...latestTaskbarSnapshot,
        ...taskbarDelta,
        isSeek: false,
      };
      if (taskbarWindow && !taskbarWindow.isDestroyed()) {
        taskbarWindow.webContents.send('taskbar-lyrics:snapshot', taskbarDelta);
      }
    }

    const menuDelta = {};
    let hasMenuDelta = false;
    const isMenuVisible = Boolean(menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible());
    for (let i = 0; i < MENU_SNAPSHOT_KEYS.length; i++) {
      const k = MENU_SNAPSHOT_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(snapshot, k)) {
        // Avoid retaining large category/detail song arrays in main process when menu is hidden
        if (!isMenuVisible && (k === 'libraryCategoryData' || k === 'libraryDetailData')) {
          continue;
        }
        menuDelta[k] = snapshot[k];
        hasMenuDelta = true;
      }
    }

    if (hasMenuDelta) {
      latestMenuSnapshot = { ...latestMenuSnapshot, ...menuDelta };
      if (isMenuVisible) {
        menuWindow.webContents.send('taskbar-lyrics:snapshot', menuDelta);
      }
    }

    return true;
  });

  api.rpc.handle('drainActions', () => {
    if (pendingActions.length === 0) return [];
    return pendingActions.splice(0, pendingActions.length);
  });

  api.rpc.handle('getDisplayInfo', () => buildDisplayInfo());
  api.rpc.handle('switchDisplay', () => cycleTargetDisplay());
  api.rpc.handle('toggleDrawer', () => toggleDrawer());
  api.rpc.handle('expandDrawer', () => expandDrawer());
  api.rpc.handle('collapseDrawer', () => collapseDrawer());
  api.rpc.handle('getStatus', () => ({
    isOpen: Boolean(taskbarWindow && !taskbarWindow.isDestroyed()),
    isEnabled,
    isExpanded: isDrawerExpanded,
    interactionMode,
    displayInfo: buildDisplayInfo(),
  }));

  // Initialize the taskbar window
  createWindow();

  // Active Z-order & fullscreen avoidance watchdog for Windows
  const topmostKeepAliveTimer = setInterval(() => {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return;
    if (currentDisplayTarget === 'wallpaper') {
      const targetDisplay = resolveTargetDisplay();
      if (targetDisplay && targetDisplay.id !== latestTaskbarSnapshot.displayInfo?.activeId) {
        repositionWindowsToActiveDisplay();
      }
    }
    if (syncFullscreenAvoidance()) {
      return;
    }
    if (interactionMode === 'hover-hide') {
      if (!isHoverHidden && isCursorInsideTaskbar(0)) {
        enterHoverHide();
        return;
      }
      if (isHoverHidden) {
        return;
      }
    }
    assertTopmost();
  }, 600);

  // Lifecycle teardown
  const onDispose = () => {
    api.log.info('Deactivating Taskbar Lyrics Drawer mod');
    if (topmostKeepAliveTimer) clearInterval(topmostKeepAliveTimer);
    if (collapseTimer) clearTimeout(collapseTimer);
    if (hoverWatchTimer) clearInterval(hoverWatchTimer);
    clearMenuDestroyTimer();

    screen.removeListener('display-metrics-changed', onDisplayChanged);
    screen.removeListener('display-added', onDisplayChanged);
    screen.removeListener('display-removed', onDisplayChanged);

    ipcMain.removeListener('taskbar-lyrics:toggle', onToggleDrawer);
    ipcMain.removeListener('taskbar-lyrics:expand', onExpandDrawer);
    ipcMain.removeListener('taskbar-lyrics:collapse', onCollapseDrawer);
    ipcMain.removeListener('taskbar-lyrics:animation-done', onAnimationDone);
    ipcMain.removeListener('taskbar-lyrics:playback-action', onPlaybackAction);
    ipcMain.removeListener('taskbar-lyrics:toggle-menu', onToggleMenu);
    ipcMain.removeListener('taskbar-lyrics:close-menu', onCloseMenu);
    ipcMain.removeListener('taskbar-lyrics:assert-top', onAssertTop);
    ipcMain.removeListener('taskbar-lyrics:hover-enter', onHoverEnter);
    ipcMain.removeListener('taskbar-lyrics:switch-display', onSwitchDisplay);
    ipcMain.removeListener('taskbar-lyrics:move-vertical', onMoveVertical);

    if (menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.close();
      menuWindow = null;
    }

    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      taskbarWindow.close();
      taskbarWindow = null;
    }
  };

  return onDispose;
};
