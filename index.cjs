// mods/taskbar-lyrics/index.cjs
// Main process entry for Taskbar Lyrics Drawer mod.
// Calculates Windows taskbar geometry, manages the drawer overlay window,
// ensures topmost persistence against system tray overflows, and registers tray controls.

'use strict';

const path = require('path');
const { BrowserWindow, screen, ipcMain, Menu } = require('electron');

// mod main controller for Windows taskbar lyrics drawer
const COLLAPSED_WIDTH = 56; // Width of the permanent left replacement button

/**
 * Calculates the bounding rectangle of the Windows taskbar using screen display metrics.
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function resolveTaskbarBounds() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { bounds, workArea } = primaryDisplay;

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

    // Fallback: bottom 48px
    const defaultHeight = 48;
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

/**
 * Taskbar Lyrics Mod Main Entry
 * @param {import('../../src/mods/folium/contract').FoliumNodeApi} api
 */
module.exports = function activate(api) {
  api.log.info(`Activating Taskbar Lyrics Drawer mod (v${api.manifest.version})`);

  let taskbarWindow = null;
  let menuWindow = null;
  let isEnabled = true;
  let isDrawerExpanded = false;
  let latestSnapshot = null;
  const pendingActions = [];
  let collapseTimer = null;
  let blurDebounceTimer = null;

  // Intercept Menu.buildFromTemplate to dynamically insert "任务栏歌词" in packaged Folia apps
  const originalBuildFromTemplate = Menu.buildFromTemplate;
  Menu.buildFromTemplate = function (template) {
    try {
      if (Array.isArray(template)) {
        const isTrayMenu = template.some(
          (item) => item && (
            item.label === '桌面歌词' ||
            item.label === 'Desktop Lyrics' ||
            item.label === 'Lirik Desktop' ||
            item.label === '壁纸模式' ||
            item.label === 'Wallpaper Mode' ||
            item.label === 'Mode Wallpaper'
          )
        );
        const alreadyHasTaskbar = template.some(
          (item) => item && (item.id === 'mod-taskbar-lyrics' || item.label === '任务栏歌词' || item.label === 'Taskbar Lyrics')
        );

        if (isTrayMenu && !alreadyHasTaskbar) {
          let targetIdx = template.findIndex(
            (item) => item && (
              item.label === '桌面歌词' ||
              item.label === 'Desktop Lyrics' ||
              item.label === 'Lirik Desktop'
            )
          );
          if (targetIdx === -1) {
            targetIdx = template.findIndex(
              (item) => item && (
                item.label === '壁纸模式' ||
                item.label === 'Wallpaper Mode' ||
                item.label === 'Mode Wallpaper'
              )
            );
          }

          const insertAt = targetIdx !== -1 ? targetIdx + 1 : Math.max(0, template.length - 2);
          template.splice(insertAt, 0, {
            id: 'mod-taskbar-lyrics',
            label: '任务栏歌词',
            type: 'checkbox',
            checked: Boolean(isEnabled),
            click: () => {
              if (isEnabled) {
                disableTaskbarLyrics();
              } else {
                enableTaskbarLyrics();
              }
              if (typeof global.__refreshTrayMenu === 'function') {
                global.__refreshTrayMenu();
              }
            },
          });
        }
      }
    } catch (e) {
      api.log.error('Failed to inject taskbar lyrics to tray template', e);
    }
    return originalBuildFromTemplate.call(this, template);
  };

  /**
   * Reasserts the window to the topmost screen-saver tier.
   * Prevents Windows Explorer / NotifyIconOverflowWindow from pushing the button behind Shell_TrayWnd.
   */
  function assertTopmost() {
    if (!taskbarWindow || taskbarWindow.isDestroyed() || !isEnabled) return;
    try {
      taskbarWindow.setAlwaysOnTop(true, 'screen-saver', 1);
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

  function resolveMenuBounds() {
    const bounds = resolveTaskbarBounds();
    const menuWidth = 330;
    const menuHeight = 420;
    const margin = 12;
    const x = Math.max(0, bounds.x + bounds.width - menuWidth - margin);
    let y = bounds.y - menuHeight - 8;
    if (bounds.y === 0) {
      y = bounds.y + bounds.height + 8;
    }
    return { x, y, width: menuWidth, height: menuHeight };
  }

  function createMenuWindow() {
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
        webSecurity: false,
        backgroundThrottling: false,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver', 2);
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    win.loadFile(path.join(__dirname, 'view', 'menu.html'));

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        if (latestSnapshot) {
          win.webContents.send('taskbar-drawer:snapshot', latestSnapshot);
        }
      }
    });

    win.on('blur', () => {
      closeMenuWindow();
    });

    win.on('closed', () => {
      menuWindow = null;
    });

    menuWindow = win;
    return win;
  }

  function closeMenuWindow() {
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      menuWindow.hide();
    }
  }

  function toggleMenuWindow() {
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      closeMenuWindow();
    } else {
      if (!menuWindow || menuWindow.isDestroyed()) {
        createMenuWindow();
      } else {
        const bounds = resolveMenuBounds();
        menuWindow.setBounds(bounds);
        menuWindow.show();
        menuWindow.focus();
        if (latestSnapshot) {
          menuWindow.webContents.send('taskbar-drawer:snapshot', latestSnapshot);
        }
      }
    }
  }

  // Window creation
  function createWindow() {
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      return taskbarWindow;
    }

    const bounds = resolveTaskbarBounds();
    const initialWidth = isDrawerExpanded ? bounds.width : COLLAPSED_WIDTH;

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: initialWidth,
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
        webSecurity: false, // Allows cross-origin album artwork without mixed-content/CORS blocking
        backgroundThrottling: false,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver', 1);
    if (typeof win.setVisibleOnAllWorkspaces === 'function') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    win.loadFile(path.join(__dirname, 'view', 'taskbar.html'));

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) {
        assertTopmost();
        if (isEnabled) {
          win.showInactive();
        }
        win.webContents.send('taskbar-drawer:state', isDrawerExpanded ? 'expanded' : 'collapsed');
        if (latestSnapshot) {
          win.webContents.send('taskbar-drawer:snapshot', latestSnapshot);
        }
      }
    });

    // Prevent Windows "Show Desktop" (Win+D) or taskbar clicks from burying the button
    win.on('minimize', () => {
      if (taskbarWindow && !taskbarWindow.isDestroyed() && isEnabled) {
        taskbarWindow.restore();
        assertTopmost();
      }
    });

    win.on('blur', () => {
      if (blurDebounceTimer) clearTimeout(blurDebounceTimer);
      blurDebounceTimer = setTimeout(() => {
        assertTopmost();
      }, 100);
    });

    win.on('closed', () => {
      taskbarWindow = null;
    });

    taskbarWindow = win;
    return win;
  }

  // Expand drawer: first widen the window to full taskbar width, then trigger slide-in CSS
  function expandDrawer() {
    if (!isEnabled) {
      enableTaskbarLyrics();
    }
    if (!taskbarWindow || taskbarWindow.isDestroyed()) {
      createWindow();
    }
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
    taskbarWindow.webContents.send('taskbar-drawer:state', 'expanded');
    if (typeof global.__refreshTrayMenu === 'function') {
      global.__refreshTrayMenu();
    }
    return true;
  }

  // Collapse drawer: first trigger slide-out CSS, then shrink window back to 56px
  function collapseDrawer() {
    if (!taskbarWindow || taskbarWindow.isDestroyed()) return false;
    isDrawerExpanded = false;

    taskbarWindow.webContents.send('taskbar-drawer:state', 'collapsed');

    // Safety fallback timer to resize window back to COLLAPSED_WIDTH
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
    }, 380);

    if (typeof global.__refreshTrayMenu === 'function') {
      global.__refreshTrayMenu();
    }
    return false;
  }

  function toggleDrawer() {
    if (isDrawerExpanded) {
      return collapseDrawer();
    } else {
      return expandDrawer();
    }
  }

  // Enable/show taskbar lyrics
  function enableTaskbarLyrics() {
    isEnabled = true;
    if (!taskbarWindow || taskbarWindow.isDestroyed()) {
      createWindow();
    } else {
      assertTopmost();
      taskbarWindow.showInactive();
    }
    if (typeof global.__refreshTrayMenu === 'function') {
      global.__refreshTrayMenu();
    }
  }

  // Disable/hide taskbar lyrics
  function disableTaskbarLyrics() {
    isEnabled = false;
    if (isDrawerExpanded) {
      isDrawerExpanded = false;
    }
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      taskbarWindow.hide();
    }
    if (typeof global.__refreshTrayMenu === 'function') {
      global.__refreshTrayMenu();
    }
  }

  // Handle IPC from the drawer view
  const onToggleDrawer = (event) => {
    if (taskbarWindow && event.sender === taskbarWindow.webContents) {
      toggleDrawer();
    }
  };
  const onExpandDrawer = (event) => {
    if (taskbarWindow && event.sender === taskbarWindow.webContents) {
      expandDrawer();
    }
  };
  const onCollapseDrawer = (event) => {
    if (taskbarWindow && event.sender === taskbarWindow.webContents) {
      collapseDrawer();
    }
  };
  const onAnimationDone = (event, state) => {
    if (taskbarWindow && event.sender === taskbarWindow.webContents) {
      if (state === 'collapsed' && !isDrawerExpanded) {
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
    if ((taskbarWindow && event.sender === taskbarWindow.webContents) ||
        (menuWindow && event.sender === menuWindow.webContents)) {
      pendingActions.push(payload);
    }
  };

  const onToggleMenu = () => {
    toggleMenuWindow();
  };
  const onCloseMenu = () => {
    closeMenuWindow();
  };

  ipcMain.on('taskbar-drawer:toggle', onToggleDrawer);
  ipcMain.on('taskbar-drawer:expand', onExpandDrawer);
  ipcMain.on('taskbar-drawer:collapse', onCollapseDrawer);
  ipcMain.on('taskbar-drawer:animation-done', onAnimationDone);
  ipcMain.on('taskbar-drawer:playback-action', onPlaybackAction);
  ipcMain.on('taskbar-drawer:toggle-menu', onToggleMenu);
  ipcMain.on('taskbar-drawer:close-menu', onCloseMenu);

  // Screen metrics listener
  const onDisplayMetricsChanged = () => {
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      const bounds = resolveTaskbarBounds();
      taskbarWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: isDrawerExpanded ? bounds.width : COLLAPSED_WIDTH,
        height: bounds.height,
      });
      assertTopmost();
    }
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      const menuBounds = resolveMenuBounds();
      menuWindow.setBounds(menuBounds);
    }
  };
  screen.on('display-metrics-changed', onDisplayMetricsChanged);

  // Register RPC for renderer client (`client.mjs`)
  api.rpc.handle('syncSnapshot', (snapshot) => {
    latestSnapshot = snapshot;
    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      taskbarWindow.webContents.send('taskbar-drawer:snapshot', snapshot);
    }
    if (menuWindow && !menuWindow.isDestroyed() && menuWindow.isVisible()) {
      menuWindow.webContents.send('taskbar-drawer:snapshot', snapshot);
    }
    return true;
  });

  api.rpc.handle('drainActions', () => {
    if (pendingActions.length === 0) return [];
    return pendingActions.splice(0, pendingActions.length);
  });

  api.rpc.handle('toggleDrawer', () => toggleDrawer());
  api.rpc.handle('expandDrawer', () => expandDrawer());
  api.rpc.handle('collapseDrawer', () => collapseDrawer());
  api.rpc.handle('getStatus', () => ({
    isOpen: Boolean(taskbarWindow && !taskbarWindow.isDestroyed()),
    isEnabled,
    isExpanded: isDrawerExpanded,
  }));

  // Register Global Tray Menu Controller
  global.__taskbarLyricsController = {
    isOpen: () => Boolean(taskbarWindow && !taskbarWindow.isDestroyed() && isEnabled),
    isEnabled: () => isEnabled,
    isDrawerExpanded: () => isDrawerExpanded,
    toggle: () => {
      if (isEnabled) {
        disableTaskbarLyrics();
      } else {
        enableTaskbarLyrics();
      }
    },
    expand: () => expandDrawer(),
    collapse: () => collapseDrawer(),
  };

  if (typeof global.__refreshTrayMenu === 'function') {
    global.__refreshTrayMenu();
  }

  // Initialize the taskbar window
  createWindow();

  // Active Z-order watchdog: keep taskbarWindow above Shell_TrayWnd even after clicks on taskbar
  const topmostKeepAliveTimer = setInterval(() => {
    if (taskbarWindow && !taskbarWindow.isDestroyed() && isEnabled) {
      assertTopmost();
    }
  }, 450);

  // Lifecycle teardown
  api.lifecycle.onDeactivate(() => {
    api.log.info('Deactivating Taskbar Lyrics Drawer mod');
    if (topmostKeepAliveTimer) clearInterval(topmostKeepAliveTimer);
    if (collapseTimer) clearTimeout(collapseTimer);
    if (blurDebounceTimer) clearTimeout(blurDebounceTimer);
    screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
    ipcMain.removeListener('taskbar-drawer:toggle', onToggleDrawer);
    ipcMain.removeListener('taskbar-drawer:expand', onExpandDrawer);
    ipcMain.removeListener('taskbar-drawer:collapse', onCollapseDrawer);
    ipcMain.removeListener('taskbar-drawer:animation-done', onAnimationDone);
    ipcMain.removeListener('taskbar-drawer:playback-action', onPlaybackAction);
    ipcMain.removeListener('taskbar-drawer:toggle-menu', onToggleMenu);
    ipcMain.removeListener('taskbar-drawer:close-menu', onCloseMenu);

    global.__taskbarLyricsController = null;
    Menu.buildFromTemplate = originalBuildFromTemplate;
    if (typeof global.__refreshTrayMenu === 'function') {
      global.__refreshTrayMenu();
    }

    if (menuWindow && !menuWindow.isDestroyed()) {
      menuWindow.close();
      menuWindow = null;
    }

    if (taskbarWindow && !taskbarWindow.isDestroyed()) {
      taskbarWindow.close();
      taskbarWindow = null;
    }
  });
};
