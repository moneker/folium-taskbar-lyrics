const { contextBridge, ipcRenderer } = require('electron');

// mods/taskbar-lyrics/view/preload.cjs
// Secure IPC preload bridge for the taskbar lyrics drawer window,
// enabling snapshot consumption, drawer state coordination, hover-hide, display switching, and playback controls.

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
  notifyHoverEnter: () => ipcRenderer.send('taskbar-lyrics:hover-enter'),
  notifyHoverZoneState: (state) => ipcRenderer.send('taskbar-lyrics:hover-zone-state', state),
  reportControlsRect: (rect) => ipcRenderer.send('taskbar-lyrics:controls-rect', rect),
  onHoverHidden: (callback) => {
    const handler = (_event, hidden) => callback(Boolean(hidden));
    ipcRenderer.on('taskbar-lyrics:hover-hidden', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:hover-hidden', handler);
  },
  onHoverZoneReset: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('taskbar-lyrics:hover-zone-reset', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:hover-zone-reset', handler);
  },
  onMenuClosed: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('taskbar-lyrics:menu-closed', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:menu-closed', handler);
  },
  onMenuState: (callback) => {
    const handler = (_event, open) => callback(Boolean(open));
    ipcRenderer.on('taskbar-lyrics:menu-state', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:menu-state', handler);
  },
  openRadialWheel: (anchorRect) => ipcRenderer.send('taskbar-lyrics:open-radial', anchorRect),
  closeRadialWheel: () => ipcRenderer.send('taskbar-lyrics:close-radial'),
  notifyRadialAnchorLeave: () => ipcRenderer.send('taskbar-lyrics:radial-anchor-leave'),
  selectRadialTarget: (target) => ipcRenderer.send('taskbar-lyrics:radial-select', target),
  onRadialData: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('taskbar-lyrics:radial-data', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:radial-data', handler);
  },
  onRadialFeedback: (callback) => {
    const handler = (_event, feedback) => callback(feedback);
    ipcRenderer.on('taskbar-lyrics:radial-feedback', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:radial-feedback', handler);
  },
  onRadialClosed: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('taskbar-lyrics:radial-closed', handler);
    return () => ipcRenderer.removeListener('taskbar-lyrics:radial-closed', handler);
  },
  openPlayerPage: () => ipcRenderer.send('taskbar-lyrics:open-player'),
  switchDisplay: () => ipcRenderer.send('taskbar-lyrics:switch-display'),
  moveVertical: (targetY) => ipcRenderer.send('taskbar-lyrics:move-vertical', targetY),
  sendPlaybackAction: (action, payload) => {
    ipcRenderer.send('taskbar-lyrics:playback-action', { action, payload });
  },
});
