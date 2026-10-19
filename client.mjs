// mods/taskbar-lyrics/client.mjs
// Renderer ESM entry for the Taskbar Lyrics Drawer mod.
// Listens to Folia playback, lyric, and theme events, synchronizes snapshots with the main process,
// dispatches user playback controls, manages pagination & complete library navigation (Online/Local Playlists, Albums, Radio),
// and registers mod settings.
// Note: Supported exclusively on Windows (win32).

'use strict';

/**
 * Taskbar Lyrics Client Entry
 * @param {import('../../src/mods/folium/contract').FoliumClientApi} folium
 */
export default function activate(folium) {
  // Enforce Windows platform limitation
  if (typeof process !== 'undefined' && process.platform && process.platform !== 'win32') {
    return () => {};
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Windows')) {
    return () => {};
  }

  folium.log.info(`Taskbar Lyrics Drawer client activating for mod ${folium.modId}`);

  // Feature detection: Folium 1.5+ provides native volume, loop mode and queue controls
  const hasPlaybackControls = (folium.host?.folium?.minor ?? 0) >= 5;
  const QUEUE_PAGE_SIZE = 50;
  let currentQueuePageIndex = 0;

  let currentSnapshot = {
    song: null,
    playerState: 'paused',
    currentTime: 0,
    duration: 0,
    lyricOffsetMs: 0,
    updatedAt: Date.now(),
    lyrics: null,
    queue: [],
    queueTotal: 0,
    queuePage: 0,
    queuePageSize: QUEUE_PAGE_SIZE,
    currentIndex: -1,
    loopMode: 'all',
    volume: 100,
    isMuted: false,
    theme: null,
    librarySummary: null,
    libraryCategoryData: null,
    libraryDetailData: null,
    settings: {
      showTranslation: true,
      useCoverBackground: true,
    },
    hasPlaybackControls,
  };

  function normalizePlayerState(raw) {
    if (!raw) return 'paused';
    const s = String(raw).toLowerCase();
    return (s === 'playing' || s === '1') ? 'playing' : 'paused';
  }

  /**
   * Pushes snapshot delta to the main process via Folium RPC.
   * Avoids transmitting full lyrics on lightweight progress ticks.
   * @param {object} delta Fields to merge and synchronize.
   */
  async function pushSnapshot(delta = {}) {
    try {
      currentSnapshot = {
        ...currentSnapshot,
        ...delta,
        updatedAt: delta.updatedAt || Date.now(),
      };
      await folium.rpc.call('syncSnapshot', delta);
    } catch {
      // Ignored if main process is unavailable or shutting down
    }
  }

  let cachedLiveTheme = null;

  /**
   * Resolves the active Folia theme including daylight/dark mode and palette colors.
   */
  function resolveCurrentTheme() {
    try {
      let isDaylight = false;
      const tStore = folium.internals?.stores?.themeSettings;
      if (tStore?.getState) {
        isDaylight = Boolean(tStore.getState().isDaylight);
      } else if (typeof localStorage !== 'undefined') {
        isDaylight = localStorage.getItem('default_theme_daylight') === 'true';
      }

      if (cachedLiveTheme) {
        return {
          ...cachedLiveTheme,
          isDaylight,
        };
      }

      let customDualTheme = null;
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('custom_dual_theme');
        if (saved) {
          try {
            customDualTheme = JSON.parse(saved);
          } catch {}
        }
      }

      if (customDualTheme) {
        const themeObj = isDaylight ? customDualTheme.light : customDualTheme.dark;
        if (themeObj && typeof themeObj === 'object' && themeObj.backgroundColor) {
          return {
            name: themeObj.name || (isDaylight ? 'Theme Park Light' : 'Theme Park Dark'),
            backgroundColor: themeObj.backgroundColor || (isDaylight ? '#f5f5f4' : '#09090b'),
            primaryColor: themeObj.primaryColor || (isDaylight ? '#1c1917' : '#f4f4f5'),
            accentColor: themeObj.accentColor || (isDaylight ? '#ea580c' : '#6366f1'),
            secondaryColor: themeObj.secondaryColor || (isDaylight ? '#44403c' : '#71717a'),
            fontStyle: themeObj.fontStyle || 'sans',
            fontFamily: themeObj.fontFamily || undefined,
            isDaylight,
          };
        }
      }

      if (isDaylight) {
        return {
          name: 'Daylight Default',
          backgroundColor: '#f5f5f4',
          primaryColor: '#1c1917',
          accentColor: '#ea580c',
          secondaryColor: '#44403c',
          fontStyle: 'sans',
          isDaylight: true,
        };
      } else {
        return {
          name: 'Midnight Default',
          backgroundColor: '#09090b',
          primaryColor: '#f4f4f5',
          accentColor: '#6366f1',
          secondaryColor: '#71717a',
          fontStyle: 'sans',
          isDaylight: false,
        };
      }
    } catch {
      return {
        name: 'Default',
        backgroundColor: '#09090b',
        primaryColor: '#f4f4f5',
        accentColor: '#6366f1',
        secondaryColor: '#71717a',
        fontStyle: 'sans',
        isDaylight: false,
      };
    }
  }

  async function initThemeFromStorage() {
    try {
      let isDaylight = false;
      const tStore = folium.internals?.stores?.themeSettings;
      if (tStore?.getState) {
        isDaylight = Boolean(tStore.getState().isDaylight);
      } else if (typeof localStorage !== 'undefined') {
        isDaylight = localStorage.getItem('default_theme_daylight') === 'true';
      }

      const pointer = typeof localStorage !== 'undefined' ? localStorage.getItem('last_applied_theme_pointer') : null;
      if (pointer === 'ai') {
        const dualAi = await readUserCacheKey('last_dual_theme');
        if (dualAi) {
          const side = isDaylight ? dualAi.light : dualAi.dark;
          if (side && side.backgroundColor) {
            cachedLiveTheme = {
              name: side.name || (isDaylight ? 'AI Theme Light' : 'AI Theme Dark'),
              backgroundColor: side.backgroundColor,
              primaryColor: side.primaryColor,
              accentColor: side.accentColor,
              secondaryColor: side.secondaryColor,
              fontFamily: side.fontFamily,
              fontStyle: side.fontStyle,
              isDaylight,
            };
            currentSnapshot.theme = cachedLiveTheme;
            void pushSnapshot({ theme: cachedLiveTheme });
          }
        }
      }
    } catch {}
  }

  /**
   * Refreshes the play queue using Folium 1.5 getQueue API with pagination.
   * @param {number} pageIndex 0-indexed page number.
   */
  function refreshQueue(pageIndex = currentQueuePageIndex) {
    try {
      if (typeof folium.playback.getQueue === 'function') {
        const offset = pageIndex * QUEUE_PAGE_SIZE;
        const page = folium.playback.getQueue({ offset, limit: QUEUE_PAGE_SIZE });
        if (page && Array.isArray(page.items)) {
          currentQueuePageIndex = pageIndex;
          currentSnapshot.queuePage = pageIndex;
          currentSnapshot.queuePageSize = QUEUE_PAGE_SIZE;
          currentSnapshot.queueTotal = typeof page.length === 'number' ? page.length : page.items.length;
          currentSnapshot.currentIndex = page.currentIndex;
          currentSnapshot.queue = page.items.map((item) => ({
            index: item.index,
            ref: item.song?.ref || null,
            title: item.song?.title || '未知曲目',
            artist: item.song?.artist || '未知艺人',
            active: item.index === page.currentIndex,
          }));
        }
      }
    } catch {
      // Ignored
    }
  }

  /**
   * Formats raw lyric lines into the standardized taskbar lyrics snapshot model.
   * @param {Array} lines Array of Folia/Folium line objects
   */
  function formatLyricsLines(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return {
      lines: lines.map((line) => ({
        startTime: typeof line.startTime === 'number' ? line.startTime : 0,
        endTime: typeof line.endTime === 'number' ? line.endTime : 0,
        fullText: line.fullText || line.text || '',
        text: line.fullText || line.text || '',
        translation: line.translation || '',
        words: Array.isArray(line.words) ? line.words.map((w) => ({
          text: w.text || '',
          startTime: typeof w.startTime === 'number' ? w.startTime : 0,
          endTime: typeof w.endTime === 'number' ? w.endTime : 0,
        })) : null,
      })),
    };
  }

  /**
   * Reads existing lyrics and song metadata directly from Folia's Zustand playback store
   * to immediately populate retained songs on startup or async metadata arrival.
   * @param {boolean} resetIfEmpty When true, clears lyrics if store has none for the current track.
   */
  function syncPlaybackStoreLyricsAndSong(resetIfEmpty = false) {
    try {
      const pState = folium.internals?.stores?.playback?.getState?.();
      if (!pState) return;

      const currentRawSong = pState.transitionDisplay?.song || pState.currentSong;
      if (currentRawSong) {
        const title = currentRawSong.name || currentRawSong.title || '未知曲目';
        const artist = Array.isArray(currentRawSong.artists)
          ? currentRawSong.artists.map((a) => a.name).filter(Boolean).join(' / ')
          : (currentRawSong.artist || 'Folia');
        const coverUrl = pState.transitionDisplay?.coverUrl
          || pState.cachedCoverUrl
          || currentRawSong.album?.coverUrl
          || currentRawSong.coverUrl
          || currentRawSong.picUrl
          || null;

        currentSnapshot.song = { title, artist, coverUrl };
      }

      const rawLyrics = pState.transitionDisplay?.lyrics || pState.lyrics;
      if (rawLyrics && Array.isArray(rawLyrics.lines) && rawLyrics.lines.length > 0) {
        currentSnapshot.lyrics = formatLyricsLines(rawLyrics.lines);
      } else if (resetIfEmpty) {
        currentSnapshot.lyrics = null;
      }
    } catch {
      // Ignored
    }
  }

  /**
   * Reads playback state from stable folium.playback.getState() API.
   */
  function refreshPlaybackState() {
    try {
      const state = folium.playback.getState();
      if (state) {
        if (state.song) {
          currentSnapshot.song = {
            title: state.song.title || '未知曲目',
            artist: state.song.artist || 'Folia',
            coverUrl: currentSnapshot.song?.coverUrl || null,
          };
        }
        currentSnapshot.playerState = normalizePlayerState(state.state);
        if (typeof state.position === 'number' && Number.isFinite(state.position)) {
          currentSnapshot.currentTime = state.position;
        }
        if (typeof state.duration === 'number' && Number.isFinite(state.duration) && state.duration > 0) {
          currentSnapshot.duration = state.duration;
        }
        currentSnapshot.updatedAt = Date.now();
      }
      syncPlaybackStoreLyricsAndSong();
    } catch {
      // Ignored
    }
  }

  /**
   * Reads initial audio volume, mute, and loop mode from Folium 1.5 playback API.
   */
  function refreshAudioState() {
    try {
      const volInfo = folium.playback.getVolume();
      if (volInfo) {
        currentSnapshot.volume = Math.round((volInfo.volume ?? 1) * 100);
        currentSnapshot.isMuted = Boolean(volInfo.muted);
      }
    } catch {}
    try {
      const mode = folium.playback.getLoopMode();
      if (mode) {
        currentSnapshot.loopMode = mode;
      }
    } catch {}
  }

  // =========================================================================
  // IndexedDB Helpers for KineticPlayerDB
  // =========================================================================

  function openKineticPlayerDb() {
    return new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open('KineticPlayerDB');
        req.onerror = () => resolve(null);
        req.onsuccess = () => resolve(req.result);
      } catch {
        resolve(null);
      }
    });
  }

  function readIndexedDbTable(tableName) {
    return new Promise(async (resolve) => {
      try {
        const db = await openKineticPlayerDb();
        if (!db || !db.objectStoreNames.contains(tableName)) {
          if (db) db.close();
          return resolve([]);
        }
        const tx = db.transaction(tableName, 'readonly');
        const store = tx.objectStore(tableName);
        const getAllReq = store.getAll();
        getAllReq.onsuccess = () => {
          db.close();
          resolve(getAllReq.result || []);
        };
        getAllReq.onerror = () => {
          db.close();
          resolve([]);
        };
      } catch {
        resolve([]);
      }
    });
  }

  function readUserCacheKey(key) {
    return new Promise(async (resolve) => {
      try {
        const db = await openKineticPlayerDb();
        if (!db || !db.objectStoreNames.contains('user_cache')) {
          if (db) db.close();
          return resolve(null);
        }
        const tx = db.transaction('user_cache', 'readonly');
        const store = tx.objectStore('user_cache');
        const getReq = store.get(key);
        getReq.onsuccess = () => {
          db.close();
          const res = getReq.result;
          resolve(res ? res.data : null);
        };
        getReq.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        resolve(null);
      }
    });
  }

  // =========================================================================
  // Comprehensive Music Library Services (Online & Local)
  // =========================================================================

  /**
   * Retrieves all playlists combining active Omni online collections and local playlists.
   */
  async function getLibraryPlaylists() {
    const omni = folium.internals?.omni;
    const list = [];
    const seenKeys = new Set();

    // 1. Read from in-memory Omni summaries
    if (omni?.getProviderSummaries) {
      try {
        const summaries = omni.getProviderSummaries() || [];
        for (const s of summaries) {
          if (Array.isArray(s.collections)) {
            for (const c of s.collections) {
              if (c.type === 'playlist' || c.type === 'cloud' || c.isLiked) {
                const key = `${c.providerId}:${c.id}`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  list.push({
                    id: c.id,
                    providerId: c.providerId,
                    name: c.name || (c.isLiked ? '我喜欢的音乐' : '自建歌单'),
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: c.type || 'playlist',
                    isLiked: Boolean(c.isLiked),
                    rawCollection: c,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        folium.log.warn('Failed to read omni summaries for playlists', err);
      }
    }

    // 2. If online list is still empty, call omni.getUserPlaylists directly
    if (list.length === 0 && omni?.getActiveProviderSummary) {
      try {
        const activeSummary = omni.getActiveProviderSummary();
        if (activeSummary?.user?.id && omni.getUserPlaylists) {
          const page = await omni.getUserPlaylists(activeSummary.user.id, { limit: 100, offset: 0 });
          if (Array.isArray(page?.items)) {
            for (const c of page.items) {
              const key = `${c.providerId || activeSummary.providerId}:${c.id}`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                list.push({
                  id: c.id,
                  providerId: c.providerId || activeSummary.providerId,
                  name: c.name || '在线歌单',
                  coverUrl: c.coverUrl || '',
                  songCount: c.trackCount || 0,
                  type: c.type || 'playlist',
                  isLiked: Boolean(c.isLiked),
                  rawCollection: c,
                });
              }
            }
          }
        }
      } catch (err) {
        folium.log.warn('Failed to fetch online user playlists', err);
      }
    }

    // 3. Fallback: check IndexedDB user_cache for provider snapshots
    if (list.length === 0) {
      const providers = ['netease', 'kugou', 'qq', 'bodian'];
      for (const p of providers) {
        try {
          const snap = await readUserCacheKey(`online_provider_${p}_user_home_snapshot`);
          if (snap && Array.isArray(snap.collections)) {
            for (const c of snap.collections) {
              if (c.type === 'playlist' || c.type === 'cloud' || c.isLiked) {
                const key = `${p}:${c.id}`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  list.push({
                    id: c.id,
                    providerId: p,
                    name: c.name || (c.isLiked ? '我喜欢的音乐' : '精选歌单'),
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: c.type || 'playlist',
                    isLiked: Boolean(c.isLiked),
                    rawCollection: c,
                  });
                }
              }
            }
          }
        } catch {}
      }
    }

    // 4. Append local playlists from user_cache
    try {
      const localPlaylists = (await readUserCacheKey('local_playlists')) || [];
      if (Array.isArray(localPlaylists)) {
        for (const lp of localPlaylists) {
          const count = Array.isArray(lp.songs) ? lp.songs.length : (Array.isArray(lp.trackIds) ? lp.trackIds.length : 0);
          list.push({
            id: lp.id,
            name: lp.name || '本地歌单',
            coverUrl: lp.coverUrl || '',
            songCount: count,
            type: 'playlist',
            isLocal: true,
            rawLocalPlaylist: lp,
          });
        }
      }
    } catch {}

    return list;
  }

  /**
   * Retrieves all albums combining Omni online saved albums and local albums.
   */
  async function getLibraryAlbums() {
    const omni = folium.internals?.omni;
    const list = [];
    const seenKeys = new Set();

    // 1. From omni provider summaries
    if (omni?.getProviderSummaries) {
      try {
        const summaries = omni.getProviderSummaries() || [];
        for (const s of summaries) {
          if (Array.isArray(s.collections)) {
            for (const c of s.collections) {
              if (c.type === 'album') {
                const key = `${c.providerId}:${c.id}`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  list.push({
                    id: c.id,
                    providerId: c.providerId,
                    name: c.name || '专辑',
                    artist: c.artist || c.creator?.name || '未知艺人',
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: 'album',
                    rawCollection: c,
                  });
                }
              }
            }
          }
        }
      } catch (err) {
        folium.log.warn('Failed to read omni album summaries', err);
      }
    }

    // 2. From omni.getUserAlbums directly
    if (omni?.getActiveProviderSummary) {
      try {
        const activeSummary = omni.getActiveProviderSummary();
        if (activeSummary?.user?.id && omni.getUserAlbums) {
          const page = await omni.getUserAlbums(activeSummary.user.id, { limit: 100, offset: 0 });
          if (Array.isArray(page?.items)) {
            for (const c of page.items) {
              const key = `${c.providerId || activeSummary.providerId}:${c.id}`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                list.push({
                  id: c.id,
                  providerId: c.providerId || activeSummary.providerId,
                  name: c.name || '专辑',
                  artist: c.artist || c.creator?.name || '未知艺人',
                  coverUrl: c.coverUrl || '',
                  songCount: c.trackCount || 0,
                  type: 'album',
                  rawCollection: c,
                });
              }
            }
          }
        }
      } catch (err) {
        folium.log.warn('Failed to fetch online user albums', err);
      }
    }

    // 3. Fallback: IndexedDB provider snapshot
    if (list.length === 0) {
      const providers = ['netease', 'kugou', 'qq', 'bodian'];
      for (const p of providers) {
        try {
          const snap = await readUserCacheKey(`online_provider_${p}_user_home_snapshot`);
          if (snap && Array.isArray(snap.collections)) {
            for (const c of snap.collections) {
              if (c.type === 'album') {
                const key = `${p}:${c.id}`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  list.push({
                    id: c.id,
                    providerId: p,
                    name: c.name || '专辑',
                    artist: c.artist || c.creator?.name || '未知艺人',
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: 'album',
                    rawCollection: c,
                  });
                }
              }
            }
          }
        } catch {}
      }
    }

    // 4. Local albums grouped from local_music
    try {
      const allLocalSongs = await readIndexedDbTable('local_music');
      const albumMap = new Map();
      allLocalSongs.forEach((song) => {
        const albumName = song.importedMetadata?.albumName || song.album?.name || song.album || '未知专辑';
        const artist = Array.isArray(song.importedMetadata?.artistNames)
          ? song.importedMetadata.artistNames.join(' / ')
          : (song.artist || '本地音乐');
        if (!albumMap.has(albumName)) {
          albumMap.set(albumName, {
            id: `local_album_${albumName}`,
            name: albumName,
            artist,
            coverUrl: song.onlineMetadata?.coverUrl || '',
            songCount: 0,
            type: 'album',
            isLocal: true,
            songs: [],
          });
        }
        const alb = albumMap.get(albumName);
        alb.songCount += 1;
        alb.songs.push(song);
      });
      albumMap.forEach((alb) => list.push(alb));
    } catch {}

    return list;
  }

  /**
   * Retrieves Radio feed: Personal FM, Daily Recommendations, and Recommended Collections.
   */
  async function getLibraryRadioFeed() {
    const omni = folium.internals?.omni;
    let homeFeed = null;
    if (omni?.getHomeFeed) {
      try {
        homeFeed = await omni.getHomeFeed(35);
      } catch (err) {
        folium.log.warn('getHomeFeed error', err);
      }
    }

    return {
      hasFm: true,
      dailyCount: Array.isArray(homeFeed?.dailySongs) ? homeFeed.dailySongs.length : 30,
      recommendedPlaylistsCount: Array.isArray(homeFeed?.recommendedCollections) ? homeFeed.recommendedCollections.length : 0,
      dailySongs: (homeFeed?.dailySongs || []).map((song) => {
        const artist = Array.isArray(song.artists) ? song.artists.map((a) => a.name).join(' / ') : (song.artist || '未知艺人');
        const durSec = typeof song.durationMs === 'number' ? Math.round(song.durationMs / 1000) : (song.duration || 0);
        return {
          id: song.id,
          title: song.name || song.title || '未知曲目',
          artist,
          album: song.album?.name || '',
          duration: durSec,
          rawSong: song,
        };
      }),
      recommendedCollections: (homeFeed?.recommendedCollections || []).map((c) => ({
        id: c.id,
        providerId: c.providerId || (omni?.getActiveProviderSummary?.()?.providerId) || 'netease',
        name: c.name || '推荐歌单',
        coverUrl: c.coverUrl || '',
        songCount: c.trackCount || 0,
        type: 'playlist',
        rawCollection: c,
      })),
    };
  }

  let activePlaylistDetailRequestId = 0;

  /**
   * Retrieves songs inside a playlist (online or local).
   * Automatically loops through collection track pages to fetch all tracks (100 per page).
   */
  async function getLibraryPlaylistSongs(playlistItem, reqId) {
    const omni = folium.internals?.omni;

    // 1. Local playlist
    if (playlistItem.isLocal && playlistItem.rawLocalPlaylist) {
      const lp = playlistItem.rawLocalPlaylist;
      const allLocalSongs = await readIndexedDbTable('local_music');
      const songMap = new Map(allLocalSongs.map((s) => [s.id, s]));
      const songIds = Array.isArray(lp.songIds) ? lp.songIds : (Array.isArray(lp.songs) ? lp.songs.map((s) => (typeof s === 'string' ? s : s?.id)) : []);
      const matched = [];
      songIds.forEach((id) => {
        const s = songMap.get(id);
        if (s) {
          const artist = Array.isArray(s.importedMetadata?.artistNames)
            ? s.importedMetadata.artistNames.join(' / ')
            : (s.artist || '本地音乐');
          matched.push({
            id: s.id,
            title: s.title || s.name || '未知曲目',
            artist,
            album: s.importedMetadata?.albumName || s.album?.name || '',
            duration: typeof s.duration === 'number' ? s.duration : 0,
            rawSong: {
              id: s.id,
              name: s.title || s.name || '未知曲目',
              artists: [{ id: 0, name: artist }],
              album: { id: 0, name: s.importedMetadata?.albumName || s.album?.name || '' },
              durationMs: (s.duration || 0) * 1000,
              isLocal: true,
              localRef: { songId: s.id },
              sourceRef: { kind: 'local', mediaId: s.id },
            },
          });
        }
      });
      return matched;
    }

    // 2. Online playlist
    const fallbackProvider = omni?.getActiveProviderSummary?.()?.providerId || 'netease';
    const collection = playlistItem.rawCollection || {
      id: playlistItem.id,
      providerId: playlistItem.providerId || fallbackProvider,
      type: playlistItem.type || 'playlist',
    };
    if (!collection.providerId) {
      collection.providerId = fallbackProvider;
    }
    if (!collection.type) {
      collection.type = 'playlist';
    }

    if (omni?.getCollectionTracks) {
      try {
        const allSongs = [];
        let offset = 0;
        const batchSize = 100;
        let hasMore = true;
        let iteration = 0;
        const maxIterations = 50; // support up to 5000 songs

        while (hasMore && iteration < maxIterations) {
          iteration += 1;
          const page = await omni.getCollectionTracks(collection, { limit: batchSize, offset });
          const items = Array.isArray(page?.items) ? page.items : [];
          if (items.length === 0) break;

          for (const song of items) {
            const artist = Array.isArray(song.artists) ? song.artists.map((a) => a.name).join(' / ') : (song.artist || '未知艺人');
            const durSec = typeof song.durationMs === 'number' ? Math.round(song.durationMs / 1000) : (song.duration || 0);
            allSongs.push({
              id: song.id,
              title: song.name || song.title || '未知曲目',
              artist,
              album: song.album?.name || '',
              duration: durSec,
              rawSong: song,
            });
          }

          // If there are multiple pages, push intermediate snapshot after the first batch
          // so user immediately sees the first 100 songs without waiting for all batches!
          if (iteration === 1 && (page?.hasMore !== false && items.length === batchSize)) {
            if (!reqId || reqId === activePlaylistDetailRequestId) {
              void pushSnapshot({
                libraryDetailData: {
                  type: playlistItem.type || 'playlist',
                  id: playlistItem.id,
                  title: playlistItem.name,
                  songs: [...allSongs],
                },
              });
            }
          }

          if (reqId && reqId !== activePlaylistDetailRequestId) {
            return allSongs;
          }

          if (page?.hasMore === false || items.length < batchSize) {
            hasMore = false;
          } else {
            offset = typeof page?.nextOffset === 'number' ? page.nextOffset : offset + items.length;
          }
        }

        return allSongs;
      } catch (err) {
        folium.log.warn('omni getCollectionTracks failed', err);
      }
    }

    return [];
  }

  /**
   * Retrieves songs inside an album (online or local).
   */
  async function getLibraryAlbumSongs(albumItem, reqId) {
    if (albumItem.isLocal && Array.isArray(albumItem.songs)) {
      return albumItem.songs.map((s) => {
        const artist = Array.isArray(s.importedMetadata?.artistNames)
          ? s.importedMetadata.artistNames.join(' / ')
          : (s.artist || '本地音乐');
        return {
          id: s.id,
          title: s.title || s.name || '未知曲目',
          artist,
          album: s.importedMetadata?.albumName || s.album?.name || '',
          duration: typeof s.duration === 'number' ? s.duration : 0,
          rawSong: {
            id: s.id,
            name: s.title || s.name || '未知曲目',
            artists: [{ id: 0, name: artist }],
            album: { id: 0, name: s.importedMetadata?.albumName || s.album?.name || '' },
            durationMs: (s.duration || 0) * 1000,
            isLocal: true,
            localRef: { songId: s.id },
            sourceRef: { kind: 'local', mediaId: s.id },
          },
        };
      });
    }

    return getLibraryPlaylistSongs(albumItem, reqId);
  }

  /**
   * Retrieves local songs with search keyword support (default 100 per page).
   */
  async function getLibraryLocalSongs(offset = 0, limit = 100, query = '') {
    const allLocalSongs = await readIndexedDbTable('local_music');
    let filtered = allLocalSongs;
    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      filtered = allLocalSongs.filter((s) => {
        const title = (s.title || s.name || '').toLowerCase();
        const artist = (s.importedMetadata?.artistNames?.join(' ') || s.artist || '').toLowerCase();
        return title.includes(q) || artist.includes(q);
      });
    }
    const total = filtered.length;
    const pageItems = filtered.slice(offset, offset + limit).map((s) => {
      const artist = Array.isArray(s.importedMetadata?.artistNames)
        ? s.importedMetadata.artistNames.join(' / ')
        : (s.artist || '本地音乐');
      return {
        id: s.id,
        title: s.title || s.name || '未知曲目',
        artist,
        album: s.importedMetadata?.albumName || s.album?.name || '',
        duration: typeof s.duration === 'number' ? s.duration : 0,
        rawSong: {
          id: s.id,
          name: s.title || s.name || '未知曲目',
          artists: [{ id: 0, name: artist }],
          album: { id: 0, name: s.importedMetadata?.albumName || s.album?.name || '' },
          durationMs: (s.duration || 0) * 1000,
          isLocal: true,
          localRef: { songId: s.id },
          sourceRef: { kind: 'local', mediaId: s.id },
        },
      };
    });
    return { items: pageItems, total };
  }

  /**
   * Plays a selected song from the library and sets context queue.
   */
  async function playLibrarySong(songItem, queueContext = []) {
    try {
      const rawSong = songItem.rawSong;
      const rawQueue = queueContext.map((q) => q.rawSong).filter(Boolean);
      const pStore = folium.internals?.stores?.playback;
      if (!pStore || !rawSong) return;

      pStore.getState().setIsFmMode(false);
      pStore.getState().setPlayQueue(rawQueue.length > 0 ? rawQueue : [rawSong]);

      const targetIndex = rawQueue.findIndex((q) => String(q.id) === String(rawSong.id));
      const safeIndex = targetIndex >= 0 ? targetIndex : 0;

      setTimeout(async () => {
        try {
          await folium.playback.playQueueItem(safeIndex);
          refreshQueue();
          void pushSnapshot({
            queue: currentSnapshot.queue,
            queueTotal: currentSnapshot.queueTotal,
            queuePage: currentSnapshot.queuePage,
            currentIndex: currentSnapshot.currentIndex,
          });
        } catch (err) {
          folium.log.warn('playLibrarySong failed', err);
        }
      }, 60);
    } catch (err) {
      folium.log.warn('playLibrarySong error', err);
    }
  }

  /**
   * Switches to Personal FM mode.
   */
  async function playPersonalFmMode() {
    try {
      const omni = folium.internals?.omni;
      const pStore = folium.internals?.stores?.playback;
      if (!omni || !pStore) return;

      let tracks = [];
      try {
        tracks = await omni.getPersonalFm();
      } catch (err) {
        folium.log.warn('getPersonalFm error', err);
      }

      if (!Array.isArray(tracks) || tracks.length === 0) {
        try {
          const feed = await omni.getHomeFeed(20);
          tracks = feed?.personalFm || [];
        } catch {}
      }

      if (Array.isArray(tracks) && tracks.length > 0) {
        pStore.getState().setIsFmMode(true);
        pStore.getState().setPlayQueue(tracks);
        setTimeout(async () => {
          await folium.playback.playQueueItem(0);
          refreshQueue();
          void pushSnapshot({
            queue: currentSnapshot.queue,
            queueTotal: currentSnapshot.queueTotal,
            currentIndex: 0,
          });
        }, 60);
      }
    } catch (err) {
      folium.log.warn('playPersonalFmMode error', err);
    }
  }

  // Register Settings in Mod Panel
  const settingsSection = folium.registries.settingsSections.register({
    id: 'general',
    label: {
      'zh-CN': '任务栏抽屉设置',
      en: 'Taskbar Drawer Settings',
    },
    description: {
      'zh-CN': '配置任务栏歌词抽屉的行为与显示效果',
      en: 'Configure the taskbar lyrics drawer behavior',
    },
    settings: [
      {
        key: 'showTranslation',
        type: 'boolean',
        label: {
          'zh-CN': '显示歌词翻译/副行',
          en: 'Show Translation / Subtitle',
        },
        defaultValue: true,
      },
      {
        key: 'useCoverBackground',
        type: 'boolean',
        label: {
          'zh-CN': '启用封面流光背景（Folia 风格）',
          en: 'Use Cover Fluid Artwork Background',
        },
        defaultValue: true,
      },
    ],
  });

  const settingsAccess = settingsSection?.settings;

  function syncSettings() {
    try {
      if (settingsAccess?.get) {
        const values = settingsAccess.get();
        const showTr = values?.showTranslation;
        const useBg = values?.useCoverBackground;
        currentSnapshot.settings = {
          showTranslation: typeof showTr === 'boolean' ? showTr : true,
          useCoverBackground: typeof useBg === 'boolean' ? useBg : true,
        };
      }
    } catch {
      // Ignored
    }
  }

  syncSettings();

  if (typeof settingsAccess?.onChange === 'function') {
    settingsAccess.onChange(() => {
      syncSettings();
      void pushSnapshot({ settings: currentSnapshot.settings });
    });
  }

  function resolveEffectiveLyricOffsetMs() {
    try {
      const songOffset = folium.internals?.stores?.playback?.getState?.()?.lyricTimelineOffsetMs || 0;
      const globalOffset = folium.internals?.stores?.lyricSettings?.getState?.()?.globalLyricTimelineOffsetMs || 0;
      return (Number(songOffset) || 0) + (Number(globalOffset) || 0);
    } catch {
      return 0;
    }
  }

  let lastAudioSyncPushWallTime = 0;
  let lastAudioSyncPushedTime = -1;

  /**
   * Retrieves the current audio playback position from Folium host bridge playback state.
   */
  function getActiveAudioPosition() {
    try {
      const hostState = folium.playback.getState();
      if (hostState && typeof hostState.position === 'number' && Number.isFinite(hostState.position)) {
        return hostState.position;
      }
    } catch {}

    return currentSnapshot.currentTime;
  }

  /**
   * Pushes high-frequency playback anchor to the taskbar drawer window.
   * Ensures the taskbar extrapolation clock is regularly pinned to the real audio decoder without drift.
   * @param {boolean} force Force immediate push regardless of threshold
   */
  function pushPlaybackAnchor(force = false) {
    try {
      const now = Date.now();
      const pos = getActiveAudioPosition();
      const hostState = folium.playback.getState();
      const state = normalizePlayerState(hostState?.state || currentSnapshot.playerState);

      currentSnapshot.currentTime = pos;
      currentSnapshot.playerState = state;
      currentSnapshot.updatedAt = now;
      currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();
      if (hostState?.duration && Number.isFinite(hostState.duration) && hostState.duration > 0) {
        currentSnapshot.duration = hostState.duration;
      }

      const timeDiff = Math.abs(pos - lastAudioSyncPushedTime);
      const wallDiff = now - lastAudioSyncPushWallTime;
      const shouldPush = force
        || lastAudioSyncPushedTime < 0
        || (state === 'playing' && (wallDiff >= 350 || timeDiff >= 0.25))
        || (state !== currentSnapshot.playerState);

      if (shouldPush) {
        lastAudioSyncPushedTime = pos;
        lastAudioSyncPushWallTime = now;
        void pushSnapshot({
          currentTime: pos,
          duration: currentSnapshot.duration,
          playerState: state,
          lyricOffsetMs: currentSnapshot.lyricOffsetMs,
          updatedAt: now,
        });
      }
    } catch {
      // Ignored
    }
  }

  // Listen for Folia Event Bus
  const unsubs = [];

  // 1. Song changed
  unsubs.push(folium.events.on('playback.songChanged', (event) => {
    currentSnapshot.currentTime = 0;
    currentSnapshot.updatedAt = Date.now();
    lastAudioSyncPushedTime = 0;
    lastAudioSyncPushWallTime = Date.now();

    refreshPlaybackState();
    if (event && event.song) {
      currentSnapshot.song = {
        title: event.song.title || '未知曲目',
        artist: event.song.artist || 'Folia',
        coverUrl: currentSnapshot.song?.coverUrl || null,
      };
    }
    // Clear lyrics for new song until its own lyrics are loaded
    syncPlaybackStoreLyricsAndSong(true);
    refreshQueue();
    currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();
    void pushSnapshot({
      song: currentSnapshot.song,
      lyrics: currentSnapshot.lyrics,
      queue: currentSnapshot.queue,
      queueTotal: currentSnapshot.queueTotal,
      queuePage: currentSnapshot.queuePage,
      currentIndex: currentSnapshot.currentIndex,
      lyricOffsetMs: currentSnapshot.lyricOffsetMs,
      currentTime: 0,
      duration: currentSnapshot.duration,
      playerState: currentSnapshot.playerState,
    });
  }));

  // 2. Playback state changed (playing, paused, stopped)
  unsubs.push(folium.events.on('playback.stateChanged', (event) => {
    if (event && event.state) {
      currentSnapshot.playerState = normalizePlayerState(event.state);
      pushPlaybackAnchor(true);
    }
  }));

  // 3. Lyrics loaded (stable Folium 1.0+ event: 'lyrics.loaded')
  unsubs.push(folium.events.on('lyrics.loaded', (event) => {
    if (event && Array.isArray(event.lines) && event.lines.length > 0) {
      currentSnapshot.lyrics = formatLyricsLines(event.lines);
      currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();
      void pushSnapshot({
        lyrics: currentSnapshot.lyrics,
        lyricOffsetMs: currentSnapshot.lyricOffsetMs,
      });
    } else {
      syncPlaybackStoreLyricsAndSong(true);
      void pushSnapshot({
        lyrics: currentSnapshot.lyrics,
        lyricOffsetMs: currentSnapshot.lyricOffsetMs,
      });
    }
  }));

  // 4. Seeked
  unsubs.push(folium.events.on('playback.seeked', (event) => {
    const pos = (typeof event?.position === 'number' && Number.isFinite(event.position))
      ? event.position
      : getActiveAudioPosition();
    const now = Date.now();
    currentSnapshot.currentTime = pos;
    currentSnapshot.updatedAt = now;
    currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();
    lastAudioSyncPushedTime = pos;
    lastAudioSyncPushWallTime = now;
    void pushSnapshot({
      currentTime: pos,
      duration: currentSnapshot.duration,
      playerState: currentSnapshot.playerState,
      lyricOffsetMs: currentSnapshot.lyricOffsetMs,
      updatedAt: now,
    });
  }));

  // 5. Volume changed
  unsubs.push(folium.events.on('playback.volumeChanged', (event) => {
    if (event) {
      if (typeof event.volume === 'number') {
        currentSnapshot.volume = Math.round(event.volume * 100);
      }
      if (typeof event.muted === 'boolean') {
        currentSnapshot.isMuted = event.muted;
      }
      void pushSnapshot({
        volume: currentSnapshot.volume,
        isMuted: currentSnapshot.isMuted,
      });
    }
  }));

  // 6. Loop mode changed
  unsubs.push(folium.events.on('playback.loopModeChanged', (event) => {
    if (event && event.mode) {
      currentSnapshot.loopMode = event.mode;
      void pushSnapshot({ loopMode: event.mode });
    }
  }));

  // 7. Queue changed
  unsubs.push(folium.events.on('playback.queueChanged', () => {
    refreshQueue();
    void pushSnapshot({
      queue: currentSnapshot.queue,
      queueTotal: currentSnapshot.queueTotal,
      queuePage: currentSnapshot.queuePage,
      currentIndex: currentSnapshot.currentIndex,
    });
  }));

  // 8. Theme changed
  unsubs.push(folium.events.on('theme.changed', (event) => {
    let nextTheme = null;
    if (event && event.theme && typeof event.theme === 'object') {
      nextTheme = {
        name: event.theme.name || 'Folia Theme',
        backgroundColor: event.theme.backgroundColor,
        primaryColor: event.theme.primaryColor,
        accentColor: event.theme.accentColor,
        secondaryColor: event.theme.secondaryColor,
        fontFamily: event.theme.fontFamily,
        fontStyle: event.theme.fontStyle,
        isDaylight: Boolean(event.theme.isDaylight),
      };
    }
    if (!nextTheme) {
      nextTheme = resolveCurrentTheme();
    }
    cachedLiveTheme = nextTheme;
    currentSnapshot.theme = nextTheme;
    void pushSnapshot({ theme: nextTheme });
  }));

  // Subscribe to Zustand stores for instant live updates
  try {
    const tStore = folium.internals?.stores?.themeSettings;
    if (tStore?.subscribe) {
      tStore.subscribe(() => {
        const nextTheme = resolveCurrentTheme();
        currentSnapshot.theme = nextTheme;
        void pushSnapshot({ theme: nextTheme });
      });
    }

    const pStore = folium.internals?.stores?.playback;
    if (pStore?.subscribe) {
      pStore.subscribe((state) => {
        if (!state) return;
        const storeLyrics = state.transitionDisplay?.lyrics || state.lyrics;
        if (storeLyrics && Array.isArray(storeLyrics.lines) && storeLyrics.lines.length > 0) {
          const currentCount = currentSnapshot.lyrics?.lines?.length || 0;
          const currentFirst = currentSnapshot.lyrics?.lines?.[0]?.fullText;
          const newFirst = storeLyrics.lines[0]?.fullText || storeLyrics.lines[0]?.text;
          if (currentCount !== storeLyrics.lines.length || currentFirst !== newFirst) {
            currentSnapshot.lyrics = formatLyricsLines(storeLyrics.lines);
            currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();
            void pushSnapshot({
              lyrics: currentSnapshot.lyrics,
              lyricOffsetMs: currentSnapshot.lyricOffsetMs,
            });
          }
        }
        if (state.playQueue) {
          refreshQueue();
        }
      });
    }
  } catch {}

  // Initial Sync
  refreshPlaybackState();
  syncPlaybackStoreLyricsAndSong();
  refreshAudioState();
  refreshQueue();
  currentSnapshot.theme = resolveCurrentTheme();
  void initThemeFromStorage();

  void pushSnapshot({
    song: currentSnapshot.song,
    playerState: currentSnapshot.playerState,
    currentTime: currentSnapshot.currentTime,
    duration: currentSnapshot.duration,
    lyrics: currentSnapshot.lyrics,
    queue: currentSnapshot.queue,
    queueTotal: currentSnapshot.queueTotal,
    queuePage: currentSnapshot.queuePage,
    queuePageSize: currentSnapshot.queuePageSize,
    currentIndex: currentSnapshot.currentIndex,
    loopMode: currentSnapshot.loopMode,
    volume: currentSnapshot.volume,
    isMuted: currentSnapshot.isMuted,
    theme: currentSnapshot.theme,
    settings: currentSnapshot.settings,
    hasPlaybackControls: currentSnapshot.hasPlaybackControls,
  });

  // Action Dispatcher Loop (200ms)
  const actionPollTimer = setInterval(async () => {
    try {
      const state = folium.playback.getState();
      if (state) {
        if (typeof state.position === 'number' && Number.isFinite(state.position)) {
          currentSnapshot.currentTime = state.position;
        }
        if (typeof state.duration === 'number' && Number.isFinite(state.duration) && state.duration > 0) {
          currentSnapshot.duration = state.duration;
        }
        currentSnapshot.playerState = normalizePlayerState(state.state);
        currentSnapshot.updatedAt = Date.now();
      }

      const actions = await folium.rpc.call('drainActions');
      if (Array.isArray(actions) && actions.length > 0) {
        for (const item of actions) {
          if (!item || !item.action) continue;
          switch (item.action) {
            case 'toggle':
              folium.playback.toggle();
              break;
            case 'next':
              folium.playback.next();
              break;
            case 'prev':
              folium.playback.previous();
              break;
            case 'seek':
              if (typeof item.payload === 'number') {
                const targetTime = Math.max(0, item.payload);
                currentSnapshot.currentTime = targetTime;
                currentSnapshot.updatedAt = Date.now();
                lastAudioSyncPushedTime = targetTime;
                lastAudioSyncPushWallTime = Date.now();
                folium.playback.seek(targetTime);
                void pushSnapshot({
                  currentTime: targetTime,
                  updatedAt: currentSnapshot.updatedAt,
                });
              }
              break;
            case 'openVolume':
              folium.ui.openVolume();
              break;
            case 'setVolume':
              if (typeof item.payload === 'number') {
                const ratio = Math.max(0, Math.min(1, item.payload / 100));
                try {
                  folium.playback.setVolume(ratio);
                  if (currentSnapshot.isMuted) {
                    folium.playback.setMuted(false);
                  }
                } catch (err) {
                  folium.log.warn('Failed to setVolume', err);
                }
                currentSnapshot.volume = Math.round(ratio * 100);
                void pushSnapshot({ volume: currentSnapshot.volume });
              }
              break;
            case 'toggleMute':
              try {
                const nextMuted = !folium.playback.getVolume().muted;
                folium.playback.setMuted(nextMuted);
                currentSnapshot.isMuted = nextMuted;
                void pushSnapshot({ isMuted: nextMuted });
              } catch (err) {
                folium.log.warn('Failed to toggleMute', err);
              }
              break;
            case 'toggleLoopMode': {
              const current = currentSnapshot.loopMode || 'all';
              let nextMode = 'all';
              if (current === 'all') {
                nextMode = 'one';
              } else if (current === 'one') {
                nextMode = 'off';
              } else {
                nextMode = 'all';
              }

              currentSnapshot.loopMode = nextMode;
              void pushSnapshot({ loopMode: nextMode });

              try {
                folium.playback.setLoopMode(nextMode);
              } catch (err) {
                folium.log.warn('Failed to apply loop mode change', err);
              }
              break;
            }
            case 'shuffleQueue':
              try {
                folium.playback.shuffleQueue();
                refreshQueue(currentQueuePageIndex);
                void pushSnapshot({
                  queue: currentSnapshot.queue,
                  queueTotal: currentSnapshot.queueTotal,
                  queuePage: currentSnapshot.queuePage,
                });
              } catch (err) {
                folium.log.warn('Failed to shuffleQueue', err);
              }
              break;
            case 'playQueueIndex': {
              const payload = item.payload;
              const index = typeof payload === 'number' ? payload : payload?.index;
              const ref = typeof payload === 'object' ? payload?.ref : undefined;
              if (typeof index === 'number') {
                try {
                  const played = await folium.playback.playQueueItem(index, ref || undefined);
                  if (!played) {
                    refreshQueue(currentQueuePageIndex);
                    void pushSnapshot({
                      queue: currentSnapshot.queue,
                      queueTotal: currentSnapshot.queueTotal,
                      queuePage: currentSnapshot.queuePage,
                    });
                  }
                } catch (err) {
                  folium.log.warn('playQueueItem failed', err);
                }
              }
              break;
            }
            case 'fetchQueuePage': {
              const targetPage = Number(item.payload?.page) || 0;
              refreshQueue(targetPage);
              void pushSnapshot({
                queue: currentSnapshot.queue,
                queueTotal: currentSnapshot.queueTotal,
                queuePage: currentSnapshot.queuePage,
                queuePageSize: currentSnapshot.queuePageSize,
                currentIndex: currentSnapshot.currentIndex,
              });
              break;
            }
            case 'jumpToActiveQueuePage': {
              if (typeof currentSnapshot.currentIndex === 'number' && currentSnapshot.currentIndex >= 0) {
                const targetPage = Math.floor(currentSnapshot.currentIndex / QUEUE_PAGE_SIZE);
                refreshQueue(targetPage);
                void pushSnapshot({
                  queue: currentSnapshot.queue,
                  queueTotal: currentSnapshot.queueTotal,
                  queuePage: currentSnapshot.queuePage,
                  queuePageSize: currentSnapshot.queuePageSize,
                  currentIndex: currentSnapshot.currentIndex,
                });
              }
              break;
            }
            case 'fetchLibrarySummary': {
              const playlists = await getLibraryPlaylists();
              const albums = await getLibraryAlbums();
              const local = await getLibraryLocalSongs(0, 1);
              void pushSnapshot({
                librarySummary: {
                  playlistCount: playlists.length,
                  albumCount: albums.length,
                  localSongCount: local.total,
                  radioCount: 3,
                },
              });
              break;
            }
            case 'fetchLibraryCategory': {
              const cat = item.payload?.category;
              if (cat === 'playlists') {
                const lists = await getLibraryPlaylists();
                void pushSnapshot({ libraryCategoryData: { category: 'playlists', items: lists } });
              } else if (cat === 'albums') {
                const albums = await getLibraryAlbums();
                void pushSnapshot({ libraryCategoryData: { category: 'albums', items: albums } });
              } else if (cat === 'radio') {
                const radioFeed = await getLibraryRadioFeed();
                void pushSnapshot({ libraryCategoryData: { category: 'radio', radioFeed } });
              } else if (cat === 'local') {
                const page = Number(item.payload?.page) || 0;
                const query = item.payload?.query || '';
                const pageSize = 100;
                const res = await getLibraryLocalSongs(page * pageSize, pageSize, query);
                void pushSnapshot({
                  libraryCategoryData: {
                    category: 'local',
                    items: res.items,
                    total: res.total,
                    page,
                    pageSize,
                    query,
                  },
                });
              }
              break;
            }
            case 'fetchLibraryPlaylistDetail': {
              const playlist = item.payload?.playlist;
              if (playlist) {
                activePlaylistDetailRequestId += 1;
                const reqId = activePlaylistDetailRequestId;
                const songs = await getLibraryPlaylistSongs(playlist, reqId);
                if (reqId === activePlaylistDetailRequestId) {
                  void pushSnapshot({
                    libraryDetailData: {
                      type: 'playlist',
                      id: playlist.id,
                      title: playlist.name,
                      songs,
                    },
                  });
                }
              }
              break;
            }
            case 'fetchLibraryAlbumDetail': {
              const album = item.payload?.album;
              if (album) {
                activePlaylistDetailRequestId += 1;
                const reqId = activePlaylistDetailRequestId;
                const songs = await getLibraryAlbumSongs(album, reqId);
                if (reqId === activePlaylistDetailRequestId) {
                  void pushSnapshot({
                    libraryDetailData: {
                      type: 'album',
                      id: album.id,
                      title: album.name,
                      songs,
                    },
                  });
                }
              }
              break;
            }
            case 'playLibrarySong': {
              const songItem = item.payload?.song;
              const queueContext = item.payload?.queueContext || [];
              if (songItem) {
                await playLibrarySong(songItem, queueContext);
              }
              break;
            }
            case 'playRadioFm': {
              await playPersonalFmMode();
              break;
            }
          }
        }
      }

      // High-assurance audio synchronization: check playback anchor on each poll cycle if playing
      if (currentSnapshot.playerState === 'playing') {
        pushPlaybackAnchor(false);
      }
    } catch {
      // Ignored
    }
  }, 200);

  // Return Disposer
  return () => {
    clearInterval(actionPollTimer);
    unsubs.forEach((unsub) => {
      try { unsub(); } catch { /* ignore */ }
    });
  };
}
