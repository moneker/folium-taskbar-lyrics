const { contextBridge, ipcRenderer } = require('electron');

// mods/taskbar-lyrics/view/preload.cjs
// Secure IPC preload bridge for the taskbar lyrics drawer window,
// enabling snapshot consumption, drawer state coordination, and playback controls.

contextBridge.exposeInMainWorld('taskbarBridge', {
  toggleDrawer: () => ipcRenderer.send('taskbar-drawer:toggle'),
  expandDrawer: () => ipcRenderer.send('taskbar-drawer:expand'),
  collapseDrawer: () => ipcRenderer.send('taskbar-drawer:collapse'),
  onDrawerState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('taskbar-drawer:state', handler);
    return () => ipcRenderer.removeListener('taskbar-drawer:state', handler);
  },
  notifyAnimationComplete: (state) => {
    ipcRenderer.send('taskbar-drawer:animation-done', state);
  },
  onSnapshot: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('taskbar-drawer:snapshot', handler);
    return () => ipcRenderer.removeListener('taskbar-drawer:snapshot', handler);
  },
  toggleMenu: () => ipcRenderer.send('taskbar-drawer:toggle-menu'),
  closeMenu: () => ipcRenderer.send('taskbar-drawer:close-menu'),
  sendPlaybackAction: (action, payload) => {
    ipcRenderer.send('taskbar-drawer:playback-action', { action, payload });
  },
});
