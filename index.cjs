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
const MAX_PENDING_ACTIONS = 50;
const MENU_IDLE_DESTROY_MS = 10000; // Free menuWindow renderer process after 10s idle (reclaims ~45MB)

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
        displays: [],
      };
    }
  }

  /**
   * Calculates the bounding rectangle of the Windows taskbar on the target display.
   * @param {Electron.Display} [targetDisplay]
   * @returns {{ x: number, y: number, width: number, height: number }}
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
        };
      }

      // Taskbar at the top
      if (workArea.y > bounds.y) {
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: workArea.y - bounds.y,
        };
      }

      // Taskbar on the left
      if (workArea.x > bounds.x) {
        return {
          x: bounds.x,
          y: bounds.y,
          width: workArea.x - bounds.x,
          height: bounds.height,
        };
      }

      // Taskbar on the right
      if (workArea.x === bounds.x && workArea.width < bounds.width) {
        return {
          x: bounds.x + workArea.width,
          y: bounds.y,
          width: bounds.width - workArea.width,
          height: bounds.height,
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
      };
    } catch {
      return { x: 0, y: 0, width: 1920, height: 48 };
    }
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
   * Asserts the window to floating level above Windows taskbar (Shell_TrayWnd).
   */
  function assertTopmost() {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return;
    if (isHoverHidden) return;
    try {
      if (!taskbarWindow.isAlwaysOnTop()) {
        taskbarWindow.setAlwaysOnTop(true, 'screen-saver');
      }
      if (typeof taskbarWindow.moveTop === 'function') {
        taskbarWindow.moveTop();
      }
      if (!taskbarWindow.isVisible()) {
        taskbarWindow.showInactive();
      }
    } catch {
      // Ignored if window is mid-transition or destroying
    }
  }

  /**
   * Checks whether the mouse cursor is currently inside the active taskbar bounds.
   */
  function isCursorInsideTaskbar(margin = 2) {
    try {
      const pt = screen.getCursorScreenPoint();
      const b = resolveTaskbarBounds();
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
    const bounds = resolveTaskbarBounds(display);
    const menuWidth = 360;
    const menuHeight = 460;
    const margin = 12;
    const x = Math.max(bounds.x + margin, bounds.x + bounds.width - menuWidth - margin);
    let y = bounds.y - menuHeight - 8;
    if (display && Math.abs(bounds.y - display.bounds.y) <= 2 && bounds.height < display.bounds.height) {
      y = bounds.y + bounds.height + 8;
    }
    return { x, y, width: menuWidth, height: menuHeight };
  }

  function repositionWindowsToActiveDisplay() {
    const display = resolveTargetDisplay();
    const bounds = resolveTaskbarBounds(display);
    const displayInfo = buildDisplayInfo();
    latestTaskbarSnapshot.displayInfo = displayInfo;
    latestMenuSnapshot.displayInfo = displayInfo;

    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      taskbarWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: isDrawerExpanded ? bounds.width : COLLAPSED_WIDTH,
        height: bounds.height,
      });
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
    const bounds = resolveTaskbarBounds();
    taskbarWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    });

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
        const bounds = resolveTaskbarBounds();
        taskbarWindow.setBounds({
          x: bounds.x,
          y: bounds.y,
          width: COLLAPSED_WIDTH,
          height: bounds.height,
        });
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

    const bounds = resolveTaskbarBounds();
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: isDrawerExpanded ? bounds.width : COLLAPSED_WIDTH,
      height: bounds.height,
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
        assertTopmost();
        if (isEnabled) {
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
      if (taskbarWindow && !taskbarWindow.isDestroyed() && isEnabled) {
        taskbarWindow.restore();
        assertTopmost();
      }
    });

    win.on('blur', () => {
      if (taskbarWindow && !taskbarWindow.isDestroyed() && isEnabled && !isHoverHidden) {
        taskbarWindow.moveTop();
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
        const bounds = resolveTaskbarBounds();
        taskbarWindow.setBounds({
          x: bounds.x,
          y: bounds.y,
          width: COLLAPSED_WIDTH,
          height: bounds.height,
        });
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

  // Active Z-order watchdog for Windows: keeps taskbarWindow above Shell_TrayWnd when not hover-hidden
  const topmostKeepAliveTimer = setInterval(() => {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return;
    if (currentDisplayTarget === 'wallpaper') {
      const targetDisplay = resolveTargetDisplay();
      if (targetDisplay && targetDisplay.id !== latestTaskbarSnapshot.displayInfo?.activeId) {
        repositionWindowsToActiveDisplay();
      }
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
  }, 1000);

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
