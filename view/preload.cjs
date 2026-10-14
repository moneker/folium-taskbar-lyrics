const { contextBridge, ipcRenderer } = require('electron');

// mods/taskbar-lyrics/view/preload.cjs
// Secure IPC preload bridge for the taskbar lyrics drawer window,
// enabling snapshot consumption, drawer state coordination, and playback controls.

contextBridge.exposeInMainWorld('taskbarBridge', {
  assertTop: () => ipcRenderer.send('taskbar-lyrics:assert-top'),
  toggleDrawer: () => ipcRenderer.send('taskbar-lyrics:toggle'),
  expandDrawer: () => ipcRenderer.send('taskbar-lyrics:expand'),
  collapseDrawer: () => ipcRenderer.send('taskbar-lyrics:collapse'),
  onDrawerState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('taskbar-lyrics:state', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:state', handler);
  },
  notifyAnimationComplete: (state) => {
    ipcRenderer.send('taskbar-lyrics:animation-done', state);
  },
  onSnapshot: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('taskbar-lyrics:snapshot', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:snapshot', handler);
  },
  toggleMenu: () => ipcRenderer.send('taskbar-lyrics:toggle-menu'),
  closeMenu: () => ipcRenderer.send('taskbar-lyrics:close-menu'),
  sendPlaybackAction: (action, payload) => {
    ipcRenderer.send('taskbar-lyrics:playback-action', { action, payload });
  },
});
