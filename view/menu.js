// mods/taskbar-lyrics/view/menu.js
// Logic for taskbar lyrics floating menu: unified breadcrumbs navigation (书库 > 歌单 > 具体歌单 > 列表),
// live play queue with pagination, loop mode switching, complete music library, and volume controls.

(function () {
  'use strict';

  const bridge = window.taskbarBridge;
  if (!bridge) {
    console.error('TaskbarBridge not available in menu view');
    return;
  }

  // DOM Elements - Header Navigation
  const navBackBtn = document.getElementById('navBackBtn');
  const navCrumbs = document.getElementById('navCrumbs');
  const closeBtn = document.getElementById('closeBtn');

  // DOM Elements - Viewport & Toolbar
  const viewToolbar = document.getElementById('viewToolbar');
  const viewContainer = document.getElementById('viewContainer');

  // DOM Elements - Footer Controls
  const loopModeBtn = document.getElementById('loopModeBtn');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const loopIconAll = document.getElementById('loopIconAll');
  const loopIconOne = document.getElementById('loopIconOne');
  const loopIconOff = document.getElementById('loopIconOff');
  const loopModeLabel = document.getElementById('loopModeLabel');
  const muteBtn = document.getElementById('muteBtn');
  const volumeHighIcon = document.getElementById('volumeHighIcon');
  const volumeMuteIcon = document.getElementById('volumeMuteIcon');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumePercent = document.getElementById('volumePercent');

  let isDraggingSlider = false;

  // Navigation Stack:
  // Root: [] (displays 书库 categories)
  // Stack items: { type: 'queue' | 'category' | 'detail', category?: string, subtype?: string, item?: any, title: string }
  const navStack = [];

  // Data Caches
  let librarySummary = { playlistCount: 0, albumCount: 0, localSongCount: 0, radioCount: 3 };
  let currentCategoryItems = [];
  let currentRadioFeed = null;
  let currentDetailSongs = [];
  let songSearchQuery = '';
  let currentDetailId = '';

  const detailState = {
    page: 0,
    pageSize: 100,
  };

  const localState = {
    page: 0,
    pageSize: 100,
    total: 0,
    query: '',
  };

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
  };

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
    if (!Number.isFinite(sec) || sec <= 0) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // =========================================================================
  // Theme Synchronization with Dynamic Palette Derivation
  // =========================================================================

  function colorWithAlpha(colorStr, alpha) {
    if (!colorStr) return `rgba(255, 255, 255, ${alpha})`;
    let hex = String(colorStr).trim();
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) {
      const m = hex.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) {
        return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${alpha})`;
      }
    }
    if (hex.startsWith('#')) {
      hex = hex.slice(1);
    }
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
    if (hex.length >= 6) {
      const r = parseInt(hex.substring(0, 2), 16) || 0;
      const g = parseInt(hex.substring(2, 4), 16) || 0;
      const b = parseInt(hex.substring(4, 6), 16) || 0;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
    const accent = theme.accentColor || (isDaylight ? '#ea580c' : '#6366f1');

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
    rootStyle.setProperty('--badge-bg', colorWithAlpha(primary, isDaylight ? 0.07 : 0.10));
    rootStyle.setProperty('--text-primary', primary);
    rootStyle.setProperty('--text-secondary', secondary);
    rootStyle.setProperty('--text-tertiary', colorWithAlpha(secondary, 0.75));
    rootStyle.setProperty('--accent-color', accent);
    rootStyle.setProperty('--accent-glow', colorWithAlpha(accent, 0.45));
    rootStyle.setProperty('--accent-gradient', `linear-gradient(135deg, ${accent}, ${colorWithAlpha(accent, 0.8)})`);
    rootStyle.setProperty('--scrollbar-thumb', colorWithAlpha(primary, isDaylight ? 0.20 : 0.25));

    if (theme.fontFamily) {
      rootStyle.setProperty('--app-font-family', theme.fontFamily);
    }
  }

  // =========================================================================
  // Breadcrumb Navigation (书库 > 歌单 > 具体歌单 > 列表)
  // =========================================================================

  /**
   * Updates the unified breadcrumbs bar in the header.
   */
  function updateBreadcrumbs() {
    if (!navCrumbs) return;
    navCrumbs.innerHTML = '';

    const rootCrumb = document.createElement('span');
    rootCrumb.className = `crumb ${navStack.length === 0 ? 'active' : ''}`;
    rootCrumb.textContent = '书库';
    rootCrumb.title = '返回书库首页';
    rootCrumb.addEventListener('click', () => {
      if (navStack.length > 0) {
        navStack.length = 0;
        renderCurrentView();
      }
    });
    navCrumbs.appendChild(rootCrumb);

    navStack.forEach((entry, idx) => {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      navCrumbs.appendChild(sep);

      const isLast = idx === navStack.length - 1;
      const crumb = document.createElement('span');
      crumb.className = `crumb ${isLast ? 'active' : ''}`;
      crumb.textContent = entry.title;
      crumb.title = entry.title;

      if (!isLast) {
        crumb.addEventListener('click', () => {
          navStack.splice(idx + 1);
          renderCurrentView();
        });
      }
      navCrumbs.appendChild(crumb);
    });

    if (navBackBtn) {
      if (navStack.length > 0) {
        navBackBtn.classList.remove('hidden');
      } else {
        navBackBtn.classList.add('hidden');
      }
    }
  }

  if (navBackBtn) {
    navBackBtn.addEventListener('click', () => {
      if (navStack.length > 0) {
        navStack.pop();
        renderCurrentView();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      bridge.closeMenu();
    });
  }

  // =========================================================================
  // Main View Renderers
  // =========================================================================

  /**
   * Renders the current view based on the top element of navStack.
   */
  function renderCurrentView() {
    updateBreadcrumbs();

    if (navStack.length === 0) {
      currentDetailId = '';
      if (viewToolbar) {
        viewToolbar.removeAttribute('data-view');
        viewToolbar.classList.add('hidden');
      }
      renderRootCategories();
      return;
    }

    const top = navStack[navStack.length - 1];

    if (top.type === 'queue') {
      currentDetailId = '';
      if (viewToolbar) viewToolbar.removeAttribute('data-view');
      renderQueueView();
    } else if (top.type === 'category') {
      currentDetailId = '';
      if (top.category !== 'local' && viewToolbar) {
        viewToolbar.removeAttribute('data-view');
      }
      renderCategoryView(top.category);
    } else if (top.type === 'detail') {
      renderSongDetailView(top);
    }
  }

  // -------------------------------------------------------------------------
  // 1. Root Level: 书库 Categories
  // -------------------------------------------------------------------------

  let lastLibraryFetchTime = 0;
  function triggerLibrarySummaryFetch(force = false) {
    const now = Date.now();
    if (force || now - lastLibraryFetchTime > 4000) {
      lastLibraryFetchTime = now;
      bridge.sendPlaybackAction('fetchLibrarySummary');
    }
  }

  function updateRootCategoryBadges() {
    const bQueue = document.getElementById('badgeQueue');
    if (bQueue) bQueue.textContent = `${queueState.total || 0} 首`;
    const bPlaylists = document.getElementById('badgePlaylists');
    if (bPlaylists) bPlaylists.textContent = `${librarySummary.playlistCount || 0} 个`;
    const bAlbums = document.getElementById('badgeAlbums');
    if (bAlbums) bAlbums.textContent = `${librarySummary.albumCount || 0} 张`;
    const bLocal = document.getElementById('badgeLocal');
    if (bLocal) bLocal.textContent = `${librarySummary.localSongCount || 0} 首`;
    const bRadio = document.getElementById('badgeRadio');
    if (bRadio) bRadio.textContent = '3 项';
  }

  function renderRootCategories() {
    if (viewToolbar) viewToolbar.classList.add('hidden');
    if (!viewContainer) return;

    triggerLibrarySummaryFetch();

    viewContainer.innerHTML = `
      <div class="category-grid">
        <!-- 1. 播放队列 -->
        <div class="category-card" data-action="queue">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <line x1="8" y1="6" x2="21" y2="6"></line>
              <line x1="8" y1="12" x2="21" y2="12"></line>
              <line x1="8" y1="18" x2="21" y2="18"></line>
              <line x1="3" y1="6" x2="3.01" y2="6"></line>
              <line x1="3" y1="12" x2="3.01" y2="12"></line>
              <line x1="3" y1="18" x2="3.01" y2="18"></line>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">播放队列</div>
            <div class="card-desc">当前播放中的曲目列表</div>
          </div>
          <span class="card-badge" id="badgeQueue">${queueState.total || 0} 首</span>
          <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>

        <!-- 2. 歌单 -->
        <div class="category-card" data-action="playlists">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5l12-2v13"></path>
              <circle cx="6" cy="18" r="3"></circle>
              <circle cx="18" cy="16" r="3"></circle>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">歌单</div>
            <div class="card-desc">收藏与自建的在线及本地歌单</div>
          </div>
          <span class="card-badge" id="badgePlaylists">${librarySummary.playlistCount || 0} 个</span>
          <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>

        <!-- 3. 电台 -->
        <div class="category-card" data-action="radio">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="2"></circle>
              <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">电台 / FM</div>
            <div class="card-desc">私人 FM · 每日推荐 · 推荐歌单</div>
          </div>
          <span class="card-badge" id="badgeRadio">3 项</span>
          <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>

        <!-- 4. 专辑 -->
        <div class="category-card" data-action="albums">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">专辑</div>
            <div class="card-desc">收藏与归档的音乐专辑</div>
          </div>
          <span class="card-badge" id="badgeAlbums">${librarySummary.albumCount || 0} 张</span>
          <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>

        <!-- 5. 本地音乐 -->
        <div class="category-card" data-action="local">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">本地音乐</div>
            <div class="card-desc">设备已扫描导入的全部曲目</div>
          </div>
          <span class="card-badge" id="badgeLocal">${librarySummary.localSongCount || 0} 首</span>
          <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>
      </div>
    `;

    viewContainer.querySelectorAll('.category-card').forEach((card) => {
      card.addEventListener('click', () => {
        const action = card.getAttribute('data-action');
        if (action === 'queue') {
          navStack.push({ type: 'queue', title: '播放队列' });
        } else if (action === 'playlists') {
          navStack.push({ type: 'category', category: 'playlists', title: '歌单' });
          bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'playlists' });
        } else if (action === 'radio') {
          navStack.push({ type: 'category', category: 'radio', title: '电台' });
          bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'radio' });
        } else if (action === 'albums') {
          navStack.push({ type: 'category', category: 'albums', title: '专辑' });
          bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'albums' });
        } else if (action === 'local') {
          navStack.push({ type: 'category', category: 'local', title: '本地音乐' });
          bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'local' });
        }
        renderCurrentView();
      });
    });
  }

  // -------------------------------------------------------------------------
  // 2. Play Queue View (With Pagination)
  // -------------------------------------------------------------------------

  function renderQueueView() {
    if (!viewToolbar || !viewContainer) return;

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
        <button id="qJumpActiveBtn" class="page-jump-btn" type="button" title="定位到正在播放的曲目">
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
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Category Level Views (Playlists, Albums, Radio, Local)
  // -------------------------------------------------------------------------

  function renderCategoryView(category) {
    if (viewToolbar) viewToolbar.classList.add('hidden');
    if (!viewContainer) return;

    if (category === 'playlists') {
      renderPlaylistsList();
    } else if (category === 'recommendations') {
      if (!currentRadioFeed || !currentRadioFeed.recommendedCollections || currentRadioFeed.recommendedCollections.length === 0) {
        bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'radio' });
      }
      currentCategoryItems = currentRadioFeed?.recommendedCollections || [];
      renderPlaylistsList();
    } else if (category === 'albums') {
      renderAlbumsList();
    } else if (category === 'radio') {
      renderRadioHub();
    } else if (category === 'local') {
      renderLocalSongsList();
    }
  }

  // Playlists List
  function renderPlaylistsList() {
    if (!Array.isArray(currentCategoryItems) || currentCategoryItems.length === 0) {
      viewContainer.innerHTML = '<div class="list-empty">正在加载歌单...</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';

    currentCategoryItems.forEach((pl) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `
        <div class="list-item-cover">
          ${pl.coverUrl ? `<img src="${escapeHtml(pl.coverUrl)}" alt="" />` : `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>
            </svg>
          `}
        </div>
        <div class="list-item-info">
          <div class="list-item-title">${escapeHtml(pl.name)}</div>
          <div class="list-item-subtitle">${pl.songCount || 0} 首歌曲${pl.isLiked ? ' · 我喜欢' : ''}</div>
        </div>
        <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
      `;

      el.addEventListener('click', () => {
        navStack.push({
          type: 'detail',
          subtype: 'playlist',
          item: pl,
          title: pl.name,
        });
        currentDetailSongs = [];
        bridge.sendPlaybackAction('fetchLibraryPlaylistDetail', { playlist: pl });
        renderCurrentView();
      });

      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);
  }

  // Albums List
  function renderAlbumsList() {
    if (!Array.isArray(currentCategoryItems) || currentCategoryItems.length === 0) {
      viewContainer.innerHTML = '<div class="list-empty">正在加载专辑...</div>';
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';

    currentCategoryItems.forEach((alb) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.innerHTML = `
        <div class="list-item-cover">
          ${alb.coverUrl ? `<img src="${escapeHtml(alb.coverUrl)}" alt="" />` : `
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2">
              <circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle>
            </svg>
          `}
        </div>
        <div class="list-item-info">
          <div class="list-item-title">${escapeHtml(alb.name)}</div>
          <div class="list-item-subtitle">${escapeHtml(alb.artist || '未知艺人')} · ${alb.songCount || 0} 首</div>
        </div>
        <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
      `;

      el.addEventListener('click', () => {
        navStack.push({
          type: 'detail',
          subtype: 'album',
          item: alb,
          title: alb.name,
        });
        currentDetailSongs = [];
        bridge.sendPlaybackAction('fetchLibraryAlbumDetail', { album: alb });
        renderCurrentView();
      });

      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);
  }

  // Radio Hub (Personal FM, Daily Recommendations, Recommended Playlists)
  function renderRadioHub() {
    viewContainer.innerHTML = `
      <div class="category-grid">
        <!-- 1. 私人 FM -->
        <div class="category-card" data-radio="fm">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" fill="currentColor"></polygon>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">私人 FM</div>
            <div class="card-desc">基于偏好随心推荐，点击立即播放</div>
          </div>
          <span class="card-badge">随心听</span>
        </div>

        <!-- 2. 每日推荐 -->
        <div class="category-card" data-radio="daily">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
              <line x1="16" y1="2" x2="16" y2="6"></line>
              <line x1="8" y1="2" x2="8" y2="6"></line>
              <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">每日推荐</div>
            <div class="card-desc">为你定制的今日曲目 (每日 6 点更新)</div>
          </div>
          <span class="card-badge">${currentRadioFeed?.dailyCount || 30} 首</span>
          <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>

        <!-- 3. 推荐歌单 -->
        <div class="category-card" data-radio="recommendations">
          <div class="card-icon-wrap">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 18V5l12-2v13"></path>
              <circle cx="6" cy="18" r="3"></circle>
              <circle cx="18" cy="16" r="3"></circle>
            </svg>
          </div>
          <div class="card-info">
            <div class="card-title">推荐歌单</div>
            <div class="card-desc">精选热门与特色歌单合集</div>
          </div>
          <span class="card-badge">${currentRadioFeed?.recommendedPlaylistsCount || 0} 个</span>
          <svg class="card-arrow" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </div>
      </div>
    `;

    viewContainer.querySelectorAll('.category-card').forEach((card) => {
      card.addEventListener('click', () => {
        const type = card.getAttribute('data-radio');
        if (type === 'fm') {
          bridge.sendPlaybackAction('playRadioFm');
          bridge.closeMenu();
        } else if (type === 'daily') {
          const top = navStack[navStack.length - 1];
          if (top?.type === 'detail' && top?.subtype === 'daily_songs') {
            return;
          }
          navStack.push({
            type: 'detail',
            subtype: 'daily_songs',
            title: '每日推荐',
          });
          currentDetailSongs = currentRadioFeed?.dailySongs || [];
          renderCurrentView();
        } else if (type === 'recommendations') {
          const top = navStack[navStack.length - 1];
          if (top?.type === 'category' && top?.category === 'recommendations') {
            return;
          }
          navStack.push({
            type: 'category',
            category: 'recommendations',
            title: '推荐歌单',
          });
          if (!currentRadioFeed || !currentRadioFeed.recommendedCollections || currentRadioFeed.recommendedCollections.length === 0) {
            bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'radio' });
          }
          currentCategoryItems = currentRadioFeed?.recommendedCollections || [];
          renderCurrentView();
        }
      });
    });
  }

  // Local Songs List (Paginated 100/page with persistent search input)
  function renderLocalSongsList() {
    if (!viewToolbar || !viewContainer) return;

    viewToolbar.classList.remove('hidden');
    const totalPages = Math.max(1, Math.ceil(localState.total / localState.pageSize));
    const currentPageDisplay = localState.page + 1;

    if (viewToolbar.getAttribute('data-view') !== 'local') {
      viewToolbar.setAttribute('data-view', 'local');
      viewToolbar.innerHTML = `
        <div class="toolbar-search-wrap">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input id="localSearchInput" class="toolbar-search-input" type="text" placeholder="过滤本地歌曲或艺人..." value="${escapeHtml(localState.query)}" />
        </div>
        <div class="pagination-controls">
          <button id="localPrevBtn" class="page-nav-btn" type="button" title="上一页" ${localState.page <= 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <span id="localPageIndicator" class="page-indicator">第 ${currentPageDisplay} / ${totalPages} 页</span>
          <button id="localNextBtn" class="page-nav-btn" type="button" title="下一页" ${localState.page >= totalPages - 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>
        <span id="localCountBadge" class="count-badge">${localState.total || currentCategoryItems.length || 0} 首</span>
      `;

      const input = document.getElementById('localSearchInput');
      if (input) {
        let debounce = null;
        input.addEventListener('input', (e) => {
          localState.query = e.target.value || '';
          localState.page = 0;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => {
            bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'local', page: 0, query: localState.query });
          }, 250);
        });
      }

      document.getElementById('localPrevBtn')?.addEventListener('click', () => {
        if (localState.page > 0) {
          bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'local', page: localState.page - 1, query: localState.query });
        }
      });

      document.getElementById('localNextBtn')?.addEventListener('click', () => {
        const maxPage = Math.max(0, Math.ceil(localState.total / localState.pageSize) - 1);
        if (localState.page < maxPage) {
          bridge.sendPlaybackAction('fetchLibraryCategory', { category: 'local', page: localState.page + 1, query: localState.query });
        }
      });
    } else {
      const indicator = document.getElementById('localPageIndicator');
      if (indicator) indicator.textContent = `第 ${currentPageDisplay} / ${totalPages} 页`;
      const prevBtn = document.getElementById('localPrevBtn');
      if (prevBtn) prevBtn.disabled = localState.page <= 0;
      const nextBtn = document.getElementById('localNextBtn');
      if (nextBtn) nextBtn.disabled = localState.page >= totalPages - 1;
      const badge = document.getElementById('localCountBadge');
      if (badge) badge.textContent = `${localState.total || currentCategoryItems.length || 0} 首`;
      const input = document.getElementById('localSearchInput');
      if (input && document.activeElement !== input && input.value !== localState.query) {
        input.value = localState.query;
      }
    }

    if (!Array.isArray(currentCategoryItems) || currentCategoryItems.length === 0) {
      viewContainer.innerHTML = `<div class="list-empty">${localState.query ? '未找到匹配的本地歌曲' : '暂无本地音乐'}</div>`;
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';

    currentCategoryItems.forEach((song, idx) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      const displayNumber = localState.page * localState.pageSize + idx + 1;
      el.innerHTML = `
        <span class="list-item-index">${displayNumber}</span>
        <div class="list-item-info">
          <div class="list-item-title">${escapeHtml(song.title)}</div>
          <div class="list-item-subtitle">${escapeHtml(song.artist)}${song.album ? ` · ${escapeHtml(song.album)}` : ''}</div>
        </div>
        <div class="list-item-meta">${formatDuration(song.duration)}</div>
      `;

      el.addEventListener('click', () => {
        bridge.sendPlaybackAction('playLibrarySong', { song, queueContext: currentCategoryItems });
      });

      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);
  }

  // -------------------------------------------------------------------------
  // 4. Detail View: Song List (100 per page, persistent search input)
  // -------------------------------------------------------------------------

  function getFilteredDetailSongs() {
    if (!songSearchQuery || !songSearchQuery.trim()) return currentDetailSongs;
    const q = songSearchQuery.trim().toLowerCase();
    return currentDetailSongs.filter((s) => {
      const title = (s.title || '').toLowerCase();
      const artist = (s.artist || '').toLowerCase();
      const album = (s.album || '').toLowerCase();
      return title.includes(q) || artist.includes(q) || album.includes(q);
    });
  }

  function renderSongDetailView(top) {
    if (!viewToolbar || !viewContainer) return;

    const currentTop = (navStack.length > 0 && navStack[navStack.length - 1].type === 'detail')
      ? navStack[navStack.length - 1]
      : top;

    const detailId = `${currentTop.subtype || currentTop.type}:${currentTop.item?.id || currentTop.title || ''}`;
    if (currentDetailId !== detailId) {
      currentDetailId = detailId;
      detailState.page = 0;
      songSearchQuery = '';
      if (viewToolbar) viewToolbar.removeAttribute('data-view');
    }

    const filteredSongs = getFilteredDetailSongs();
    const pageSize = detailState.pageSize; // 100
    const total = filteredSongs.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (detailState.page >= totalPages) {
      detailState.page = Math.max(0, totalPages - 1);
    }
    const currentPageDisplay = detailState.page + 1;
    const pageStart = detailState.page * pageSize;
    const songsOnPage = filteredSongs.slice(pageStart, pageStart + pageSize);

    viewToolbar.classList.remove('hidden');

    if (viewToolbar.getAttribute('data-view') !== 'detail') {
      viewToolbar.setAttribute('data-view', 'detail');
      viewToolbar.innerHTML = `
        <div class="toolbar-search-wrap">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input id="detailSearchInput" class="toolbar-search-input" type="text" placeholder="过滤当前列表歌曲..." value="${escapeHtml(songSearchQuery)}" />
        </div>
        <div class="pagination-controls">
          <button id="detailPrevBtn" class="page-nav-btn" type="button" title="上一页" ${detailState.page <= 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
          </button>
          <span id="detailPageIndicator" class="page-indicator">第 ${currentPageDisplay} / ${totalPages} 页</span>
          <button id="detailNextBtn" class="page-nav-btn" type="button" title="下一页" ${detailState.page >= totalPages - 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>
        <span id="detailCountBadge" class="count-badge">${total} 首</span>
      `;

      const input = document.getElementById('detailSearchInput');
      if (input) {
        input.addEventListener('input', (e) => {
          songSearchQuery = e.target.value || '';
          detailState.page = 0;
          const active = (navStack.length > 0 && navStack[navStack.length - 1].type === 'detail')
            ? navStack[navStack.length - 1]
            : currentTop;
          renderSongDetailView(active);
        });
      }

      document.getElementById('detailPrevBtn')?.addEventListener('click', () => {
        if (detailState.page > 0) {
          detailState.page -= 1;
          const active = (navStack.length > 0 && navStack[navStack.length - 1].type === 'detail')
            ? navStack[navStack.length - 1]
            : currentTop;
          renderSongDetailView(active);
          viewContainer.scrollTop = 0;
        }
      });

      document.getElementById('detailNextBtn')?.addEventListener('click', () => {
        const songs = getFilteredDetailSongs();
        const maxPage = Math.max(0, Math.ceil(songs.length / detailState.pageSize) - 1);
        if (detailState.page < maxPage) {
          detailState.page += 1;
          const active = (navStack.length > 0 && navStack[navStack.length - 1].type === 'detail')
            ? navStack[navStack.length - 1]
            : currentTop;
          renderSongDetailView(active);
          viewContainer.scrollTop = 0;
        }
      });
    } else {
      const indicator = document.getElementById('detailPageIndicator');
      if (indicator) indicator.textContent = `第 ${currentPageDisplay} / ${totalPages} 页`;
      const prevBtn = document.getElementById('detailPrevBtn');
      if (prevBtn) prevBtn.disabled = detailState.page <= 0;
      const nextBtn = document.getElementById('detailNextBtn');
      if (nextBtn) nextBtn.disabled = detailState.page >= totalPages - 1;
      const badge = document.getElementById('detailCountBadge');
      if (badge) badge.textContent = `${total} 首`;
      const input = document.getElementById('detailSearchInput');
      if (input && document.activeElement !== input && input.value !== songSearchQuery) {
        input.value = songSearchQuery;
      }
    }

    if (!Array.isArray(songsOnPage) || songsOnPage.length === 0) {
      viewContainer.innerHTML = `<div class="list-empty">${songSearchQuery ? '没有找到匹配的歌曲' : '正在加载或列表中无歌曲'}</div>`;
      return;
    }

    const list = document.createElement('div');
    list.className = 'dynamic-list';

    songsOnPage.forEach((song, idx) => {
      const el = document.createElement('div');
      el.className = 'list-item';
      const displayNumber = pageStart + idx + 1;
      el.innerHTML = `
        <span class="list-item-index">${displayNumber}</span>
        <div class="list-item-info">
          <div class="list-item-title" title="${escapeHtml(song.title)}">${escapeHtml(song.title)}</div>
          <div class="list-item-subtitle" title="${escapeHtml(song.artist)}">${escapeHtml(song.artist)}${song.album ? ` · ${escapeHtml(song.album)}` : ''}</div>
        </div>
        <div class="list-item-meta">${formatDuration(song.duration)}</div>
      `;

      el.addEventListener('click', () => {
        bridge.sendPlaybackAction('playLibrarySong', { song, queueContext: filteredSongs });
      });

      list.appendChild(el);
    });

    viewContainer.innerHTML = '';
    viewContainer.appendChild(list);
  }

  // =========================================================================
  // Footer Controls: Mode, Shuffle, Volume
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

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      bridge.sendPlaybackAction('toggleMute');
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('mousedown', () => {
      isDraggingSlider = true;
    });

    volumeSlider.addEventListener('mouseup', () => {
      isDraggingSlider = false;
    });

    volumeSlider.addEventListener('input', (e) => {
      const val = Math.max(0, Math.min(100, Number(e.target.value) || 0));
      if (volumePercent) volumePercent.textContent = `${val}%`;
    });

    volumeSlider.addEventListener('change', (e) => {
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
        bridge.sendPlaybackAction('setVolume', nextVal);
      }, { passive: false });
    }
  }

  // =========================================================================
  // Snapshot Reception from Main Process
  // =========================================================================

  bridge.onSnapshot((data) => {
    if (!data) return;

    // 1. Synchronized Folia Theme
    if (data.theme) {
      applyTheme(data.theme);
    }

    // 2. Queue & Pagination
    if (Array.isArray(data.queue)) {
      queueState.items = data.queue;
      if (typeof data.queueTotal === 'number') queueState.total = data.queueTotal;
      if (typeof data.queuePage === 'number') queueState.page = data.queuePage;
      if (typeof data.queuePageSize === 'number') queueState.pageSize = data.queuePageSize;
      if (typeof data.currentIndex === 'number') queueState.currentIndex = data.currentIndex;

      if (navStack.length > 0 && navStack[navStack.length - 1].type === 'queue') {
        renderQueueView();
      } else if (navStack.length === 0) {
        updateRootCategoryBadges();
      }
    }

    // 3. Library Summary Data
    if (data.librarySummary) {
      librarySummary = { ...librarySummary, ...data.librarySummary };
      if (navStack.length === 0) {
        updateRootCategoryBadges();
      }
    }

    // 4. Library Category Data
    if (data.libraryCategoryData) {
      if (data.libraryCategoryData.radioFeed) {
        currentRadioFeed = data.libraryCategoryData.radioFeed;
        if (navStack.length > 0 && navStack[navStack.length - 1].category === 'recommendations') {
          currentCategoryItems = currentRadioFeed?.recommendedCollections || [];
        }
      }
      if (data.libraryCategoryData.category === 'local') {
        if (typeof data.libraryCategoryData.total === 'number') localState.total = data.libraryCategoryData.total;
        if (typeof data.libraryCategoryData.page === 'number') localState.page = data.libraryCategoryData.page;
        if (typeof data.libraryCategoryData.pageSize === 'number') localState.pageSize = data.libraryCategoryData.pageSize;
      }
      if (Array.isArray(data.libraryCategoryData.items)) {
        currentCategoryItems = data.libraryCategoryData.items;
      }
      if (navStack.length > 0 && navStack[navStack.length - 1].type === 'category') {
        renderCategoryView(navStack[navStack.length - 1].category);
      }
    }

    // 5. Library Detail Data (Songs inside a playlist or album)
    if (data.libraryDetailData) {
      currentDetailSongs = data.libraryDetailData.songs || [];
      if (navStack.length > 0 && navStack[navStack.length - 1].type === 'detail') {
        renderSongDetailView(navStack[navStack.length - 1]);
      }
    }

    // 6. Loop Mode
    if (typeof data.loopMode === 'string') {
      footerState.loopMode = data.loopMode;
      updateLoopMode(footerState.loopMode);
    }

    // 7. Volume
    if (data.volume !== undefined || data.isMuted !== undefined) {
      if (typeof data.volume === 'number' && Number.isFinite(data.volume)) {
        footerState.volume = data.volume;
      }
      if (typeof data.isMuted === 'boolean') {
        footerState.isMuted = data.isMuted;
      }
      updateVolume(footerState.volume, footerState.isMuted);
    }
  });

  // Default start: Open in 播放队列 (or 书库)
  // Initially show 播放队列 so user can immediately see and control live queue,
  // with '书库' clickable in the breadcrumb bar to reach the 5 main categories!
  navStack.push({ type: 'queue', title: '播放队列' });
  renderCurrentView();
})();
