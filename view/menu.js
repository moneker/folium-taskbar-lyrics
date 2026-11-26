// mods/taskbar-lyrics/view/menu.js
// Logic for taskbar lyrics floating menu: paginated play queue, public folium.omni search & source switcher,
// current song album/artist explorer with queue replacement, and mod-owned saved/recent tracks.

(function () {
  'use strict';

  const bridge = window.taskbarBridge;
  if (!bridge) {
    console.error('TaskbarBridge not available in menu view');
    return;
  }

  // DOM Elements
  const menuTabs = document.getElementById('menuTabs');
  const viewToolbar = document.getElementById('viewToolbar');
  const viewSubbar = document.getElementById('viewSubbar');
  const viewContainer = document.getElementById('viewContainer');

  const loopModeBtn = document.getElementById('loopModeBtn');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const displaySwitchBtn = document.getElementById('displaySwitchBtn');
  const displaySwitchLabel = document.getElementById('displaySwitchLabel');
  const loopIconAll = document.getElementById('loopIconAll');
  const loopIconOne = document.getElementById('loopIconOne');
  const loopIconOff = document.getElementById('loopIconOff');
  const loopModeLabel = document.getElementById('loopModeLabel');
  const muteBtn = document.getElementById('muteBtn');
  const volumeHighIcon = document.getElementById('volumeHighIcon');
  const volumeMuteIcon = document.getElementById('volumeMuteIcon');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumePercent = document.getElementById('volumePercent');
  const offsetMinusBtn = document.getElementById('offsetMinusBtn');
  const offsetResetBtn = document.getElementById('offsetResetBtn');
  const offsetPlusBtn = document.getElementById('offsetPlusBtn');
  const lyricsToggleBtn = document.getElementById('lyricsToggleBtn');
  const lyricsEyeIcon = document.getElementById('lyricsEyeIcon');
  const lyricsEyeOffIcon = document.getElementById('lyricsEyeOffIcon');

  let activeTab = 'queue'; // 'queue' | 'search' | 'explore' | 'saved'
  let savedSubTab = 'saved'; // 'saved' | 'recent'
  let isDraggingSlider = false;
  let wheelVolumeTimer = null;
  let lastAutoScrolledKey = '';
  let isComposingSearch = false;
  let searchDraft = '';
  let selectedProviderId = '';

  const queueState = {
    items: [],
    total: 0,
    page: 0,
    pageSize: 50,
    currentIndex: -1,
  };

  const footerState = {
    loopMode: 'all',
    volume: 100,
    isMuted: false,
    showLyrics: true,
    lyricsVisible: true,
    lyricOffsetMs: 0,
    songLyricOffsetMs: 0,
    globalLyricOffsetMs: 0,
  };

  let currentSong = null;
  let providers = [];
  let searchState = {
    query: '',
    providerId: '',
    items: [],
    nextCursor: null,
    total: null,
    loading: false,
    error: null,
  };
  let exploreData = null;
  let savedTracks = [];
  let recentTracks = [];

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDuration(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function portableKey(source, id) {
    if (!source || id === null || id === undefined || id === '') return '';
    return `${String(source)}:${String(id)}`;
  }

  function isTrackSaved(source, id) {
    const k = portableKey(source, id);
    if (!k) return false;
    return savedTracks.some((item) => portableKey(item.source, item.id) === k);
  }

  function isPortableOnline(song) {
    if (!song || !song.source || song.id === null || song.id === undefined || song.id === '') return false;
    const src = String(song.source);
    return src !== 'local' && src !== 'stage' && src !== 'navidrome';
  }

  // =========================================================================
  // Theme Synchronization
  // =========================================================================

  function parseRgbChannels(colorStr) {
    if (!colorStr) return null;
    let hex = String(colorStr).trim();
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) {
      const m = hex.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) {
        return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0];
      }
    }
    if (hex.startsWith('#')) {
      hex = hex.slice(1);
    }
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    if (hex.length >= 6) {
      return [
        parseInt(hex.substring(0, 2), 16) || 0,
        parseInt(hex.substring(2, 4), 16) || 0,
        parseInt(hex.substring(4, 6), 16) || 0,
      ];
    }
    return null;
  }

  function relativeLuminance(rgb) {
    if (!rgb) return 0;
    const toLinear = (v) => {
      const s = Math.max(0, Math.min(255, v)) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
  }

  function contrastRatio(rgbA, rgbB) {
    const l1 = relativeLuminance(rgbA);
    const l2 = relativeLuminance(rgbB);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function computeContrastTextColor(colorStr) {
    const rgb = parseRgbChannels(colorStr);
    if (!rgb) return '#ffffff';
    return relativeLuminance(rgb) > 0.42 ? '#111827' : '#ffffff';
  }

  function colorWithAlpha(colorStr, alpha) {
    const rgb = parseRgbChannels(colorStr);
    if (rgb) {
      return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
    }
    return `rgba(255, 255, 255, ${alpha})`;
  }

  function applyTheme(theme) {
    if (!theme) return;
    const isDaylight = Boolean(theme.isDaylight);
    if (isDaylight) {
      document.documentElement.classList.add('daylight');
      document.body.classList.add('daylight');
    } else {
      document.documentElement.classList.remove('daylight');
      document.body.classList.remove('daylight');
    }

    const rootStyle = document.documentElement.style;
    const bg = theme.backgroundColor || (isDaylight ? '#f5f5f4' : '#09090b');
    const primary = theme.primaryColor || (isDaylight ? '#1c1917' : '#f4f4f5');
    const secondary = theme.secondaryColor || (isDaylight ? '#44403c' : '#71717a');
    const rawAccent = theme.accentColor || (isDaylight ? '#ea580c' : '#6366f1');
    const bgRgb = parseRgbChannels(bg);
    const accentRgb = parseRgbChannels(rawAccent);
    const accent = (bgRgb && accentRgb && contrastRatio(bgRgb, accentRgb) < 1.8)
      ? primary
      : rawAccent;
    const accentContrast = computeContrastTextColor(accent);

    rootStyle.setProperty('--bg-acrylic', colorWithAlpha(bg, isDaylight ? 0.96 : 0.94));
    rootStyle.setProperty('--bg-header', colorWithAlpha(bg, isDaylight ? 0.98 : 0.96));
    rootStyle.setProperty('--bg-toolbar', colorWithAlpha(primary, isDaylight ? 0.03 : 0.05));
    rootStyle.setProperty('--bg-footer', colorWithAlpha(bg, isDaylight ? 0.92 : 0.88));
    rootStyle.setProperty('--bg-card', colorWithAlpha(primary, isDaylight ? 0.04 : 0.06));
    rootStyle.setProperty('--bg-card-hover', colorWithAlpha(primary, isDaylight ? 0.08 : 0.10));
    rootStyle.setProperty('--bg-card-active', colorWithAlpha(primary, isDaylight ? 0.12 : 0.15));
    rootStyle.setProperty('--border-subtle', colorWithAlpha(primary, isDaylight ? 0.09 : 0.11));
    rootStyle.setProperty('--border-highlight', colorWithAlpha(primary, isDaylight ? 0.18 : 0.22));
    rootStyle.setProperty('--button-hover-bg', colorWithAlpha(primary, isDaylight ? 0.08 : 0.12));
    rootStyle.setProperty('--text-primary', primary);
    rootStyle.setProperty('--text-secondary', secondary);
    rootStyle.setProperty('--text-tertiary', colorWithAlpha(secondary, 0.75));
    rootStyle.setProperty('--accent-color', accent);
    rootStyle.setProperty('--accent-fg', accent);
    rootStyle.setProperty('--accent-contrast', accentContrast);
    rootStyle.setProperty('--accent-glow', colorWithAlpha(accent, 0.35));
    rootStyle.setProperty('--accent-gradient', `linear-gradient(135deg, ${accent}, ${colorWithAlpha(accent, 0.8)})`);
    rootStyle.setProperty('--scrollbar-thumb', colorWithAlpha(primary, isDaylight ? 0.20 : 0.25));
  }

  // =========================================================================
  // Shared Row Builders
  // =========================================================================

  function createCoverElement(coverUrl, fallbackType = 'music') {
    const wrap = document.createElement('div');
    wrap.className = 'list-item-cover';
    const fallbackSvg = fallbackType === 'artist'
      ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>'
      : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3"></circle></svg>';
    if (coverUrl) {
      const img = document.createElement('img');
      img.src = coverUrl;
      img.alt = '';
      img.onerror = () => {
        wrap.innerHTML = fallbackSvg;
      };
      wrap.appendChild(img);
    } else {
      wrap.innerHTML = fallbackSvg;
    }
    return wrap;
  }

  function createStarButton(track) {
    const saved = isTrackSaved(track.source, track.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `row-icon-btn ${saved ? 'saved' : ''}`;
    btn.title = saved ? '从任务栏收藏移除' : '加入任务栏快捷收藏';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.sendPlaybackAction('toggleSaveTrack', {
        source: track.source,
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album || '',
        coverUrl: track.coverUrl || null,
      });
    });
    return btn;
  }

  function createEnqueueButton(track) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-icon-btn';
    btn.title = '加入播放队列';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.sendPlaybackAction('enqueueOmniSong', {
        ref: track.ref || undefined,
        source: track.source || undefined,
        id: track.id || undefined,
      });
    });
    return btn;
  }

  // =========================================================================
  // Tab Switching
  // =========================================================================

  function setActiveTab(tab) {
    activeTab = tab;
    if (menuTabs) {
      menuTabs.querySelectorAll('.menu-tab').forEach((btn) => {
        const isCurrent = btn.getAttribute('data-tab') === tab;
        btn.classList.toggle('active', isCurrent);
        btn.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
      });
    }

    if (tab === 'search' && providers.length === 0) {
      bridge.sendPlaybackAction('refreshProviders');
    }
    if (tab === 'explore') {
      bridge.sendPlaybackAction('fetchExplore', { kind: 'overview' });
    }
    renderActiveTab();
  }

  if (menuTabs) {
    menuTabs.querySelectorAll('.menu-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        const nextTab = btn.getAttribute('data-tab');
        if (nextTab) setActiveTab(nextTab);
      });
    });
  }

  // =========================================================================
  // Tab 1: Play Queue View
  // =========================================================================

  function renderQueueView() {
    if (!viewToolbar || !viewSubbar || !viewContainer) return;

    viewSubbar.classList.add('hidden');
    viewSubbar.innerHTML = '';
    viewToolbar.classList.remove('hidden');

    const totalPages = Math.max(1, Math.ceil(queueState.total / queueState.pageSize));
    const currentPageDisplay = queueState.page + 1;

    viewToolbar.innerHTML = `
      <span class="count-badge">${queueState.total} 首</span>
      <div class="pagination-controls">
        <button id="qPrevBtn" class="page-nav-btn" type="button" title="上一页" ${queueState.page <= 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <span class="page-indicator">第 ${currentPageDisplay} / ${totalPages} 页</span>
        <button id="qNextBtn" class="page-nav-btn" type="button" title="下一页" ${queueState.page >= totalPages - 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
        <button id="qJumpActiveBtn" class="page-jump-btn" type="button" title="定位到正在播放的曲目" ${queueState.currentIndex < 0 ? 'disabled' : ''}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polygon points="10 8 16 12 10 16 10 8" fill="currentColor"></polygon>
          </svg>
        </button>
      </div>
    `;

    document.getElementById('qPrevBtn')?.addEventListener('click', () => {
      if (queueState.page > 0) {
        bridge.sendPlaybackAction('fetchQueuePage', { page: queueState.page - 1 });
      }
    });

    document.getElementById('qNextBtn')?.addEventListener('click', () => {
      const maxPage = Math.max(0, Math.ceil(queueState.total / queueState.pageSize) - 1);
      if (queueState.page < maxPage) {
        bridge.sendPlaybackAction('fetchQueuePage', { page: queueState.page + 1 });
      }
    });

    document.getElementById('qJumpActiveBtn')?.addEventListener('click', () => {
      lastAutoScrolledKey = '';
      bridge.sendPlaybackAction('jumpToActiveQueuePage');
    });

    if (!Array.isArray(queueState.items) || queueState.items.length === 0) {
      viewContainer.innerHTML = '<div class="list-empty">暂无播放队列</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';

    queueState.items.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = `list-item ${item.active ? 'active' : ''}`;
      const displayNumber = item.index !== undefined ? item.index + 1 : (queueState.page * queueState.pageSize + idx + 1);

      el.innerHTML = `
        <span class="list-item-index">${displayNumber}</span>
        <div class="list-item-info">
          <div class="list-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="list-item-subtitle" title="${escapeHtml(item.artist)}">${escapeHtml(item.artist)}</div>
        </div>
      `;

      if (isPortableOnline(item)) {
        const actions = document.createElement('div');
        actions.className = 'item-actions';
        actions.appendChild(createStarButton(item));
        el.appendChild(actions);
      }

      el.addEventListener('click', () => {
        bridge.sendPlaybackAction('playQueueIndex', {
          index: item.index !== undefined ? item.index : idx,
          ref: item.ref || undefined,
        });
      });

      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);

    const activeEl = list.querySelector('.list-item.active');
    const scrollKey = `${queueState.page}:${queueState.currentIndex}`;
    if (activeEl && scrollKey !== lastAutoScrolledKey) {
      lastAutoScrolledKey = scrollKey;
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // =========================================================================
  // Tab 2: Online Search & Source Switcher (folium.omni.searchSongs)
  // =========================================================================

  function getSearchableProviders() {
    return providers.filter((p) => p && p.configured && p.supports?.search);
  }

  function triggerOnlineSearch(append = false) {
    const q = searchDraft.trim();
    const providerId = selectedProviderId || '';
    bridge.sendPlaybackAction('searchOnlineSongs', {
      query: q,
      providerId,
      cursor: append ? (searchState.nextCursor || undefined) : undefined,
      append,
    });
  }

  function renderSearchView() {
    if (!viewToolbar || !viewSubbar || !viewContainer) return;

    viewToolbar.classList.remove('hidden');
    const existingInput = document.getElementById('omniSearchInput');
    if (!existingInput) {
      viewToolbar.innerHTML = `
        <div class="toolbar-search-wrap">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
            <circle cx="11" cy="11" r="7"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input id="omniSearchInput" class="toolbar-search-input" type="text" placeholder="搜索歌曲或艺人，回车搜索..." />
        </div>
        <button id="omniSearchBtn" class="mini-pill-btn primary" type="button">搜索</button>
      `;

      const input = document.getElementById('omniSearchInput');
      if (input) {
        input.value = searchDraft;
        input.addEventListener('compositionstart', () => { isComposingSearch = true; });
        input.addEventListener('compositionend', (e) => {
          isComposingSearch = false;
          searchDraft = e.target.value;
        });
        input.addEventListener('input', (e) => {
          searchDraft = e.target.value;
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !isComposingSearch) {
            e.preventDefault();
            triggerOnlineSearch(false);
          }
        });
      }
      document.getElementById('omniSearchBtn')?.addEventListener('click', () => {
        triggerOnlineSearch(false);
      });
    } else if (document.activeElement !== existingInput && existingInput.value !== searchDraft) {
      existingInput.value = searchDraft;
    }

    const searchable = getSearchableProviders();
    if (!selectedProviderId && searchable.length > 0) {
      const def = searchable.find((p) => p.selected) || searchable[0];
      selectedProviderId = def.providerId;
    }

    if (searchable.length > 0) {
      viewSubbar.classList.remove('hidden');
      viewSubbar.innerHTML = '';
      searchable.forEach((p) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `chip-btn ${selectedProviderId === p.providerId ? 'active' : ''}`;
        chip.textContent = p.shortName || p.displayName || p.providerId;
        chip.title = `切换到 ${p.displayName || p.providerId}`;
        chip.addEventListener('click', () => {
          if (selectedProviderId !== p.providerId) {
            selectedProviderId = p.providerId;
            renderSearchView();
            if (searchDraft.trim()) {
              triggerOnlineSearch(false);
            }
          }
        });
        viewSubbar.appendChild(chip);
      });
    } else {
      viewSubbar.classList.add('hidden');
      viewSubbar.innerHTML = '';
    }

    if (searchState.loading && searchState.items.length === 0) {
      viewContainer.innerHTML = '<div class="list-empty">正在搜索在线曲库...</div>';
      return;
    }

    if (searchState.error && searchState.items.length === 0) {
      viewContainer.innerHTML = `<div class="list-empty">${escapeHtml(searchState.error)}</div>`;
      return;
    }

    if (!searchState.query && searchState.items.length === 0) {
      viewContainer.innerHTML = '<div class="list-empty">输入歌名或歌手后回车，通过当前登录音源在线点播</div>';
      return;
    }

    if (searchState.items.length === 0) {
      viewContainer.innerHTML = '<div class="list-empty">未找到匹配歌曲</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';

    searchState.items.forEach((song) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.appendChild(createCoverElement(song.coverUrl, 'music'));

      const info = document.createElement('div');
      info.className = 'list-item-info';
      const sub = song.album ? `${song.artist} · ${song.album}` : song.artist;
      info.innerHTML = `
        <div class="list-item-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
        <div class="list-item-subtitle" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>
      `;
      el.appendChild(info);

      const durStr = formatDuration(song.duration);
      if (durStr) {
        const meta = document.createElement('span');
        meta.className = 'list-item-meta';
        meta.textContent = durStr;
        el.appendChild(meta);
      }

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.appendChild(createEnqueueButton(song));
      if (isPortableOnline(song)) {
        actions.appendChild(createStarButton(song));
      }
      el.appendChild(actions);

      el.addEventListener('click', () => {
        bridge.sendPlaybackAction('playOmniSong', {
          ref: song.ref || undefined,
          source: song.source || undefined,
          id: song.id || undefined,
        });
      });

      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);

    if (searchState.nextCursor) {
      const moreWrap = document.createElement('div');
      moreWrap.className = 'load-more-wrap';
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'mini-pill-btn';
      moreBtn.disabled = Boolean(searchState.loading);
      moreBtn.textContent = searchState.loading ? '加载中...' : '加载更多';
      moreBtn.addEventListener('click', () => triggerOnlineSearch(true));
      moreWrap.appendChild(moreBtn);
      viewContainer.appendChild(moreWrap);
    }
  }

  // =========================================================================
  // Tab 3: Current Song Album & Artist Explorer (folium.omni)
  // =========================================================================

  function openExploreCollection(col, targetKind = 'tracks') {
    if (!col) return;
    bridge.sendPlaybackAction('fetchExplore', {
      kind: targetKind,
      collectionRef: col.ref,
      source: col.source,
      id: col.id,
      collectionKind: col.kind,
    });
  }

  function renderExploreView() {
    if (!viewToolbar || !viewSubbar || !viewContainer) return;

    viewSubbar.classList.add('hidden');
    viewSubbar.innerHTML = '';
    viewToolbar.classList.remove('hidden');

    const data = exploreData;
    const isSubView = Boolean(data && (data.view !== 'overview' || data.canGoBack));

    viewToolbar.innerHTML = '';
    const left = document.createElement('div');
    left.className = 'toolbar-left';

    if (isSubView) {
      const backBtn = document.createElement('button');
      backBtn.type = 'button';
      backBtn.className = 'nav-back-btn';
      backBtn.title = '返回上一级';
      backBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>';
      backBtn.addEventListener('click', () => {
        bridge.sendPlaybackAction('exploreBack');
      });
      left.appendChild(backBtn);
    }

    const titleEl = document.createElement('span');
    titleEl.className = 'toolbar-title';
    if (!data || data.view === 'overview') {
      titleEl.textContent = data?.songTitle ? `当前曲目 · ${data.songTitle}` : '当前曲目关联目录';
    } else if (data.view === 'artistAlbums') {
      titleEl.textContent = `${data.collection?.name || '歌手'} · 专辑`;
    } else {
      titleEl.textContent = data.collection?.name || '曲目列表';
    }
    left.appendChild(titleEl);
    viewToolbar.appendChild(left);

    const right = document.createElement('div');
    right.className = 'toolbar-actions';

    if (data?.view === 'tracks' && Array.isArray(data.items) && data.items.length > 0) {
      const playAllBtn = document.createElement('button');
      playAllBtn.type = 'button';
      playAllBtn.className = 'mini-pill-btn primary';
      playAllBtn.textContent = '播放全部';
      playAllBtn.addEventListener('click', () => {
        bridge.sendPlaybackAction('replaceQueueWithTracks', { startIndex: 0 });
      });
      right.appendChild(playAllBtn);
    } else {
      const refreshBtn = document.createElement('button');
      refreshBtn.type = 'button';
      refreshBtn.className = 'mini-pill-btn';
      refreshBtn.textContent = '刷新';
      refreshBtn.addEventListener('click', () => {
        bridge.sendPlaybackAction('fetchExplore', { kind: 'overview' });
      });
      right.appendChild(refreshBtn);
    }
    viewToolbar.appendChild(right);

    if (!data || (data.loading && (!data.items || data.items.length === 0))) {
      viewContainer.innerHTML = '<div class="list-empty">正在获取当前曲目专辑与歌手信息...</div>';
      return;
    }

    if (data.error && (!data.items || data.items.length === 0) && !data.album && (!data.artists || data.artists.length === 0)) {
      viewContainer.innerHTML = `<div class="list-empty">${escapeHtml(data.error)}</div>`;
      return;
    }

    if (data.view === 'overview') {
      viewContainer.innerHTML = '';
      const grid = document.createElement('div');
      grid.className = 'category-grid';

      if (data.album) {
        const heading = document.createElement('div');
        heading.className = 'section-heading';
        heading.textContent = '所属专辑';
        grid.appendChild(heading);

        const card = document.createElement('div');
        card.className = 'category-card';
        card.appendChild(createCoverElement(data.album.coverUrl, 'music'));
        const info = document.createElement('div');
        info.className = 'card-info';
        const sub = [data.album.artist, data.album.trackCount ? `${data.album.trackCount} 首` : ''].filter(Boolean).join(' · ');
        info.innerHTML = `
          <div class="card-title">${escapeHtml(data.album.name)}</div>
          <div class="card-desc">${escapeHtml(sub || '查看专辑全部曲目')}</div>
        `;
        card.appendChild(info);
        card.addEventListener('click', () => openExploreCollection(data.album, 'tracks'));
        grid.appendChild(card);
      }

      if (Array.isArray(data.artists) && data.artists.length > 0) {
        const heading = document.createElement('div');
        heading.className = 'section-heading';
        heading.textContent = '关联歌手';
        grid.appendChild(heading);

        data.artists.forEach((artist) => {
          const card = document.createElement('div');
          card.className = 'category-card';
          card.appendChild(createCoverElement(artist.coverUrl, 'artist'));

          const info = document.createElement('div');
          info.className = 'card-info';
          info.innerHTML = `
            <div class="card-title">${escapeHtml(artist.name)}</div>
            <div class="card-desc">${artist.albumCount ? `${artist.albumCount} 张专辑` : '查看热门曲目与专辑'}</div>
          `;
          card.appendChild(info);

          const btns = document.createElement('div');
          btns.className = 'card-actions-inline';

          const songsBtn = document.createElement('button');
          songsBtn.type = 'button';
          songsBtn.className = 'mini-pill-btn';
          songsBtn.textContent = '热门';
          songsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openExploreCollection(artist, 'tracks');
          });
          btns.appendChild(songsBtn);

          const albumsBtn = document.createElement('button');
          albumsBtn.type = 'button';
          albumsBtn.className = 'mini-pill-btn';
          albumsBtn.textContent = '专辑';
          albumsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openExploreCollection(artist, 'artistAlbums');
          });
          btns.appendChild(albumsBtn);

          card.appendChild(btns);
          card.addEventListener('click', () => openExploreCollection(artist, 'tracks'));
          grid.appendChild(card);
        });
      }

      viewContainer.appendChild(grid);
      return;
    }

    if (data.view === 'artistAlbums') {
      const albums = Array.isArray(data.items) ? data.items : [];
      if (albums.length === 0) {
        viewContainer.innerHTML = '<div class="list-empty">暂无专辑列表</div>';
        return;
      }
      const list = document.createElement('div');
      list.className = 'dynamic-list';
      albums.forEach((alb) => {
        const el = document.createElement('div');
        el.className = 'list-item';
        el.appendChild(createCoverElement(alb.coverUrl, 'music'));
        const info = document.createElement('div');
        info.className = 'list-item-info';
        info.innerHTML = `
          <div class="list-item-title">${escapeHtml(alb.name)}</div>
          <div class="list-item-subtitle">${escapeHtml(alb.artist || (alb.trackCount ? `${alb.trackCount} 首` : '点击查看曲目'))}</div>
        `;
        el.appendChild(info);
        el.addEventListener('click', () => openExploreCollection(alb, 'tracks'));
        list.appendChild(el);
      });
      viewContainer.innerHTML = '';
      viewContainer.appendChild(list);

      if (data.nextCursor) {
        const moreWrap = document.createElement('div');
        moreWrap.className = 'load-more-wrap';
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'mini-pill-btn';
        moreBtn.disabled = Boolean(data.loading);
        moreBtn.textContent = data.loading ? '加载中...' : '加载更多专辑';
        moreBtn.addEventListener('click', () => {
          bridge.sendPlaybackAction('fetchExplore', {
            kind: 'artistAlbums',
            collectionRef: data.collection?.ref,
            source: data.collection?.source,
            id: data.collection?.id,
            collectionKind: data.collection?.kind,
            cursor: data.nextCursor,
            append: true,
          });
        });
        moreWrap.appendChild(moreBtn);
        viewContainer.appendChild(moreWrap);
      }
      return;
    }

    // data.view === 'tracks'
    const tracks = Array.isArray(data.items) ? data.items : [];
    if (tracks.length === 0) {
      viewContainer.innerHTML = '<div class="list-empty">暂无曲目</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';
    tracks.forEach((track, idx) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `
        <span class="list-item-index">${idx + 1}</span>
        <div class="list-item-info">
          <div class="list-item-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
          <div class="list-item-subtitle" title="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</div>
        </div>
      `;

      const durStr = formatDuration(track.duration);
      if (durStr) {
        const meta = document.createElement('span');
        meta.className = 'list-item-meta';
        meta.textContent = durStr;
        el.appendChild(meta);
      }

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.appendChild(createEnqueueButton(track));
      if (isPortableOnline(track)) {
        actions.appendChild(createStarButton(track));
      }
      el.appendChild(actions);

      el.addEventListener('click', () => {
        bridge.sendPlaybackAction('replaceQueueWithTracks', { startIndex: idx });
      });
      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);

    if (data.nextCursor) {
      const moreWrap = document.createElement('div');
      moreWrap.className = 'load-more-wrap';
      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'mini-pill-btn';
      moreBtn.disabled = Boolean(data.loading);
      moreBtn.textContent = data.loading ? '加载中...' : '加载更多曲目';
      moreBtn.addEventListener('click', () => {
        bridge.sendPlaybackAction('fetchExplore', {
          kind: 'tracks',
          collectionRef: data.collection?.ref,
          source: data.collection?.source,
          id: data.collection?.id,
          collectionKind: data.collection?.kind,
          cursor: data.nextCursor,
          append: true,
        });
      });
      moreWrap.appendChild(moreBtn);
      viewContainer.appendChild(moreWrap);
    }
  }

  // =========================================================================
  // Tab 4: Mod-Owned Quick Saved & Recent Tracks (folium.storage)
  // =========================================================================

  function renderSavedView() {
    if (!viewToolbar || !viewSubbar || !viewContainer) return;

    const listData = savedSubTab === 'recent' ? recentTracks : savedTracks;
    const canSaveCurrent = isPortableOnline(currentSong);
    const currentSaved = canSaveCurrent && isTrackSaved(currentSong.source, currentSong.id);

    viewToolbar.classList.remove('hidden');
    viewToolbar.innerHTML = '';

    const left = document.createElement('div');
    left.className = 'toolbar-left';
    const badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.textContent = `${listData.length} 首`;
    left.appendChild(badge);
    viewToolbar.appendChild(left);

    const right = document.createElement('div');
    right.className = 'toolbar-actions';

    if (savedSubTab === 'saved') {
      const saveCurrentBtn = document.createElement('button');
      saveCurrentBtn.type = 'button';
      saveCurrentBtn.className = 'mini-pill-btn';
      saveCurrentBtn.disabled = !canSaveCurrent;
      saveCurrentBtn.textContent = currentSaved ? '取消收藏当前' : '收藏当前曲目';
      saveCurrentBtn.addEventListener('click', () => {
        bridge.sendPlaybackAction('toggleSaveTrack');
      });
      right.appendChild(saveCurrentBtn);
    } else if (recentTracks.length > 0) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'mini-pill-btn';
      clearBtn.textContent = '清空历史';
      clearBtn.addEventListener('click', () => {
        bridge.sendPlaybackAction('clearRecentTracks');
      });
      right.appendChild(clearBtn);
    }

    if (listData.length > 0) {
      const playAllBtn = document.createElement('button');
      playAllBtn.type = 'button';
      playAllBtn.className = 'mini-pill-btn primary';
      playAllBtn.textContent = '播放全部';
      playAllBtn.addEventListener('click', () => {
        bridge.sendPlaybackAction('playAllStoredTracks', { list: savedSubTab, startIndex: 0 });
      });
      right.appendChild(playAllBtn);
    }
    viewToolbar.appendChild(right);

    viewSubbar.classList.remove('hidden');
    viewSubbar.innerHTML = '';
    [
      { id: 'saved', label: `快捷收藏 (${savedTracks.length})` },
      { id: 'recent', label: `最近播放 (${recentTracks.length})` },
    ].forEach((tabDef) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip-btn ${savedSubTab === tabDef.id ? 'active' : ''}`;
      chip.textContent = tabDef.label;
      chip.addEventListener('click', () => {
        savedSubTab = tabDef.id;
        renderSavedView();
      });
      viewSubbar.appendChild(chip);
    });

    if (listData.length === 0) {
      viewContainer.innerHTML = savedSubTab === 'saved'
        ? '<div class="list-empty">暂无快捷收藏<br/>点击上方「收藏当前曲目」或在队列/搜索中点击星标即可跨平台保存</div>'
        : '<div class="list-empty">暂无最近播放的在线曲目记录</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';

    listData.forEach((track, idx) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.appendChild(createCoverElement(track.coverUrl, 'music'));

      const info = document.createElement('div');
      info.className = 'list-item-info';
      const sub = track.album ? `${track.artist} · ${track.album}` : track.artist;
      info.innerHTML = `
        <div class="list-item-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
        <div class="list-item-subtitle" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>
      `;
      el.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'item-actions';
      actions.appendChild(createEnqueueButton(track));

      if (savedSubTab === 'saved') {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'row-icon-btn';
        delBtn.title = '移除收藏';
        delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          bridge.sendPlaybackAction('removeSavedTrack', { source: track.source, id: track.id });
        });
        actions.appendChild(delBtn);
      } else {
        actions.appendChild(createStarButton(track));
      }

      el.appendChild(actions);

      el.addEventListener('click', () => {
        bridge.sendPlaybackAction('playAllStoredTracks', {
          list: savedSubTab,
          startIndex: idx,
        });
      });

      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);
  }

  function renderActiveTab() {
    switch (activeTab) {
      case 'search':
        renderSearchView();
        break;
      case 'explore':
        renderExploreView();
        break;
      case 'saved':
        renderSavedView();
        break;
      case 'queue':
      default:
        renderQueueView();
        break;
    }
  }

  // =========================================================================
  // Footer Controls: Mode, Shuffle, Display Switch, Volume
  // =========================================================================

  function updateLoopMode(mode) {
    if (loopIconAll) loopIconAll.classList.add('hidden');
    if (loopIconOne) loopIconOne.classList.add('hidden');
    if (loopIconOff) loopIconOff.classList.add('hidden');

    switch (mode) {
      case 'one':
        if (loopIconOne) loopIconOne.classList.remove('hidden');
        if (loopModeLabel) loopModeLabel.textContent = '单曲循环';
        break;
      case 'off':
        if (loopIconOff) loopIconOff.classList.remove('hidden');
        if (loopModeLabel) loopModeLabel.textContent = '顺序播放';
        break;
      case 'all':
      default:
        if (loopIconAll) loopIconAll.classList.remove('hidden');
        if (loopModeLabel) loopModeLabel.textContent = '列表循环';
        break;
    }
  }

  function updateDisplayInfo(displayInfo) {
    if (!displayInfo || !displaySwitchBtn) return;
    const total = Number(displayInfo.totalDisplays) || 1;
    const activeIndex = Number(displayInfo.activeIndex) || 0;
    const isPrimary = Boolean(displayInfo.isPrimary);

    if (displaySwitchLabel) {
      if (total <= 1) {
        displaySwitchLabel.textContent = '主屏';
      } else {
        displaySwitchLabel.textContent = isPrimary ? `主屏 (${activeIndex + 1}/${total})` : `副屏 ${activeIndex + 1}`;
      }
    }

    displaySwitchBtn.title = total > 1
      ? `当前显示于 ${displayInfo.activeLabel || '主屏'}，点击切换到下一块屏幕`
      : '当前仅检测到 1 台显示器';
  }

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

  if (loopModeBtn) {
    loopModeBtn.addEventListener('click', () => {
      bridge.sendPlaybackAction('toggleLoopMode');
    });
  }

  if (shuffleBtn) {
    shuffleBtn.addEventListener('click', () => {
      bridge.sendPlaybackAction('shuffleQueue');
    });
  }

  if (displaySwitchBtn && typeof bridge.switchDisplay === 'function') {
    displaySwitchBtn.addEventListener('click', () => {
      bridge.switchDisplay();
    });
  }

  function updateLyricsDisplayControls() {
    const showGlobal = footerState.showLyrics !== false && footerState.lyricsVisible !== false;
    if (lyricsToggleBtn) {
      lyricsToggleBtn.classList.toggle('is-muted', !showGlobal);
      lyricsToggleBtn.setAttribute('aria-pressed', showGlobal ? 'true' : 'false');
      lyricsToggleBtn.title = showGlobal
        ? '点击隐藏任务栏歌词（仅显示歌名与作者）'
        : '点击恢复显示任务栏歌词';
    }
    if (lyricsEyeIcon) {
      lyricsEyeIcon.classList.toggle('hidden', !showGlobal);
    }
    if (lyricsEyeOffIcon) {
      lyricsEyeOffIcon.classList.toggle('hidden', showGlobal);
    }
  }

  if (lyricsToggleBtn) {
    lyricsToggleBtn.addEventListener('click', () => {
      bridge.sendPlaybackAction('toggleShowLyrics');
    });
  }

  function formatOffsetMs(ms) {
    const val = Math.round(Number(ms) || 0);
    if (val === 0) return '0ms';
    return val > 0 ? `+${val}ms` : `${val}ms`;
  }

  function updateOffsetControls() {
    const hasSong = Boolean(currentSong && (currentSong.id || currentSong.title));
    const songMs = Math.round(Number(footerState.songLyricOffsetMs) || 0);
    const globalMs = Math.round(Number(footerState.globalLyricOffsetMs) || 0);
    const totalMs = Math.round(Number(footerState.lyricOffsetMs) || (songMs + globalMs));

    if (offsetMinusBtn) offsetMinusBtn.disabled = !hasSong;
    if (offsetPlusBtn) offsetPlusBtn.disabled = !hasSong;
    if (offsetResetBtn) {
      offsetResetBtn.disabled = !hasSong || songMs === 0;
      offsetResetBtn.classList.toggle('has-offset', totalMs !== 0);
      if (globalMs !== 0 && songMs !== 0) {
        offsetResetBtn.textContent = `${formatOffsetMs(songMs)} (总${formatOffsetMs(totalMs)})`;
      } else if (globalMs !== 0) {
        offsetResetBtn.textContent = `总${formatOffsetMs(totalMs)}`;
      } else {
        offsetResetBtn.textContent = formatOffsetMs(songMs);
      }
      offsetResetBtn.title = !hasSong
        ? '当前无播放曲目'
        : `单曲 ${formatOffsetMs(songMs)} + 全局 ${formatOffsetMs(globalMs)} = 总计 ${formatOffsetMs(totalMs)}${songMs !== 0 ? '（点击重置当前曲目偏移）' : ''}`;
    }
  }

  if (offsetMinusBtn) {
    offsetMinusBtn.addEventListener('click', () => {
      if (!offsetMinusBtn.disabled) {
        bridge.sendPlaybackAction('adjustSongLyricOffset', -200);
      }
    });
  }

  if (offsetPlusBtn) {
    offsetPlusBtn.addEventListener('click', () => {
      if (!offsetPlusBtn.disabled) {
        bridge.sendPlaybackAction('adjustSongLyricOffset', 200);
      }
    });
  }

  if (offsetResetBtn) {
    offsetResetBtn.addEventListener('click', () => {
      if (!offsetResetBtn.disabled) {
        bridge.sendPlaybackAction('resetSongLyricOffset');
      }
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      bridge.sendPlaybackAction('toggleMute');
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('mousedown', () => {
      isDraggingSlider = true;
    });

    window.addEventListener('mouseup', () => {
      isDraggingSlider = false;
    });

    volumeSlider.addEventListener('input', (e) => {
      const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      if (volumePercent) volumePercent.textContent = `${val}%`;
    });

    volumeSlider.addEventListener('change', (e) => {
      isDraggingSlider = false;
      const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      if (volumePercent) volumePercent.textContent = `${val}%`;
      bridge.sendPlaybackAction('setVolume', val);
    });

    const volContainer = volumeSlider.closest('.volume-row');
    if (volContainer) {
      volContainer.addEventListener('wheel', (e) => {
        e.preventDefault();
        const step = e.deltaY < 0 ? 5 : -5;
        const currentVal = Number(volumeSlider.value) || 0;
        const nextVal = Math.max(0, Math.min(100, currentVal + step));
        volumeSlider.value = nextVal;
        if (volumePercent) volumePercent.textContent = `${nextVal}%`;
        if (wheelVolumeTimer) clearTimeout(wheelVolumeTimer);
        wheelVolumeTimer = setTimeout(() => {
          wheelVolumeTimer = null;
          bridge.sendPlaybackAction('setVolume', nextVal);
        }, 120);
      }, { passive: false });
    }
  }

  if (typeof bridge.onMenuClosed === 'function') {
    bridge.onMenuClosed(() => {
      isDraggingSlider = false;
      lastAutoScrolledKey = '';
      if (wheelVolumeTimer) {
        clearTimeout(wheelVolumeTimer);
        wheelVolumeTimer = null;
      }
    });
  }

  // =========================================================================
  // Snapshot Reception from Main Process
  // =========================================================================

  bridge.onSnapshot((data) => {
    if (!data) return;

    let shouldRender = false;

    if (data.theme) {
      applyTheme(data.theme);
    }

    if (data.displayInfo) {
      updateDisplayInfo(data.displayInfo);
    }

    if (data.song !== undefined) {
      const prevKey = portableKey(currentSong?.source, currentSong?.id);
      const nextKey = portableKey(data.song?.source, data.song?.id);
      currentSong = data.song;
      updateOffsetControls();
      updateLyricsDisplayControls();
      if (activeTab === 'saved') shouldRender = true;
      if (activeTab === 'explore' && prevKey !== nextKey && (!exploreData || exploreData.view === 'overview')) {
        bridge.sendPlaybackAction('fetchExplore', { kind: 'overview' });
      }
    }

    if (Array.isArray(data.providers)) {
      providers = data.providers;
      updateLyricsDisplayControls();
      if (activeTab === 'search') shouldRender = true;
    }

    if (data.searchState !== undefined && data.searchState !== null) {
      searchState = data.searchState;
      if (activeTab === 'search') shouldRender = true;
    }

    if (data.exploreData !== undefined && data.exploreData !== null) {
      exploreData = data.exploreData;
      if (activeTab === 'explore') shouldRender = true;
    }

    if (Array.isArray(data.savedTracks)) {
      savedTracks = data.savedTracks;
      shouldRender = true;
    }

    if (Array.isArray(data.recentTracks)) {
      recentTracks = data.recentTracks;
      if (activeTab === 'saved') shouldRender = true;
    }

    if (Array.isArray(data.queue)) {
      queueState.items = data.queue;
      if (typeof data.queueTotal === 'number') queueState.total = data.queueTotal;
      if (typeof data.queuePage === 'number') queueState.page = data.queuePage;
      if (typeof data.queuePageSize === 'number') queueState.pageSize = data.queuePageSize;
      if (typeof data.currentIndex === 'number') queueState.currentIndex = data.currentIndex;
      if (activeTab === 'queue') shouldRender = true;
    }

    if (typeof data.loopMode === 'string') {
      footerState.loopMode = data.loopMode;
      updateLoopMode(footerState.loopMode);
    }

    if (data.volume !== undefined || data.isMuted !== undefined) {
      if (typeof data.volume === 'number' && Number.isFinite(data.volume)) {
        footerState.volume = data.volume;
      }
      if (typeof data.isMuted === 'boolean') {
        footerState.isMuted = data.isMuted;
      }
      updateVolume(footerState.volume, footerState.isMuted);
    }

    if (
      data.lyricOffsetMs !== undefined
      || data.songLyricOffsetMs !== undefined
      || data.globalLyricOffsetMs !== undefined
    ) {
      if (typeof data.songLyricOffsetMs === 'number' && Number.isFinite(data.songLyricOffsetMs)) {
        footerState.songLyricOffsetMs = data.songLyricOffsetMs;
      }
      if (typeof data.globalLyricOffsetMs === 'number' && Number.isFinite(data.globalLyricOffsetMs)) {
        footerState.globalLyricOffsetMs = data.globalLyricOffsetMs;
      }
      if (typeof data.lyricOffsetMs === 'number' && Number.isFinite(data.lyricOffsetMs)) {
        footerState.lyricOffsetMs = data.lyricOffsetMs;
      } else {
        footerState.lyricOffsetMs = footerState.songLyricOffsetMs + footerState.globalLyricOffsetMs;
      }
      updateOffsetControls();
    }

    if (data.settings !== undefined || data.lyricsVisible !== undefined) {
      if (data.settings && typeof data.settings.showLyrics === 'boolean') {
        footerState.showLyrics = data.settings.showLyrics;
      }
      if (typeof data.lyricsVisible === 'boolean') {
        footerState.lyricsVisible = data.lyricsVisible;
      }
      updateLyricsDisplayControls();
    }

    if (shouldRender) {
      renderActiveTab();
    }
  });

  updateLyricsDisplayControls();
  updateOffsetControls();
  renderActiveTab();
})();
