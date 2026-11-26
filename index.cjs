// mods/taskbar-lyrics/index.cjs
// Main process entry for Taskbar Lyrics Drawer mod.
// Uses standard Electron screen and BrowserWindow APIs to calculate Windows taskbar geometry across displays,
// manage the overlay drawer and floating control menu windows, guard topmost stacking, and follow host lifecycle.
// Note: Supported exclusively on Windows (win32).

'use strict';

const path = require('path');
const { app, BrowserWindow, screen, ipcMain } = require('electron');

const COLLAPSED_WIDTH = 56; // Width of the permanent left replacement button
const MAX_PENDING_ACTIONS = 50;
const MENU_IDLE_DESTROY_MS = 10000; // Free menuWindow renderer process after 10s idle

const TASKBAR_SNAPSHOT_KEYS = [
  'song',
  'playerState',
  'isAdvancing',
  'currentTime',
  'duration',
  'updatedAt',
  'isSeek',
  'lyrics',
  'lyricsVisible',
  'lyricOffsetMs',
  'liked',
  'canLike',
  'theme',
  'settings',
  'displayInfo',
];

const MENU_SNAPSHOT_KEYS = [
  'song',
  'theme',
  'queue',
  'queueTotal',
  'queuePage',
  'queuePageSize',
  'currentIndex',
  'loopMode',
  'volume',
  'isMuted',
  'lyricsVisible',
  'lyricOffsetMs',
  'songLyricOffsetMs',
  'globalLyricOffsetMs',
  'settings',
  'displayInfo',
  'hasPlaybackControls',
  'providers',
  'searchState',
  'exploreData',
  'savedTracks',
  'recentTracks',
];

function normalizeRuntimeTheme(theme) {
  if (!theme || typeof theme !== 'object') return null;
  const resolvedFont = (Array.isArray(theme.fontFamilyStack) && theme.fontFamilyStack.length > 0
    ? theme.fontFamilyStack.join(', ')
    : undefined) || theme.fontFamily;
  return {
    name: theme.name || 'Folia Theme',
    backgroundColor: theme.backgroundColor,
    primaryColor: theme.primaryColor,
    accentColor: theme.accentColor,
    secondaryColor: theme.secondaryColor,
    fontFamily: resolvedFont,
    fontStyle: theme.fontStyle || 'sans',
    isDaylight: Boolean(theme.isDaylight),
  };
}

/**
 * Taskbar Lyrics Mod Main Entry
 * @param {import('../folium').FoliumMainApi} api
 */
module.exports = function activate(api) {
  if (process.platform !== 'win32') {
    api.log.info('Taskbar Lyrics mod is only supported on Windows (win32). Inactive on this platform.');
    return () => {};
  }

  api.log.info(`Activating Taskbar Lyrics mod (v${api.manifest.version})`);

  let isDisposed = false;
  let isQuitting = false;
  let startupWindowTimer = null;
  let taskbarWindow = null;
  let menuWindow = null;
  let isDrawerExpanded = false;
  let interactionMode = 'standard'; // 'standard' | 'hover-hide'
  let currentDisplayTarget = 'primary'; // 'primary' | 'secondary' | 'display:<idx>'
  let isHoverHidden = false;
  let isFullscreenHidden = false;
  let lastSentWindowHidden = null;

  const pendingActions = [];
  let clientRpcReady = false;
  let collapseTimer = null;
  let hoverWatchTimer = null;
  let menuDestroyTimer = null;
  let hostCloseCheckTimer = null;
  let isCreatingOwnedWindow = false;
  const topmostRetryTimers = new Set();
  const seenVisibleHostWindows = new Set();
  const watchedHostCleanups = new Map();
  let lastMenuBlurTime = 0;

  function normalizeDisplayTarget(choice) {
    if (typeof choice !== 'string' || !choice) return 'primary';
    if (choice === 'wallpaper') return 'secondary';
    if (choice === 'primary' || choice === 'secondary' || choice.startsWith('display:')) {
      return choice;
    }
    return 'primary';
  }

  function dispatchClientAction(actionObj) {
    if (!actionObj || !actionObj.action || isDisposed || isQuitting) return;
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

  /**
   * Resolves the target Electron Display object strictly via Electron screen APIs.
   * @param {string} [targetChoice]
   */
  function resolveTargetDisplay(targetChoice = currentDisplayTarget) {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const allDisplays = screen.getAllDisplays();
      if (!Array.isArray(allDisplays) || allDisplays.length <= 1) {
        return primaryDisplay;
      }

      const choice = normalizeDisplayTarget(targetChoice);
      if (choice === 'primary') {
        return primaryDisplay;
      }

      if (choice === 'secondary') {
        return allDisplays.find((d) => d.id !== primaryDisplay.id) || primaryDisplay;
      }

      if (choice.startsWith('display:')) {
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
   */
  function resolveTaskbarBounds(targetDisplay) {
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      const display = targetDisplay || resolveTargetDisplay();
      const { bounds, workArea } = display;

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
   * Resolves the BrowserWindow bounds for the drawer in collapsed or expanded state.
   * @param {boolean} [expanded]
   * @param {Electron.Display} [targetDisplay]
   */
  function resolveDrawerWindowBounds(expanded = isDrawerExpanded, targetDisplay) {
    const display = targetDisplay || resolveTargetDisplay();
    const tb = resolveTaskbarBounds(display);

    if (tb.orientation === 'vertical') {
      return {
        x: tb.x,
        y: tb.y,
        width: tb.width,
        height: expanded ? tb.height : COLLAPSED_WIDTH,
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
    updatedAt: Date.now(),
    lyrics: null,
    lyricsVisible: true,
    lyricOffsetMs: 0,
    liked: false,
    canLike: false,
    theme: null,
    settings: {
      showLyrics: true,
      showTranslation: true,
      useCoverBackground: true,
      interactionMode: 'standard',
      targetDisplay: 'primary',
      globalLyricOffsetMs: 0,
    },
    displayInfo: buildDisplayInfo(),
  };

  let latestMenuSnapshot = {
    song: null,
    theme: null,
    queue: [],
    queueTotal: 0,
    queuePage: 0,
    queuePageSize: 50,
    currentIndex: -1,
    loopMode: 'all',
    volume: 100,
    isMuted: false,
    lyricsVisible: true,
    lyricOffsetMs: 0,
    songLyricOffsetMs: 0,
    globalLyricOffsetMs: 0,
    settings: latestTaskbarSnapshot.settings,
    displayInfo: latestTaskbarSnapshot.displayInfo,
    hasPlaybackControls: true,
    providers: [],
    searchState: null,
    exploreData: null,
    savedTracks: [],
    recentTracks: [],
  };

  // Initialize playback snapshot from api.runtime if host has playback running
  try {
    if (api.runtime && typeof api.runtime.getPlaybackSnapshot === 'function') {
      const snap = api.runtime.getPlaybackSnapshot();
      if (snap) {
        const initialTheme = normalizeRuntimeTheme(snap.theme);
        const initialSong = snap.song ? {
          id: snap.song.id ?? null,
          source: snap.song.source ?? null,
          title: snap.song.title || '未知曲目',
          artist: snap.song.artist || 'Folia',
          album: snap.song.album ?? null,
          coverUrl: null,
        } : null;
        latestTaskbarSnapshot = {
          ...latestTaskbarSnapshot,
          song: initialSong,
          playerState: snap.state || 'paused',
          currentTime: typeof snap.position === 'number' ? snap.position : 0,
          duration: typeof snap.duration === 'number' ? snap.duration : 0,
          theme: initialTheme,
          updatedAt: Date.now(),
          lyrics: Array.isArray(snap.lines) && snap.lines.length > 0 ? {
            lines: snap.lines.map((line) => ({
              startTime: line.startTime,
              endTime: line.endTime,
              ...(typeof line.renderHints?.renderEndTime === 'number'
                ? { renderEndTime: line.renderHints.renderEndTime }
                : {}),
              fullText: line.fullText || line.text || '',
              text: line.fullText || line.text || '',
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
          song: initialSong,
          volume: typeof snap.volume === 'number' ? Math.round(snap.volume * 100) : 100,
          isMuted: Boolean(snap.muted),
          loopMode: snap.loopMode || 'all',
          theme: initialTheme,
        };
      }
    }
  } catch (err) {
    api.log.warn('Could not read initial playback snapshot from api.runtime', err);
  }

  /**
   * Synchronizes window mouse pass-through and renderer hidden state from a single truth
   * (`isFullscreenHidden || isHoverHidden`) so fullscreen avoidance and hover-hide never conflict.
   * @param {boolean} [forceSend]
   */
  function syncWindowVisibility(forceSend = false) {
    if (!taskbarWindow || taskbarWindow.isDestroyed()) return;
    const shouldHide = Boolean(isFullscreenHidden || isHoverHidden);
    try {
      if (shouldHide) {
        taskbarWindow.setIgnoreMouseEvents(true, { forward: true });
      } else {
        taskbarWindow.setIgnoreMouseEvents(false);
      }
    } catch {}
    if (forceSend || lastSentWindowHidden !== shouldHide) {
      lastSentWindowHidden = shouldHide;
      try {
        taskbarWindow.webContents.send('taskbar-lyrics:hover-hidden', shouldHide);
      } catch {}
    }
  }

  /**
   * Detects whether an Electron window (e.g. Folia in fullscreen mode) occupies the target display.
   * @param {Electron.Display} [targetDisplay]
   */
  function isTargetDisplayFullscreen(targetDisplay) {
    try {
      const display = targetDisplay || resolveTargetDisplay();
      if (!display || !display.bounds) return false;

      const allWindows = BrowserWindow.getAllWindows();
      for (let i = 0; i < allWindows.length; i++) {
        const w = allWindows[i];
        if (!w || w.isDestroyed() || w === taskbarWindow || w === menuWindow || w.__foliaTaskbarLyricsOwned) continue;
        if (typeof w.isVisible === 'function' && typeof w.isFullScreen === 'function' && w.isVisible() && w.isFullScreen()) {
          try {
            const matched = screen.getDisplayMatching(w.getBounds());
            if (matched && matched.id === display.id) {
              return true;
            }
          } catch {}
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Schedules short follow-up topmost re-assertions after blur/fullscreen exit so Windows
   * taskbar activation (Shell_TrayWnd) cannot leave our overlay behind it for 600ms.
   * @param {number[]} delays
   * @param {boolean} [forceReset]
   */
  function scheduleTopmostReassert(delays = [35, 160], forceReset = false) {
    delays.forEach((delayMs) => {
      const timer = setTimeout(() => {
        topmostRetryTimers.delete(timer);
        if (!isDisposed && !isQuitting && !isFullscreenHidden && !isHoverHidden) {
          assertTopmost(forceReset);
        }
      }, delayMs);
      topmostRetryTimers.add(timer);
    });
  }

  /**
   * Hides the taskbar lyrics window while an Electron fullscreen window occupies the target display,
   * and restores interactive Z-order once fullscreen ends.
   */
  function syncFullscreenAvoidance() {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || isDisposed || isQuitting) return false;
    const display = resolveTargetDisplay();
    const fullscreenActive = isTargetDisplayFullscreen(display);
    if (fullscreenActive) {
      if (!isFullscreenHidden) {
        isFullscreenHidden = true;
        closeMenuWindow();
        syncWindowVisibility();
      }
      return true;
    }

    if (isFullscreenHidden) {
      isFullscreenHidden = false;
      syncWindowVisibility();
      if (!isHoverHidden) {
        assertTopmost(true);
        scheduleTopmostReassert([150, 450], true);
      }
    }
    return false;
  }

  /**
   * Asserts the window above Windows taskbar using pure Electron BrowserWindow APIs
   * (`screen-saver` level with explicit relativeLevel 1 + `moveTop`).
   * @param {boolean} [forceReset]
   */
  function assertTopmost(forceReset = false) {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || isDisposed || isQuitting) return;
    if (isHoverHidden || isFullscreenHidden) return;
    try {
      if (!taskbarWindow.isVisible()) {
        taskbarWindow.showInactive();
      }
      if (forceReset) {
        taskbarWindow.setAlwaysOnTop(false);
        taskbarWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      } else {
        taskbarWindow.setAlwaysOnTop(true, 'screen-saver', 1);
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
    if (interactionMode !== 'hover-hide' || isDisposed || isQuitting) return;
    if (!taskbarWindow || taskbarWindow.isDestroyed()) return;

    if (!isHoverHidden) {
      isHoverHidden = true;
      closeMenuWindow();
      syncWindowVisibility();
    }

    if (!hoverWatchTimer) {
      hoverWatchTimer = setInterval(() => {
        if (!taskbarWindow || taskbarWindow.isDestroyed() || isDisposed || isQuitting || interactionMode !== 'hover-hide') {
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
   * Restores the taskbar lyrics window once the mouse cursor leaves the taskbar area,
   * while respecting active fullscreen avoidance.
   */
  function leaveHoverHide() {
    if (hoverWatchTimer) {
      clearInterval(hoverWatchTimer);
      hoverWatchTimer = null;
    }
    if (isHoverHidden) {
      isHoverHidden = false;
      syncFullscreenAvoidance();
      syncWindowVisibility();
      if (!isFullscreenHidden) {
        assertTopmost();
      }
    }
  }

  function resolveMenuBounds() {
    const display = resolveTargetDisplay();
    const drawerBounds = resolveDrawerWindowBounds(true, display);
    const dispBounds = display?.bounds || { x: 0, y: 0, width: 1920, height: 1080 };
    const menuWidth = 384;
    const menuHeight = 500;
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
   * Applies bounds to the frameless non-resizable taskbar window using Electron BrowserWindow APIs.
   * @param {{ x: number, y: number, width: number, height: number }} winBounds
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
    const nextDisplay = normalizeDisplayTarget(settings.targetDisplay || currentDisplayTarget);

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
    if (isDisposed || isQuitting) return null;
    clearMenuDestroyTimer();
    if (menuWindow && !menuWindow.isDestroyed()) {
      return menuWindow;
    }

    const bounds = resolveMenuBounds();
    isCreatingOwnedWindow = true;
    let win;
    try {
      win = new BrowserWindow({
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
      win.__foliaTaskbarLyricsOwned = true;
    } finally {
      isCreatingOwnedWindow = false;
    }

    win.setAlwaysOnTop(true, 'screen-saver', 1);
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true);
    }

    const pushMenuState = () => {
      if (win.isDestroyed() || isDisposed || isQuitting) return;
      latestMenuSnapshot.displayInfo = buildDisplayInfo();
      try {
        win.webContents.send('taskbar-lyrics:snapshot', latestMenuSnapshot);
      } catch {}
    };

    win.webContents.on('did-finish-load', pushMenuState);

    win.once('ready-to-show', () => {
      if (!win.isDestroyed() && !isDisposed && !isQuitting) {
        win.show();
        win.focus();
        pushMenuState();
      }
    });

    win.on('blur', () => {
      lastMenuBlurTime = Date.now();
      closeMenuWindow();
    });

    win.on('closed', () => {
      if (menuWindow === win) {
        clearMenuDestroyTimer();
        menuWindow = null;
      }
    });

    win.loadFile(path.join(__dirname, 'view', 'menu.html'));

    menuWindow = win;
    return win;
  }

  function showMenuWindow() {
    if (isDisposed || isQuitting) return null;
    clearMenuDestroyTimer();
    if (menuWindow && !menuWindow.isDestroyed()) {
      const bounds = resolveMenuBounds();
      menuWindow.setBounds(bounds);
      menuWindow.setAlwaysOnTop(true, 'screen-saver', 1);
      menuWindow.show();
      menuWindow.focus();
      latestMenuSnapshot.displayInfo = buildDisplayInfo();
      menuWindow.webContents.send('taskbar-lyrics:snapshot', latestMenuSnapshot);
      return menuWindow;
    }
    return createMenuWindow();
  }

  function toggleMenuWindow() {
    if (isDisposed || isQuitting) return;
    const now = Date.now();
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      closeMenuWindow();
      return;
    }
    if (now - lastMenuBlurTime < 350) {
      return;
    }
    showMenuWindow();
  }

  function closeMenuWindow() {
    if (menuWindow && !menuWindow.isDestroyed()) {
      if (menuWindow.isVisible()) {
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
    if (!taskbarWindow || taskbarWindow.isDestroyed() || isDisposed || isQuitting) return;
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
    if (!taskbarWindow || taskbarWindow.isDestroyed() || isDisposed || isQuitting) return;
    if (!isDrawerExpanded || interactionMode === 'hover-hide') return;

    closeMenuWindow();
    leaveHoverHide();
    isDrawerExpanded = false;
    taskbarWindow.webContents.send('taskbar-lyrics:state', 'collapsed');

    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (taskbarWindow && !taskbarWindow.isDestroyed() && !isDrawerExpanded) {
        const winBounds = resolveDrawerWindowBounds(false);
        applyTaskbarWindowBounds(winBounds);
        assertTopmost();
      }
    }, 420);
  }

  function toggleDrawer() {
    if (isDisposed || isQuitting) return;
    if (!taskbarWindow || taskbarWindow.isDestroyed()) {
      createWindow();
    }
    if (isDrawerExpanded) {
      collapseDrawer();
    } else {
      expandDrawer();
    }
  }

  function createWindow() {
    if (isDisposed || isQuitting) return null;
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      return taskbarWindow;
    }

    const winBounds = resolveDrawerWindowBounds(isDrawerExpanded);
    isCreatingOwnedWindow = true;
    let win;
    try {
      win = new BrowserWindow({
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
        title: 'Folia Taskbar Lyrics',
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
      win.__foliaTaskbarLyricsOwned = true;
    } finally {
      isCreatingOwnedWindow = false;
    }

    win.setAlwaysOnTop(true, 'screen-saver', 1);
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true);
    }

    const syncLoadedView = () => {
      if (win.isDestroyed() || isDisposed || isQuitting) return;
      latestTaskbarSnapshot.displayInfo = buildDisplayInfo();
      try {
        win.webContents.send('taskbar-lyrics:state', isDrawerExpanded ? 'expanded' : 'collapsed');
        win.webContents.send('taskbar-lyrics:snapshot', latestTaskbarSnapshot);
      } catch {}
      syncWindowVisibility(true);
    };

    win.webContents.on('did-finish-load', syncLoadedView);

    win.once('ready-to-show', () => {
      if (win.isDestroyed() || isDisposed || isQuitting) return;
      applyTaskbarWindowBounds(resolveDrawerWindowBounds(isDrawerExpanded));
      const fullscreenNow = syncFullscreenAvoidance();
      if (!fullscreenNow && !isHoverHidden) {
        assertTopmost();
        win.showInactive();
      } else if (!win.isVisible()) {
        win.showInactive();
      }
      syncLoadedView();
      if (interactionMode === 'hover-hide') {
        if (!isDrawerExpanded) expandDrawer();
        if (isCursorInsideTaskbar(0)) enterHoverHide();
      }
    });

    win.on('minimize', () => {
      if (taskbarWindow && !taskbarWindow.isDestroyed() && !isDisposed && !isQuitting && !isFullscreenHidden) {
        taskbarWindow.restore();
        assertTopmost();
      }
    });

    win.on('blur', () => {
      if (taskbarWindow && !taskbarWindow.isDestroyed() && !isDisposed && !isQuitting) {
        const fullscreenNow = syncFullscreenAvoidance();
        if (!fullscreenNow && !isHoverHidden) {
          assertTopmost(false);
          scheduleTopmostReassert([35, 160], false);
        }
      }
    });

    win.webContents.on('render-process-gone', (_event, details) => {
      if (isDisposed || isQuitting || details?.reason === 'clean-exit' || taskbarWindow !== win) return;
      api.log.warn(`Taskbar lyrics renderer process gone (${details?.reason || 'unknown'}), recreating window...`);
      taskbarWindow = null;
      lastSentWindowHidden = null;
      if (!win.isDestroyed()) {
        try { win.destroy(); } catch {}
      }
      if (!isDisposed && !isQuitting) {
        createWindow();
      }
    });

    win.on('unresponsive', () => {
      if (isDisposed || isQuitting || taskbarWindow !== win) return;
      api.log.warn('Taskbar lyrics window unresponsive, reloading webContents...');
      if (!win.isDestroyed()) {
        try { win.webContents.reload(); } catch {}
      }
    });

    win.on('closed', () => {
      if (taskbarWindow !== win) return;
      taskbarWindow = null;
      lastSentWindowHidden = null;
      clearMenuDestroyTimer();
      if (menuWindow && !menuWindow.isDestroyed()) {
        menuWindow.close();
      }
    });

    win.loadFile(path.join(__dirname, 'view', 'taskbar.html'));

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
      if (collapseTimer) {
        clearTimeout(collapseTimer);
        collapseTimer = null;
      }
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
    clientRpcReady = true;
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
    isEnabled: !isDisposed && !isQuitting,
    isExpanded: isDrawerExpanded,
    interactionMode,
    displayInfo: buildDisplayInfo(),
  }));

  function isNonOwnedWindow(win) {
    return Boolean(
      win
      && typeof win.isDestroyed === 'function'
      && !win.isDestroyed()
      && win !== taskbarWindow
      && win !== menuWindow
      && !win.__foliaTaskbarLyricsOwned,
    );
  }

  function hasLiveHostWindow() {
    for (const win of Array.from(seenVisibleHostWindows)) {
      if (!win || typeof win.isDestroyed !== 'function' || win.isDestroyed()) {
        seenVisibleHostWindows.delete(win);
      }
    }
    return seenVisibleHostWindows.size > 0;
  }

  function clearOwnedTimers() {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    if (hoverWatchTimer) {
      clearInterval(hoverWatchTimer);
      hoverWatchTimer = null;
    }
    if (hostCloseCheckTimer) {
      clearTimeout(hostCloseCheckTimer);
      hostCloseCheckTimer = null;
    }
    topmostRetryTimers.forEach((timer) => clearTimeout(timer));
    topmostRetryTimers.clear();
    clearMenuDestroyTimer();
  }

  function closeOwnedWindows() {
    clearOwnedTimers();
    clientRpcReady = false;
    isDrawerExpanded = false;
    isHoverHidden = false;
    isFullscreenHidden = false;
    lastSentWindowHidden = null;
    if (menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.close();
      menuWindow = null;
    }
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      taskbarWindow.close();
      taskbarWindow = null;
    }
  }

  function scheduleHostCloseCheck() {
    if (hostCloseCheckTimer) {
      clearTimeout(hostCloseCheckTimer);
    }
    hostCloseCheckTimer = setTimeout(() => {
      hostCloseCheckTimer = null;
      if (!isDisposed && !hasLiveHostWindow()) {
        closeOwnedWindows();
      }
    }, 250);
  }

  function cancelHostCloseCheck() {
    if (hostCloseCheckTimer) {
      clearTimeout(hostCloseCheckTimer);
      hostCloseCheckTimer = null;
    }
  }

  /**
   * Tracks non-owned Electron BrowserWindows strictly via standard `isVisible()`, `'show'`, and `'closed'`
   * events so hidden background windows never block exit, while hiding the host window to tray keeps us alive.
   * @param {Electron.BrowserWindow} win
   */
  function trackPotentialHostWindow(win) {
    if (!isNonOwnedWindow(win) || watchedHostCleanups.has(win) || typeof win.on !== 'function') {
      return;
    }

    const markVisibleHost = () => {
      if (isDisposed || isQuitting || !isNonOwnedWindow(win)) return;
      seenVisibleHostWindows.add(win);
      cancelHostCloseCheck();
      if (!taskbarWindow || taskbarWindow.isDestroyed()) {
        createWindow();
      }
    };

    const onShow = () => {
      markVisibleHost();
    };

    const onClosed = () => {
      const wasTrackedHost = seenVisibleHostWindows.delete(win);
      cleanup();
      if (wasTrackedHost && !isDisposed && !hasLiveHostWindow()) {
        clientRpcReady = false;
        scheduleHostCloseCheck();
      }
    };

    const cleanup = () => {
      watchedHostCleanups.delete(win);
      try { win.removeListener?.('show', onShow); } catch {}
      try { win.removeListener?.('closed', onClosed); } catch {}
    };

    watchedHostCleanups.set(win, cleanup);
    win.on('show', onShow);
    win.on('closed', onClosed);

    if (typeof win.isVisible === 'function' && win.isVisible()) {
      seenVisibleHostWindows.add(win);
      cancelHostCloseCheck();
    }
  }

  try {
    BrowserWindow.getAllWindows().forEach(trackPotentialHostWindow);
  } catch {}

  const onBrowserWindowCreated = (_event, win) => {
    if (isDisposed || isQuitting || isCreatingOwnedWindow || win?.__foliaTaskbarLyricsOwned) return;
    trackPotentialHostWindow(win);
  };

  const onAppBeforeQuit = () => {
    isQuitting = true;
    closeOwnedWindows();
  };

  if (app && typeof app.on === 'function') {
    app.on('browser-window-created', onBrowserWindowCreated);
    app.on('before-quit', onAppBeforeQuit);
  }

  // Defer BrowserWindow setup past synchronous activate() so main call cost stays < 100ms
  startupWindowTimer = setImmediate(() => {
    startupWindowTimer = null;
    if (!isDisposed && !isQuitting && (!taskbarWindow || taskbarWindow.isDestroyed())) {
      createWindow();
    }
  });

  // Active Z-order & Electron fullscreen avoidance watchdog for Windows
  const topmostKeepAliveTimer = setInterval(() => {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || isDisposed || isQuitting) return;
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
    if (isDisposed) return;
    isDisposed = true;
    api.log.info('Deactivating Taskbar Lyrics mod');
    if (startupWindowTimer) {
      clearImmediate(startupWindowTimer);
      startupWindowTimer = null;
    }
    if (topmostKeepAliveTimer) clearInterval(topmostKeepAliveTimer);

    Array.from(watchedHostCleanups.values()).forEach((cleanup) => {
      try { cleanup(); } catch {}
    });
    watchedHostCleanups.clear();
    seenVisibleHostWindows.clear();

    if (app && typeof app.removeListener === 'function') {
      app.removeListener('browser-window-created', onBrowserWindowCreated);
      app.removeListener('before-quit', onAppBeforeQuit);
    }

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

    closeOwnedWindows();
  };

  return onDispose;
};
