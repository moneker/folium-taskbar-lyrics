// mods/taskbar-lyrics/view/menu.js
// Logic for taskbar lyrics floating menu: play queue rendering, loop mode switching,
// and synchronized application volume slider.

(function () {
  'use strict';

  const bridge = window.taskbarBridge;
  if (!bridge) {
    console.error('TaskbarBridge not available in menu view');
    return;
  }

  // DOM Elements
  const queueCount = document.getElementById('queueCount');
  const closeBtn = document.getElementById('closeBtn');
  const queueList = document.getElementById('queueList');
  const loopModeBtn = document.getElementById('loopModeBtn');
  const loopIconOrder = document.getElementById('loopIconOrder');
  const loopIconOne = document.getElementById('loopIconOne');
  const loopIconShuffle = document.getElementById('loopIconShuffle');
  const loopModeLabel = document.getElementById('loopModeLabel');
  const muteBtn = document.getElementById('muteBtn');
  const volumeHighIcon = document.getElementById('volumeHighIcon');
  const volumeMuteIcon = document.getElementById('volumeMuteIcon');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumePercent = document.getElementById('volumePercent');

  let isDraggingSlider = false;
  let lastQueueJson = '';

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Close menu on close button click
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      bridge.closeMenu();
    });
  }

  // Loop mode toggle click
  if (loopModeBtn) {
    loopModeBtn.addEventListener('click', () => {
      bridge.sendPlaybackAction('toggleLoopMode');
    });
  }

  // Mute button click
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      bridge.sendPlaybackAction('toggleMute');
    });
  }

  // Volume slider interaction
  if (volumeSlider) {
    volumeSlider.addEventListener('mousedown', () => {
      isDraggingSlider = true;
    });

    volumeSlider.addEventListener('mouseup', () => {
      isDraggingSlider = false;
    });

    volumeSlider.addEventListener('input', (e) => {
      const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      if (volumePercent) {
        volumePercent.textContent = `${val}%`;
      }
      bridge.sendPlaybackAction('setVolume', val);
    });

    volumeSlider.addEventListener('change', (e) => {
      isDraggingSlider = false;
      const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      bridge.sendPlaybackAction('setVolume', val);
    });

    const volContainer = volumeSlider.closest('.volume-control-row');
    if (volContainer) {
      volContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        const current = Number(volumeSlider.value) || 0;
        const step = e.deltaY < 0 ? 5 : -5;
        const next = Math.max(0, Math.min(100, current + step));
        volumeSlider.value = next;
        if (volumePercent) volumePercent.textContent = `${next}%`;
        bridge.sendPlaybackAction('setVolume', next);
      }, { passive: false });
    }
  }

  // Render Play Queue
  function renderQueue(queue) {
    if (!queueList) return;

    if (!Array.isArray(queue) || queue.length === 0) {
      queueList.innerHTML = '<div class="queue-empty">暂无播放队列</div>';
      lastQueueJson = '';
      return;
    }

    // Performance check: avoid rewriting DOM if queue content & active state haven't changed
    const currentQueueJson = JSON.stringify(queue.map(q => ({ i: q.index, t: q.title, a: q.artist, act: q.active })));
    if (currentQueueJson === lastQueueJson) {
      return;
    }
    lastQueueJson = currentQueueJson;

    queueList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    queue.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = `queue-item ${item.active ? 'active' : ''}`;
      el.setAttribute('role', 'listitem');
      el.innerHTML = `
        <div class="song-name" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="song-sub" title="${escapeHtml(item.artist)}">${escapeHtml(item.artist)}</div>
      `;

      el.addEventListener('click', () => {
        bridge.sendPlaybackAction('playQueueIndex', item.index !== undefined ? item.index : idx);
      });

      fragment.appendChild(el);
    });

    queueList.appendChild(fragment);

    // Auto-scroll active item into view
    const activeItem = queueList.querySelector('.queue-item.active');
    if (activeItem) {
      activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Update Loop Mode Display
  function updateLoopMode(mode) {
    if (!loopModeLabel) return;

    if (loopIconOrder) loopIconOrder.classList.add('hidden');
    if (loopIconOne) loopIconOne.classList.add('hidden');
    if (loopIconShuffle) loopIconShuffle.classList.add('hidden');

    switch (mode) {
      case 'one':
        if (loopIconOne) loopIconOne.classList.remove('hidden');
        loopModeLabel.textContent = '单曲循环';
        break;
      case 'all':
        if (loopIconOrder) loopIconOrder.classList.remove('hidden');
        loopModeLabel.textContent = '列表循环';
        break;
      case 'shuffle':
        if (loopIconShuffle) loopIconShuffle.classList.remove('hidden');
        loopModeLabel.textContent = '随机播放';
        break;
      case 'off':
      default:
        if (loopIconOrder) loopIconOrder.classList.remove('hidden');
        loopModeLabel.textContent = '顺序播放';
        break;
    }
  }

  // Update Volume Display
  function updateVolume(vol, isMuted) {
    if (isMuted) {
      if (volumeMuteIcon) volumeMuteIcon.classList.remove('hidden');
      if (volumeHighIcon) volumeHighIcon.classList.add('hidden');
      if (volumePercent) volumePercent.textContent = '静音';
      if (volumeSlider && !isDraggingSlider) {
        volumeSlider.value = 0;
      }
    } else {
      if (volumeMuteIcon) volumeMuteIcon.classList.add('hidden');
      if (volumeHighIcon) volumeHighIcon.classList.remove('hidden');
      const safeVol = typeof vol === 'number' && Number.isFinite(vol) ? Math.round(vol) : 100;
      if (volumePercent) volumePercent.textContent = `${safeVol}%`;
      if (volumeSlider && !isDraggingSlider) {
        volumeSlider.value = safeVol;
      }
    }
  }

  // Subscribe to snapshot data from bridge
  bridge.onSnapshot((data) => {
    if (!data) return;

    // 1. Queue list & count
    const queue = data.queue || [];
    if (queueCount) {
      queueCount.textContent = `${queue.length} 首`;
    }
    renderQueue(queue);

    // 2. Loop Mode
    updateLoopMode(data.loopMode || 'all');

    // 3. Volume
    updateVolume(data.volume, Boolean(data.isMuted));
  });
})();
