// mods/taskbar-lyrics/client.mjs
// Renderer ESM entry for the Taskbar Lyrics Drawer mod.
// Strictly uses public Folium 2.1 APIs: playback state/controls/queue/like, lyrics, theme,
// folium.omni public catalog search/album/artist/resolve, and mod-owned folium.storage.
// Note: Supported exclusively on Windows (win32).

'use strict';

/**
 * Taskbar Lyrics Client Entry
 * @param {import('../folium').FoliumClientApi} folium
 */
export default function activate(folium) {
  if (folium.env?.context && folium.env.context !== 'main') {
    return () => {};
  }
  if (typeof process !== 'undefined' && process.platform && process.platform !== 'win32') {
    return () => {};
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Windows')) {
    return () => {};
  }

  folium.log.info(`Taskbar Lyrics client activating for mod ${folium.modId}`);

  const foliumMajor = folium.host?.folium?.major ?? 2;
  const foliumMinor = folium.host?.folium?.minor ?? 0;
  const hasFoliumAtLeast = (targetMajor, targetMinor) => (
    foliumMajor > targetMajor || (foliumMajor === targetMajor && foliumMinor >= targetMinor)
  );
  const hasPlaybackControls = hasFoliumAtLeast(1, 5);
  const hasRpcPush = hasFoliumAtLeast(1, 7) && typeof folium.rpc?.on === 'function';
  const hasThemeCurrentApi = hasFoliumAtLeast(1, 10) && typeof folium.theme?.getCurrent === 'function';
  const hasOmniApi = hasFoliumAtLeast(1, 7) && Boolean(folium.omni);
  const hasReplaceQueueApi = hasFoliumAtLeast(1, 7) && typeof folium.playback?.replaceQueue === 'function';
  const hasStorageApi = Boolean(folium.storage && typeof folium.storage.get === 'function' && typeof folium.storage.set === 'function');

  const QUEUE_PAGE_SIZE = 50;
  const MAX_RECENT_TRACKS = 50;
  const MAX_SAVED_TRACKS = 200;
  const MAX_CACHED_OMNI_SONGS = 300;
  const MAX_CACHED_OMNI_COLLECTIONS = 80;
  const STORAGE_KEY_RECENT = 'recent_tracks_v1';
  const STORAGE_KEY_SAVED = 'saved_tracks_v1';

  let currentQueuePageIndex = 0;
  let isDisposed = false;
  let activeSearchController = null;
  let activeExploreController = null;
  let activePlayController = null;
  let searchSeq = 0;
  let exploreSeq = 0;
  let playSeq = 0;
  let exploreStack = [];

  const omniSongMap = new Map();
  const omniCollectionMap = new Map();
  let recentTracks = [];
  let savedTracks = [];
  let storageLoaded = false;
  let pendingRecentOps = [];
  let pendingSavedOps = [];

  const DEFAULT_DARK_THEME = {
    name: 'Midnight Default',
    backgroundColor: '#09090b',
    primaryColor: '#f4f4f5',
    accentColor: '#6366f1',
    secondaryColor: '#71717a',
    fontStyle: 'sans',
    isDaylight: false,
  };

  let currentSnapshot = {
    song: null,
    playerState: 'paused',
    isAdvancing: false,
    currentTime: 0,
    duration: 0,
    updatedAt: Date.now(),
    lyrics: null,
    liked: false,
    canLike: false,
    queue: [],
    queueTotal: 0,
    queuePage: 0,
    queuePageSize: QUEUE_PAGE_SIZE,
    currentIndex: -1,
    loopMode: 'all',
    volume: 100,
    isMuted: false,
    theme: null,
    providers: [],
    searchState: null,
    exploreData: null,
    savedTracks: [],
    recentTracks: [],
    settings: {
      interactionMode: 'standard',
      targetDisplay: 'primary',
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

  function normalizeDisplayTarget(value) {
    if (typeof value !== 'string' || !value) return 'primary';
    if (value === 'wallpaper') return 'secondary';
    if (value === 'primary' || value === 'secondary' || value.startsWith('display:')) {
      return value;
    }
    return 'primary';
  }

  function songPortableKey(source, id) {
    if (!source || id === null || id === undefined || id === '') return '';
    return `${String(source)}:${String(id)}`;
  }

  function isPortableOnlineSong(song) {
    if (!song || !song.source || song.id === null || song.id === undefined || song.id === '') return false;
    const src = String(song.source);
    return src !== 'local' && src !== 'stage' && src !== 'navidrome';
  }

  function rememberOmniSong(song) {
    if (!song || !song.ref) return;
    if (omniSongMap.size >= MAX_CACHED_OMNI_SONGS) {
      const oldestKey = omniSongMap.keys().next().value;
      if (oldestKey !== undefined) omniSongMap.delete(oldestKey);
    }
    omniSongMap.set(song.ref, song);
  }

  function rememberOmniCollection(col) {
    if (!col || !col.ref) return;
    if (omniCollectionMap.size >= MAX_CACHED_OMNI_COLLECTIONS) {
      const oldestKey = omniCollectionMap.keys().next().value;
      if (oldestKey !== undefined) omniCollectionMap.delete(oldestKey);
    }
    omniCollectionMap.set(col.ref, col);
  }

  function formatOmniError(err) {
    const code = err?.code || '';
    switch (code) {
      case 'rate-limited':
        return '请求过于频繁，请稍后再试';
      case 'not-signed-in':
      case 'session-expired':
        return '该音源需要登录或登录已过期';
      case 'vip-required':
        return '该内容需要对应音源会员权限';
      case 'region-restricted':
        return '当前地区暂不可用';
      case 'unsupported':
        return '当前音源暂不支持此项查询';
      case 'unavailable':
        return '当前音源服务暂不可用';
      case 'stale-ref':
        return '列表已过期，请重新刷新';
      case 'aborted':
        return null;
      default:
        return '加载失败，请稍后重试';
    }
  }

  /**
   * Pushes snapshot delta to the main process via Folium RPC.
   * Only advances updatedAt when currentTime is present in the delta.
   * @param {object} delta
   */
  async function pushSnapshot(delta = {}) {
    if (isDisposed) return;
    try {
      const hasTime = typeof delta.currentTime === 'number' && Number.isFinite(delta.currentTime);
      const nextUpdatedAt = hasTime ? (delta.updatedAt || Date.now()) : currentSnapshot.updatedAt;
      currentSnapshot = {
        ...currentSnapshot,
        ...delta,
        updatedAt: nextUpdatedAt,
      };
      const payload = hasTime ? { ...delta, updatedAt: nextUpdatedAt } : delta;
      await folium.rpc.call('syncSnapshot', payload);
    } catch {
      // Ignored if main process is unavailable or shutting down
    }
  }

  let cachedLiveTheme = null;
  let hasReceivedThemeEvent = false;

  function normalizeThemeSnapshot(theme) {
    if (!theme || typeof theme !== 'object') return null;
    let resolvedFont = theme.fontFamily;
    let resolvedSubFont;
    try {
      if (typeof folium.theme?.resolveFontStack === 'function') {
        resolvedFont = folium.theme.resolveFontStack(theme);
      }
      if (typeof folium.theme?.resolveTranslationFontStack === 'function') {
        resolvedSubFont = folium.theme.resolveTranslationFontStack(theme);
      }
    } catch {}
    return {
      name: theme.name || 'Folia Theme',
      backgroundColor: theme.backgroundColor,
      primaryColor: theme.primaryColor,
      accentColor: theme.accentColor,
      secondaryColor: theme.secondaryColor,
      fontFamily: resolvedFont || undefined,
      translationFontFamily: resolvedSubFont || undefined,
      fontStyle: theme.fontStyle || 'sans',
      isDaylight: Boolean(theme.isDaylight),
    };
  }

  function sameThemeSnapshot(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.name === b.name
      && a.backgroundColor === b.backgroundColor
      && a.primaryColor === b.primaryColor
      && a.accentColor === b.accentColor
      && a.secondaryColor === b.secondaryColor
      && a.fontFamily === b.fontFamily
      && a.translationFontFamily === b.translationFontFamily
      && a.fontStyle === b.fontStyle
      && Boolean(a.isDaylight) === Boolean(b.isDaylight);
  }

  function resolveCurrentTheme() {
    try {
      if (hasReceivedThemeEvent && cachedLiveTheme) {
        return cachedLiveTheme;
      }
      if (hasThemeCurrentApi) {
        const liveTheme = normalizeThemeSnapshot(folium.theme.getCurrent());
        if (liveTheme && liveTheme.backgroundColor) {
          cachedLiveTheme = liveTheme;
          return liveTheme;
        }
      }
    } catch {}
    return cachedLiveTheme || { ...DEFAULT_DARK_THEME };
  }

  function resolveSongDetails(song) {
    if (!song || !hasOmniApi || typeof folium.omni?.describeSong !== 'function') {
      return { coverUrl: null, durationSec: null, availability: 'unknown' };
    }
    try {
      const details = folium.omni.describeSong(song);
      if (!details) return { coverUrl: null, durationSec: null, availability: 'unknown' };
      const durationSec = typeof details.durationMs === 'number' && Number.isFinite(details.durationMs) && details.durationMs > 0
        ? Math.round(details.durationMs / 1000)
        : null;
      return {
        coverUrl: details.coverUrl || null,
        durationSec,
        availability: details.availability || 'unknown',
      };
    } catch {
      return { coverUrl: null, durationSec: null, availability: 'unknown' };
    }
  }

  function buildSongSnapshot(song) {
    if (!song) return null;
    const details = resolveSongDetails(song);
    return {
      id: song.id ?? null,
      source: song.source ?? null,
      title: song.title || '未知曲目',
      artist: song.artist || 'Folia',
      album: song.album ?? null,
      coverUrl: details.coverUrl,
    };
  }

  function formatOmniTrackDto(song) {
    rememberOmniSong(song);
    const details = resolveSongDetails(song);
    return {
      id: song.id ?? null,
      source: song.source ?? null,
      ref: song.ref || null,
      title: song.title || '未知曲目',
      artist: song.artist || '未知艺人',
      album: song.album || '',
      coverUrl: details.coverUrl,
      duration: details.durationSec,
      availability: details.availability,
    };
  }

  function formatOmniCollectionDto(col) {
    if (!col) return null;
    rememberOmniCollection(col);
    return {
      kind: col.kind,
      source: col.source,
      id: col.id,
      ref: col.ref,
      name: col.name || '未命名',
      artist: col.artist || '',
      coverUrl: col.coverUrl || null,
      trackCount: typeof col.trackCount === 'number' ? col.trackCount : null,
      albumCount: typeof col.albumCount === 'number' ? col.albumCount : null,
    };
  }

  function refreshProviders() {
    try {
      if (!hasOmniApi || typeof folium.omni?.listProviders !== 'function') {
        currentSnapshot.providers = [];
        return [];
      }
      const list = folium.omni.listProviders() || [];
      const mapped = list.map((p) => ({
        providerId: p.providerId,
        displayName: p.displayName || p.providerId,
        shortName: p.shortName || p.displayName || p.providerId,
        selected: Boolean(p.selected),
        configured: Boolean(p.configured),
        supports: {
          search: Boolean(p.supports?.search),
          resolve: Boolean(p.supports?.resolve),
          albums: Boolean(p.supports?.albums),
          artists: Boolean(p.supports?.artists),
        },
      }));
      currentSnapshot.providers = mapped;
      return mapped;
    } catch {
      return currentSnapshot.providers;
    }
  }

  // =========================================================================
  // Mod-Owned Storage (Recent Tracks & Quick Saved Tracks via folium.storage)
  // =========================================================================

  function sanitizeStoredTrack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const source = typeof raw.source === 'string' && raw.source ? raw.source : null;
    const id = raw.id !== null && raw.id !== undefined && String(raw.id) !== '' ? String(raw.id) : null;
    if (!source || !id) return null;
    return {
      source,
      id,
      title: typeof raw.title === 'string' && raw.title ? raw.title : '未知曲目',
      artist: typeof raw.artist === 'string' ? raw.artist : '未知艺人',
      album: typeof raw.album === 'string' ? raw.album : '',
      coverUrl: typeof raw.coverUrl === 'string' && raw.coverUrl ? raw.coverUrl : null,
      savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : Date.now(),
    };
  }

  function normalizeStoredList(rawList, limit) {
    if (!Array.isArray(rawList)) return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < rawList.length && out.length < limit; i++) {
      const item = sanitizeStoredTrack(rawList[i]);
      if (!item) continue;
      const key = songPortableKey(item.source, item.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  async function persistTrackList(storageKey, list) {
    if (!hasStorageApi || isDisposed) return;
    try {
      await folium.storage.set(storageKey, list);
    } catch (err) {
      folium.log.warn(`Failed to save ${storageKey}`, err);
    }
  }

  function applyRecentOp(list, op) {
    if (op.type === 'clear') return [];
    if (op.type === 'add' && op.entry) {
      const key = songPortableKey(op.entry.source, op.entry.id);
      return [
        op.entry,
        ...list.filter((item) => songPortableKey(item.source, item.id) !== key),
      ].slice(0, MAX_RECENT_TRACKS);
    }
    return list;
  }

  function applySavedOp(list, op) {
    if (op.type === 'remove' && op.key) {
      return list.filter((item) => songPortableKey(item.source, item.id) !== op.key);
    }
    if (op.type === 'toggle' && op.entry) {
      const key = songPortableKey(op.entry.source, op.entry.id);
      const exists = list.some((item) => songPortableKey(item.source, item.id) === key);
      if (exists) {
        return list.filter((item) => songPortableKey(item.source, item.id) !== key);
      }
      return [op.entry, ...list].slice(0, MAX_SAVED_TRACKS);
    }
    return list;
  }

  async function loadStoredTrackLists() {
    if (!hasStorageApi || isDisposed) {
      storageLoaded = true;
      return;
    }
    try {
      const [rawRecent, rawSaved] = await Promise.all([
        folium.storage.get(STORAGE_KEY_RECENT).catch(() => []),
        folium.storage.get(STORAGE_KEY_SAVED).catch(() => []),
      ]);
      if (isDisposed) return;

      let mergedRecent = normalizeStoredList(rawRecent, MAX_RECENT_TRACKS);
      let mergedSaved = normalizeStoredList(rawSaved, MAX_SAVED_TRACKS);
      const hadRecentOps = pendingRecentOps.length > 0;
      const hadSavedOps = pendingSavedOps.length > 0;

      for (const op of pendingRecentOps) {
        mergedRecent = applyRecentOp(mergedRecent, op);
      }
      for (const op of pendingSavedOps) {
        mergedSaved = applySavedOp(mergedSaved, op);
      }
      pendingRecentOps = [];
      pendingSavedOps = [];
      storageLoaded = true;

      recentTracks = mergedRecent;
      savedTracks = mergedSaved;
      currentSnapshot.recentTracks = recentTracks;
      currentSnapshot.savedTracks = savedTracks;

      if (hadRecentOps) void persistTrackList(STORAGE_KEY_RECENT, recentTracks);
      if (hadSavedOps) void persistTrackList(STORAGE_KEY_SAVED, savedTracks);
      void pushSnapshot({ recentTracks, savedTracks });
    } catch {
      storageLoaded = true;
    }
  }

  function recordRecentSong(songSnap) {
    if (!isPortableOnlineSong(songSnap)) return;
    const entry = sanitizeStoredTrack({
      source: songSnap.source,
      id: songSnap.id,
      title: songSnap.title,
      artist: songSnap.artist,
      album: songSnap.album || '',
      coverUrl: songSnap.coverUrl || null,
      savedAt: Date.now(),
    });
    if (!entry) return;
    const op = { type: 'add', entry };
    recentTracks = applyRecentOp(recentTracks, op);
    currentSnapshot.recentTracks = recentTracks;
    if (storageLoaded) {
      void persistTrackList(STORAGE_KEY_RECENT, recentTracks);
    } else {
      pendingRecentOps.push(op);
    }
  }

  function toggleSavedTrackEntry(rawPayload) {
    const candidate = rawPayload && rawPayload.source && rawPayload.id
      ? rawPayload
      : currentSnapshot.song;
    const entry = sanitizeStoredTrack({
      source: candidate?.source,
      id: candidate?.id,
      title: candidate?.title,
      artist: candidate?.artist,
      album: candidate?.album || '',
      coverUrl: candidate?.coverUrl || null,
      savedAt: Date.now(),
    });
    if (!entry) return false;
    const key = songPortableKey(entry.source, entry.id);
    const existedBefore = savedTracks.some((item) => songPortableKey(item.source, item.id) === key);
    const op = { type: 'toggle', entry };
    savedTracks = applySavedOp(savedTracks, op);
    currentSnapshot.savedTracks = savedTracks;
    if (storageLoaded) {
      void persistTrackList(STORAGE_KEY_SAVED, savedTracks);
    } else {
      pendingSavedOps.push(op);
    }
    void pushSnapshot({ savedTracks });
    return !existedBefore;
  }

  function removeSavedTrackEntry(payload) {
    const key = songPortableKey(payload?.source, payload?.id);
    if (!key) return;
    const op = { type: 'remove', key };
    const next = applySavedOp(savedTracks, op);
    if (next.length !== savedTracks.length || !storageLoaded) {
      savedTracks = next;
      currentSnapshot.savedTracks = savedTracks;
      if (storageLoaded) {
        void persistTrackList(STORAGE_KEY_SAVED, savedTracks);
      } else {
        pendingSavedOps.push(op);
      }
      void pushSnapshot({ savedTracks });
    }
  }

  function clearRecentTracksList() {
    recentTracks = [];
    currentSnapshot.recentTracks = [];
    if (storageLoaded) {
      void persistTrackList(STORAGE_KEY_RECENT, []);
    } else {
      pendingRecentOps = [{ type: 'clear' }];
    }
    void pushSnapshot({ recentTracks: [] });
  }

  /**
   * Refreshes the play queue using public folium.playback.getQueue API with pagination
   * and clamps out-of-bounds page indices when the host queue shrinks.
   * @param {number} pageIndex
   */
  function refreshQueue(pageIndex = currentQueuePageIndex) {
    try {
      if (typeof folium.playback.getQueue === 'function') {
        let safePage = Math.max(0, Math.floor(Number(pageIndex) || 0));
        let page = folium.playback.getQueue({ offset: safePage * QUEUE_PAGE_SIZE, limit: QUEUE_PAGE_SIZE });
        if (page && typeof page.length === 'number' && safePage > 0 && safePage * QUEUE_PAGE_SIZE >= page.length) {
          safePage = Math.max(0, Math.ceil(page.length / QUEUE_PAGE_SIZE) - 1);
          if (page.length > 0) {
            page = folium.playback.getQueue({ offset: safePage * QUEUE_PAGE_SIZE, limit: QUEUE_PAGE_SIZE });
          }
        }
        if (page && Array.isArray(page.items)) {
          currentQueuePageIndex = safePage;
          currentSnapshot.queuePage = safePage;
          currentSnapshot.queuePageSize = QUEUE_PAGE_SIZE;
          currentSnapshot.queueTotal = typeof page.length === 'number' ? page.length : page.items.length;
          currentSnapshot.currentIndex = page.currentIndex;
          currentSnapshot.queue = page.items.map((item) => {
            if (item.song) rememberOmniSong(item.song);
            const details = item.song ? resolveSongDetails(item.song) : { coverUrl: null };
            return {
              index: item.index,
              id: item.song?.id ?? null,
              source: item.song?.source ?? null,
              ref: item.song?.ref || null,
              title: item.song?.title || '未知曲目',
              artist: item.song?.artist || '未知艺人',
              album: item.song?.album || '',
              coverUrl: details.coverUrl,
              active: item.index === page.currentIndex,
            };
          });
        }
      }
    } catch {
      // Ignored
    }
  }

  function formatLyricsLines(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return null;
    return {
      lines: lines.map((line) => {
        let renderEndTime;
        if (typeof line?.renderHints?.renderEndTime === 'number' && Number.isFinite(line.renderHints.renderEndTime)) {
          renderEndTime = line.renderHints.renderEndTime;
        } else if (typeof folium.lyrics?.getLineRenderEndTime === 'function') {
          try {
            const hinted = folium.lyrics.getLineRenderEndTime(line);
            if (typeof hinted === 'number' && Number.isFinite(hinted)) {
              renderEndTime = hinted;
            }
          } catch {}
        }
        return {
          startTime: typeof line.startTime === 'number' ? line.startTime : 0,
          endTime: typeof line.endTime === 'number' ? line.endTime : 0,
          ...(renderEndTime !== undefined ? { renderEndTime } : {}),
          fullText: line.fullText || line.text || '',
          text: line.fullText || line.text || '',
          translation: line.translation || '',
          words: Array.isArray(line.words) ? line.words.map((w) => ({
            text: w.text || '',
            startTime: typeof w.startTime === 'number' ? w.startTime : 0,
            endTime: typeof w.endTime === 'number' ? w.endTime : 0,
          })) : null,
        };
      }),
    };
  }

  function syncHostLyricsAndSong(resetIfEmpty = false, preserveSong = false) {
    try {
      const hostState = folium.playback.getState();
      if (hostState) {
        currentSnapshot.liked = Boolean(hostState.liked);
        currentSnapshot.canLike = Boolean(hostState.canLike);
      }
      if (!preserveSong) {
        if (hostState?.song) {
          rememberOmniSong(hostState.song);
          currentSnapshot.song = buildSongSnapshot(hostState.song);
        } else if (hostState && hostState.song === null && resetIfEmpty) {
          currentSnapshot.song = null;
        }
      }

      if (typeof folium.lyrics?.getLines === 'function') {
        const lines = folium.lyrics.getLines();
        if (Array.isArray(lines) && lines.length > 0) {
          currentSnapshot.lyrics = formatLyricsLines(lines);
        } else if (resetIfEmpty) {
          currentSnapshot.lyrics = null;
        }
      } else if (resetIfEmpty && !currentSnapshot.lyrics) {
        currentSnapshot.lyrics = null;
      }
    } catch {
      // Ignored
    }
  }

  // =========================================================================
  // Public Omni Search, Album/Artist Exploration & Queue Replacement
  // =========================================================================

  function abortControllerSafe(ctrl) {
    try {
      ctrl?.abort();
    } catch {}
  }

  async function resolveLiveSongFromPayload(payload, signal) {
    if (!payload) return null;
    if (payload.ref && omniSongMap.has(payload.ref)) {
      return omniSongMap.get(payload.ref);
    }
    if (hasOmniApi && typeof folium.omni?.resolveSongs === 'function' && payload.source && payload.id) {
      const res = await folium.omni.resolveSongs(
        [{ source: String(payload.source), id: String(payload.id) }],
        signal ? { signal } : undefined,
      );
      if (isDisposed) return null;
      const found = Array.isArray(res) ? res.find((r) => r?.status === 'found' && r.song) : null;
      if (found?.song) {
        rememberOmniSong(found.song);
        return found.song;
      }
    }
    return null;
  }

  function isPlayCancelled(seq, controller) {
    return isDisposed || seq !== playSeq || Boolean(controller?.signal?.aborted);
  }

  async function resolveKeysInBatches(keys, seq, controller) {
    const results = [];
    if (!hasOmniApi || typeof folium.omni?.resolveSongs !== 'function') {
      return results;
    }
    const BATCH_SIZE = 50;
    for (let offset = 0; offset < keys.length; offset += BATCH_SIZE) {
      if (isPlayCancelled(seq, controller)) return null;
      const chunk = keys.slice(offset, offset + BATCH_SIZE);
      const res = await folium.omni.resolveSongs(
        chunk,
        controller ? { signal: controller.signal } : undefined,
      );
      if (isPlayCancelled(seq, controller)) return null;
      if (Array.isArray(res)) {
        for (let i = 0; i < res.length; i++) {
          results.push(res[i]);
        }
      } else {
        for (let i = 0; i < chunk.length; i++) {
          results.push(null);
        }
      }
    }
    return results;
  }

  async function replaceHostQueueWithSongs(songs, startIndex = 0, seq = playSeq, controller = activePlayController) {
    if (!Array.isArray(songs) || songs.length === 0 || isPlayCancelled(seq, controller)) return false;
    const validSongs = songs.filter((s) => s && s.ref);
    if (validSongs.length === 0) return false;
    const clampedStart = Math.max(0, Math.min(validSongs.length - 1, Math.floor(Number(startIndex) || 0)));

    try {
      if (hasReplaceQueueApi) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (isPlayCancelled(seq, controller)) return false;
          const qSnap = folium.playback.getQueue({ offset: 0, limit: 1 });
          const expectedVersion = qSnap?.version || '';
          const res = await folium.playback.replaceQueue(validSongs, { expectedVersion });
          if (isPlayCancelled(seq, controller)) return false;
          if (res?.status === 'replaced') {
            const target = validSongs[clampedStart];
            await folium.playback.playQueueItem(clampedStart, target?.ref || undefined);
            return true;
          }
          if (res?.reason !== 'stale-version') {
            break;
          }
        }
      }

      if (isPlayCancelled(seq, controller)) return false;
      const fallbackSong = validSongs[clampedStart];
      if (fallbackSong && typeof folium.playback.playSong === 'function') {
        return Boolean(await folium.playback.playSong(fallbackSong));
      }
    } catch (err) {
      if (!isPlayCancelled(seq, controller) && err?.code !== 'aborted') {
        folium.log.warn('replaceHostQueueWithSongs failed', err);
      }
    }
    return false;
  }

  async function handleSearchOnlineSongs(payload) {
    if (!hasOmniApi || typeof folium.omni?.searchSongs !== 'function') {
      void pushSnapshot({
        searchState: {
          query: String(payload?.query || ''),
          providerId: payload?.providerId || '',
          items: [],
          nextCursor: null,
          total: null,
          loading: false,
          error: '当前宿主版本不支持在线目录搜索',
        },
      });
      return;
    }

    const query = String(payload?.query || '').trim();
    const providerId = typeof payload?.providerId === 'string' && payload.providerId ? payload.providerId : undefined;
    const cursor = typeof payload?.cursor === 'string' && payload.cursor ? payload.cursor : undefined;
    const append = Boolean(cursor && payload?.append);

    if (!query) {
      abortControllerSafe(activeSearchController);
      activeSearchController = null;
      void pushSnapshot({
        searchState: {
          query: '',
          providerId: providerId || '',
          items: [],
          nextCursor: null,
          total: null,
          loading: false,
          error: null,
        },
      });
      return;
    }

    abortControllerSafe(activeSearchController);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeSearchController = controller;
    const seq = ++searchSeq;

    const prevItems = append && Array.isArray(currentSnapshot.searchState?.items)
      ? currentSnapshot.searchState.items
      : [];

    void pushSnapshot({
      searchState: {
        query,
        providerId: providerId || '',
        items: prevItems,
        nextCursor: append ? currentSnapshot.searchState?.nextCursor || null : null,
        total: append ? currentSnapshot.searchState?.total ?? null : null,
        loading: true,
        error: null,
      },
    });

    try {
      const page = await folium.omni.searchSongs(query, {
        ...(providerId ? { providerId } : {}),
        ...(cursor ? { cursor } : {}),
        limit: 25,
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (isDisposed || seq !== searchSeq) return;
      const mapped = (Array.isArray(page?.items) ? page.items : []).map(formatOmniTrackDto);
      const merged = append ? [...prevItems, ...mapped] : mapped;
      void pushSnapshot({
        searchState: {
          query,
          providerId: providerId || '',
          items: merged,
          nextCursor: page?.nextCursor || null,
          total: typeof page?.total === 'number' ? page.total : null,
          loading: false,
          error: null,
        },
      });
    } catch (err) {
      if (isDisposed || seq !== searchSeq) return;
      const msg = formatOmniError(err);
      if (msg === null) return;
      void pushSnapshot({
        searchState: {
          query,
          providerId: providerId || '',
          items: prevItems,
          nextCursor: null,
          total: null,
          loading: false,
          error: msg,
        },
      });
    }
  }

  async function handleFetchExplore(payload) {
    if (!hasOmniApi) {
      void pushSnapshot({
        exploreData: {
          view: 'overview',
          loading: false,
          error: '当前宿主不支持在线目录浏览',
          album: null,
          artists: [],
        },
      });
      return;
    }

    abortControllerSafe(activeExploreController);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeExploreController = controller;
    const seq = ++exploreSeq;
    const kind = payload?.kind || 'overview';
    const cursor = typeof payload?.cursor === 'string' && payload.cursor ? payload.cursor : undefined;
    const append = Boolean(cursor && payload?.append);

    if (kind === 'overview') {
      exploreStack = [];
      const hostState = folium.playback.getState();
      const song = hostState?.song || null;
      if (!song || !song.ref || !isPortableOnlineSong(song)) {
        void pushSnapshot({
          exploreData: {
            view: 'overview',
            canGoBack: false,
            songTitle: song?.title || '',
            songArtist: song?.artist || '',
            album: null,
            artists: [],
            loading: false,
            error: song ? '当前为本地或非在线曲目，暂无关联的在线专辑/歌手信息' : '当前暂无正在播放的在线曲目',
          },
        });
        return;
      }

      void pushSnapshot({
        exploreData: {
          view: 'overview',
          canGoBack: false,
          songTitle: song.title || '',
          songArtist: song.artist || '',
          album: null,
          artists: [],
          loading: true,
          error: null,
        },
      });

      try {
        const signalOpt = controller ? { signal: controller.signal } : undefined;
        const [albumRes, artistsRes] = await Promise.allSettled([
          typeof folium.omni.getAlbum === 'function' ? folium.omni.getAlbum(song, signalOpt) : Promise.resolve(null),
          typeof folium.omni.getArtists === 'function' ? folium.omni.getArtists(song, signalOpt) : Promise.resolve([]),
        ]);
        if (isDisposed || seq !== exploreSeq) return;

        const album = albumRes.status === 'fulfilled' && albumRes.value
          ? formatOmniCollectionDto(albumRes.value)
          : null;
        const artists = artistsRes.status === 'fulfilled' && Array.isArray(artistsRes.value)
          ? artistsRes.value.map(formatOmniCollectionDto).filter(Boolean)
          : [];

        let error = null;
        if (!album && artists.length === 0) {
          const rejected = albumRes.status === 'rejected' ? albumRes.reason : (artistsRes.status === 'rejected' ? artistsRes.reason : null);
          error = (rejected ? formatOmniError(rejected) : null) || '当前音源未提供该曲目的专辑或歌手目录';
        }

        void pushSnapshot({
          exploreData: {
            view: 'overview',
            canGoBack: false,
            songTitle: song.title || '',
            songArtist: song.artist || '',
            album,
            artists,
            loading: false,
            error,
          },
        });
      } catch (err) {
        if (isDisposed || seq !== exploreSeq) return;
        const msg = formatOmniError(err);
        if (msg === null) return;
        void pushSnapshot({
          exploreData: {
            view: 'overview',
            canGoBack: false,
            songTitle: song.title || '',
            songArtist: song.artist || '',
            album: null,
            artists: [],
            loading: false,
            error: msg,
          },
        });
      }
      return;
    }

    if (!append && currentSnapshot.exploreData && !currentSnapshot.exploreData.loading) {
      exploreStack.push(currentSnapshot.exploreData);
      if (exploreStack.length > 10) {
        exploreStack.shift();
      }
    }

    const colRef = payload?.collectionRef;
    let collection = colRef ? omniCollectionMap.get(colRef) : null;
    if (!collection && payload?.source && payload?.id && payload?.collectionKind && typeof folium.omni.resolveCollection === 'function') {
      try {
        collection = await folium.omni.resolveCollection(
          { source: payload.source, kind: payload.collectionKind, id: String(payload.id) },
          controller ? { signal: controller.signal } : undefined,
        );
        if (collection) rememberOmniCollection(collection);
      } catch {}
    }

    if (isDisposed || seq !== exploreSeq) return;
    if (!collection) {
      exploreStack = [];
      void pushSnapshot({
        exploreData: {
          view: 'overview',
          canGoBack: false,
          loading: false,
          error: '专辑或歌手信息已失效，请返回重试',
          album: null,
          artists: [],
        },
      });
      return;
    }

    const colDto = formatOmniCollectionDto(collection);
    const prevItems = append && Array.isArray(currentSnapshot.exploreData?.items)
      ? currentSnapshot.exploreData.items
      : [];
    const canGoBack = exploreStack.length > 0;

    if (kind === 'artistAlbums') {
      void pushSnapshot({
        exploreData: {
          view: 'artistAlbums',
          canGoBack,
          collection: colDto,
          items: prevItems,
          nextCursor: append ? currentSnapshot.exploreData?.nextCursor || null : null,
          total: append ? currentSnapshot.exploreData?.total ?? null : null,
          loading: true,
          error: null,
        },
      });
      try {
        const page = await folium.omni.getArtistAlbums(collection, {
          ...(cursor ? { cursor } : {}),
          limit: 30,
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (isDisposed || seq !== exploreSeq) return;
        const mapped = (Array.isArray(page?.items) ? page.items : []).map(formatOmniCollectionDto).filter(Boolean);
        void pushSnapshot({
          exploreData: {
            view: 'artistAlbums',
            canGoBack,
            collection: colDto,
            items: append ? [...prevItems, ...mapped] : mapped,
            nextCursor: page?.nextCursor || null,
            total: typeof page?.total === 'number' ? page.total : null,
            loading: false,
            error: null,
          },
        });
      } catch (err) {
        if (isDisposed || seq !== exploreSeq) return;
        const msg = formatOmniError(err);
        if (msg === null) return;
        void pushSnapshot({
          exploreData: {
            view: 'artistAlbums',
            canGoBack,
            collection: colDto,
            items: prevItems,
            nextCursor: null,
            total: null,
            loading: false,
            error: msg,
          },
        });
      }
      return;
    }

    // kind === 'tracks' (album or artist songs)
    void pushSnapshot({
      exploreData: {
        view: 'tracks',
        canGoBack,
        collection: colDto,
        items: prevItems,
        nextCursor: append ? currentSnapshot.exploreData?.nextCursor || null : null,
        total: append ? currentSnapshot.exploreData?.total ?? null : null,
        loading: true,
        error: null,
      },
    });

    try {
      const page = await folium.omni.getTracks(collection, {
        ...(cursor ? { cursor } : {}),
        limit: 50,
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (isDisposed || seq !== exploreSeq) return;
      const mapped = (Array.isArray(page?.items) ? page.items : []).map(formatOmniTrackDto);
      void pushSnapshot({
        exploreData: {
          view: 'tracks',
          canGoBack,
          collection: colDto,
          items: append ? [...prevItems, ...mapped] : mapped,
          nextCursor: page?.nextCursor || null,
          total: typeof page?.total === 'number' ? page.total : null,
          loading: false,
          error: null,
        },
      });
    } catch (err) {
      if (isDisposed || seq !== exploreSeq) return;
      const msg = formatOmniError(err);
      if (msg === null) return;
      void pushSnapshot({
        exploreData: {
          view: 'tracks',
          canGoBack,
          collection: colDto,
          items: prevItems,
          nextCursor: null,
          total: null,
          loading: false,
          error: msg,
        },
      });
    }
  }

  function handleExploreBack() {
    abortControllerSafe(activeExploreController);
    activeExploreController = null;
    exploreSeq += 1;
    if (exploreStack.length > 0) {
      const prev = exploreStack.pop();
      void pushSnapshot({
        exploreData: {
          ...prev,
          canGoBack: exploreStack.length > 0,
          loading: false,
        },
      });
    } else {
      void handleFetchExplore({ kind: 'overview' });
    }
  }

  async function handlePlayStoredTracks(payload) {
    const sourceList = payload?.list === 'recent' ? recentTracks : savedTracks;
    if (!Array.isArray(sourceList) || sourceList.length === 0) return;
    if (!hasOmniApi || typeof folium.omni?.resolveSongs !== 'function') return;

    abortControllerSafe(activePlayController);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activePlayController = controller;
    const seq = ++playSeq;

    const requestedStart = Math.max(0, Math.min(sourceList.length - 1, Math.floor(Number(payload?.startIndex) || 0)));

    try {
      const keys = sourceList.map((item) => ({ source: item.source, id: item.id }));
      const resolutions = await resolveKeysInBatches(keys, seq, controller);
      if (!resolutions || isPlayCancelled(seq, controller)) return;

      const resolvedSongs = [];
      let mappedStartIndex = 0;
      let startResolved = false;
      for (let i = 0; i < resolutions.length; i++) {
        const r = resolutions[i];
        if (r?.status === 'found' && r.song) {
          rememberOmniSong(r.song);
          if (i === requestedStart) {
            mappedStartIndex = resolvedSongs.length;
            startResolved = true;
          } else if (!startResolved && i > requestedStart) {
            mappedStartIndex = resolvedSongs.length;
            startResolved = true;
          }
          resolvedSongs.push(r.song);
        }
      }
      if (resolvedSongs.length > 0) {
        await replaceHostQueueWithSongs(resolvedSongs, mappedStartIndex, seq, controller);
      }
    } catch (err) {
      if (!isPlayCancelled(seq, controller) && err?.code !== 'aborted') {
        folium.log.warn('playAllStoredTracks failed', err);
      }
    }
  }

  async function handleReplaceQueueWithTracks(payload) {
    const rawTracks = Array.isArray(payload?.tracks)
      ? payload.tracks
      : (Array.isArray(currentSnapshot.exploreData?.items) ? currentSnapshot.exploreData.items : []);
    if (rawTracks.length === 0) return;

    abortControllerSafe(activePlayController);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activePlayController = controller;
    const seq = ++playSeq;

    const requestedStart = Math.max(0, Math.min(rawTracks.length - 1, Math.floor(Number(payload?.startIndex) || 0)));
    const slots = new Array(rawTracks.length).fill(null);
    const unresolvedSlots = [];
    const unresolvedKeys = [];

    for (let i = 0; i < rawTracks.length; i++) {
      const t = rawTracks[i];
      const cached = t?.ref ? omniSongMap.get(t.ref) : null;
      if (cached) {
        slots[i] = cached;
      } else if (t?.source && t?.id) {
        unresolvedSlots.push(i);
        unresolvedKeys.push({ source: String(t.source), id: String(t.id) });
      }
    }

    try {
      if (unresolvedKeys.length > 0) {
        const resolved = await resolveKeysInBatches(unresolvedKeys, seq, controller);
        if (!resolved || isPlayCancelled(seq, controller)) return;
        for (let i = 0; i < resolved.length; i++) {
          const r = resolved[i];
          if (r?.status === 'found' && r.song) {
            rememberOmniSong(r.song);
            slots[unresolvedSlots[i]] = r.song;
          }
        }
      }

      if (isPlayCancelled(seq, controller)) return;
      const finalSongs = [];
      let mappedStartIndex = 0;
      let startMapped = false;
      for (let i = 0; i < slots.length; i++) {
        if (slots[i]) {
          if (i === requestedStart) {
            mappedStartIndex = finalSongs.length;
            startMapped = true;
          } else if (!startMapped && i > requestedStart) {
            mappedStartIndex = finalSongs.length;
            startMapped = true;
          }
          finalSongs.push(slots[i]);
        }
      }
      if (finalSongs.length > 0) {
        await replaceHostQueueWithSongs(finalSongs, mappedStartIndex, seq, controller);
      }
    } catch (err) {
      if (!isPlayCancelled(seq, controller) && err?.code !== 'aborted') {
        folium.log.warn('replaceQueueWithTracks failed', err);
      }
    }
  }

  // =========================================================================
  // High-Precision Background-Resilient Audio Clock
  // =========================================================================

  let lastObservedHostPos = -1;
  let lastObservedHostWallTime = 0;
  let songSwitchWallTime = 0;
  let pendingSeekTarget = null;
  let pendingSeekWallTime = 0;
  let lastLocalSeekWallTime = 0;
  let quickSyncTimerA = null;
  let quickSyncTimerB = null;

  function isPlaybackStoreActive() {
    try {
      const hostState = folium.playback.getState();
      return hostState?.state === 'playing';
    } catch {
      return true;
    }
  }

  function samplePlaybackClock() {
    const now = Date.now();
    let hostState = null;
    try {
      hostState = folium.playback.getState();
    } catch {}

    const state = normalizePlayerState(hostState?.state || currentSnapshot.playerState);
    const duration = (typeof hostState?.duration === 'number' && Number.isFinite(hostState.duration) && hostState.duration > 0)
      ? hostState.duration
      : currentSnapshot.duration;

    const hostPos = (typeof hostState?.position === 'number' && Number.isFinite(hostState.position))
      ? hostState.position
      : null;

    const hostPosChanged = hostPos !== null && Math.abs(hostPos - lastObservedHostPos) > 0.0005;
    if (hostPosChanged) {
      lastObservedHostPos = hostPos;
      lastObservedHostWallTime = now;
    }

    const isStorePlaying = isPlaybackStoreActive();
    const inSeekWindow = pendingSeekTarget !== null && (now - pendingSeekWallTime) < 1500;
    const inSwitchWindow = (now - songSwitchWallTime) < 2500;

    if (state !== 'playing' || !isStorePlaying) {
      let heldPos = currentSnapshot.currentTime;
      if (inSeekWindow) {
        heldPos = pendingSeekTarget;
      } else if (inSwitchWindow) {
        heldPos = 0;
      } else if (hostPos !== null) {
        heldPos = Math.max(0, hostPos);
      }
      return {
        position: duration > 0 ? Math.min(duration, heldPos) : heldPos,
        duration,
        state,
        isAdvancing: false,
        updatedAt: now,
        isFresh: true,
      };
    }

    if (inSeekWindow) {
      if (hostPos !== null && Math.abs(hostPos - pendingSeekTarget) < 0.8) {
        pendingSeekTarget = null;
      } else {
        return {
          position: duration > 0 ? Math.min(duration, pendingSeekTarget) : pendingSeekTarget,
          duration,
          state,
          isAdvancing: false,
          updatedAt: now,
          isFresh: true,
        };
      }
    }

    if (inSwitchWindow) {
      if (hostPos === null || hostPos <= 0.005) {
        return {
          position: 0,
          duration,
          state,
          isAdvancing: false,
          updatedAt: now,
          isFresh: true,
        };
      }
      songSwitchWallTime = 0;
    }

    if (hostPos !== null) {
      if (!hostPosChanged && lastObservedHostWallTime > 0) {
        const elapsedSec = Math.max(0, (now - lastObservedHostWallTime) / 1000);
        const extrapolated = duration > 0
          ? Math.min(duration, hostPos + elapsedSec)
          : (hostPos + elapsedSec);
        return {
          position: extrapolated,
          duration,
          state,
          isAdvancing: true,
          updatedAt: now,
          isFresh: false,
        };
      }
      return {
        position: hostPos,
        duration,
        state,
        isAdvancing: true,
        updatedAt: now,
        isFresh: true,
      };
    }

    return {
      position: currentSnapshot.currentTime,
      duration,
      state,
      isAdvancing: false,
      updatedAt: now,
      isFresh: false,
    };
  }

  function refreshPlaybackState() {
    try {
      const state = folium.playback.getState();
      if (state) {
        currentSnapshot.liked = Boolean(state.liked);
        currentSnapshot.canLike = Boolean(state.canLike);
        if (state.song) {
          rememberOmniSong(state.song);
          currentSnapshot.song = buildSongSnapshot(state.song);
        }
        const clock = samplePlaybackClock();
        currentSnapshot.playerState = clock.state;
        currentSnapshot.isAdvancing = clock.isAdvancing;
        currentSnapshot.currentTime = clock.position;
        currentSnapshot.duration = clock.duration;
        currentSnapshot.updatedAt = clock.updatedAt;
      }
      syncHostLyricsAndSong();
    } catch {
      // Ignored
    }
  }

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

  // Register Settings in Mod Panel
  const settingsSection = folium.registries.settingsSections.register({
    id: 'general',
    label: {
      'zh-CN': '任务栏抽屉设置',
      en: 'Taskbar Drawer Settings',
    },
    description: {
      'zh-CN': '配置任务栏歌词抽屉的交互模式、所在屏幕与显示效果',
      en: 'Configure taskbar lyrics drawer interaction mode, target display, and visual effects',
    },
    settings: [
      {
        key: 'interactionMode',
        type: 'select',
        label: {
          'zh-CN': '任务栏交互模式',
          en: 'Interaction Mode',
        },
        description: {
          'zh-CN': '保留常规抽屉可交互模式，或开启鼠标悬停隐藏（鼠标移入任务栏时自动隐藏歌词栏并穿透点击系统任务栏）',
          en: 'Keep standard interactive drawer mode, or auto-hide and click-through when hovering the taskbar',
        },
        defaultValue: 'standard',
        options: [
          {
            value: 'standard',
            label: {
              'zh-CN': '常规抽屉模式（保留当前模式）',
              en: 'Standard Drawer Mode (Interactive)',
            },
          },
          {
            value: 'hover-hide',
            label: {
              'zh-CN': '悬停隐藏模式（鼠标移入隐藏并穿透）',
              en: 'Hover Hide Mode (Auto-hide on hover)',
            },
          },
        ],
      },
      {
        key: 'targetDisplay',
        type: 'select',
        label: {
          'zh-CN': '显示屏幕选择',
          en: 'Target Display',
        },
        description: {
          'zh-CN': '切换任务栏歌词显示的屏幕（也可在任务栏歌词弹窗底部一键切屏）',
          en: 'Select which monitor displays the taskbar lyrics (also switchable from the drawer popup menu)',
        },
        defaultValue: 'primary',
        options: [
          {
            value: 'primary',
            label: {
              'zh-CN': '主显示器',
              en: 'Primary Display',
            },
          },
          {
            value: 'secondary',
            label: {
              'zh-CN': '副显示器（自动优先副屏）',
              en: 'Secondary Display (Prefer non-primary)',
            },
          },
          {
            value: 'display:0',
            label: {
              'zh-CN': '屏幕 1',
              en: 'Display 1',
            },
          },
          {
            value: 'display:1',
            label: {
              'zh-CN': '屏幕 2',
              en: 'Display 2',
            },
          },
          {
            value: 'display:2',
            label: {
              'zh-CN': '屏幕 3',
              en: 'Display 3',
            },
          },
          {
            value: 'display:3',
            label: {
              'zh-CN': '屏幕 4',
              en: 'Display 4',
            },
          },
        ],
      },
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

  // Register Command Palette & Global Shortcut commands
  if (typeof folium.registries?.commands?.register === 'function') {
    folium.registries.commands.register({
      id: 'toggle-drawer',
      label: {
        'zh-CN': '展开/收起任务栏歌词',
        en: 'Toggle Taskbar Lyrics',
      },
      description: {
        'zh-CN': '展开或收起 Windows 任务栏歌词',
        en: 'Expand or collapse the Windows taskbar lyrics',
      },
      globalShortcut: true,
      run: () => {
        void folium.rpc.call('toggleDrawer');
      },
    });
    folium.registries.commands.register({
      id: 'switch-display',
      label: {
        'zh-CN': '切换任务栏歌词显示器',
        en: 'Switch Taskbar Lyrics Display',
      },
      description: {
        'zh-CN': '在多台显示器之间切换任务栏歌词位置',
        en: 'Cycle the active display for the taskbar lyrics',
      },
      globalShortcut: true,
      run: () => {
        void folium.rpc.call('switchDisplay');
      },
    });
  }

  function syncSettings() {
    try {
      if (settingsAccess?.get) {
        const values = settingsAccess.get();
        const showTr = values?.showTranslation;
        const useBg = values?.useCoverBackground;
        const mode = values?.interactionMode === 'hover-hide' ? 'hover-hide' : 'standard';
        const display = normalizeDisplayTarget(values?.targetDisplay);
        currentSnapshot.settings = {
          interactionMode: mode,
          targetDisplay: display,
          showTranslation: typeof showTr === 'boolean' ? showTr : true,
          useCoverBackground: typeof useBg === 'boolean' ? useBg : true,
        };
      }
    } catch {
      // Ignored
    }
  }

  syncSettings();

  const unsubs = [];

  if (typeof settingsAccess?.onChange === 'function') {
    unsubs.push(settingsAccess.onChange(() => {
      syncSettings();
      void pushSnapshot({ settings: currentSnapshot.settings });
    }));
  }

  let lastAudioSyncPushWallTime = 0;
  let lastAudioSyncPushedTime = -1;

  function clearQuickSyncTimers() {
    if (quickSyncTimerA) {
      clearTimeout(quickSyncTimerA);
      quickSyncTimerA = null;
    }
    if (quickSyncTimerB) {
      clearTimeout(quickSyncTimerB);
      quickSyncTimerB = null;
    }
  }

  function scheduleQuickClockSync() {
    clearQuickSyncTimers();
    quickSyncTimerA = setTimeout(() => {
      quickSyncTimerA = null;
      pushPlaybackAnchor(false, false);
    }, 35);
    quickSyncTimerB = setTimeout(() => {
      quickSyncTimerB = null;
      pushPlaybackAnchor(false, false);
    }, 110);
  }

  function pushPlaybackAnchor(force = false, isSeek = false) {
    try {
      const clock = samplePlaybackClock();
      const now = clock.updatedAt;
      const pos = clock.position;
      const state = clock.state;
      const isAdvancing = Boolean(clock.isAdvancing);
      const prevState = currentSnapshot.playerState;
      const prevAdvancing = Boolean(currentSnapshot.isAdvancing);
      const prevDuration = currentSnapshot.duration;

      currentSnapshot.currentTime = pos;
      currentSnapshot.playerState = state;
      currentSnapshot.isAdvancing = isAdvancing;
      currentSnapshot.duration = clock.duration;
      currentSnapshot.updatedAt = now;

      const durationChanged = clock.duration !== prevDuration;

      if (!force && !clock.isFresh && state === prevState && isAdvancing === prevAdvancing && !durationChanged) {
        return;
      }

      const elapsedWallSec = (lastAudioSyncPushWallTime > 0 && prevAdvancing)
        ? (now - lastAudioSyncPushWallTime) / 1000
        : 0;
      const expectedExtrapolatedPos = lastAudioSyncPushedTime >= 0
        ? lastAudioSyncPushedTime + elapsedWallSec
        : -1;
      const driftFromExtrapolation = expectedExtrapolatedPos >= 0
        ? Math.abs(pos - expectedExtrapolation)
        : 999;
      const wallDiff = now - lastAudioSyncPushWallTime;

      const shouldPush = force
        || lastAudioSyncPushedTime < 0
        || state !== prevState
        || isAdvancing !== prevAdvancing
        || durationChanged
        || driftFromExtrapolation >= 0.08
        || (state === 'playing' && isAdvancing && wallDiff >= 400);

      if (shouldPush) {
        lastAudioSyncPushedTime = pos;
        lastAudioSyncPushWallTime = now;
        void pushSnapshot({
          currentTime: pos,
          duration: currentSnapshot.duration,
          playerState: state,
          isAdvancing,
          updatedAt: now,
          isSeek: Boolean(isSeek),
        });
      }
    } catch {
      // Ignored
    }
  }

  // Listen for Folium Event Bus

  // 1. Song changed
  unsubs.push(folium.events.on('playback.songChanged', (event) => {
    const now = Date.now();
    songSwitchWallTime = now;
    pendingSeekTarget = null;
    pendingSeekWallTime = 0;
    currentSnapshot.currentTime = 0;
    currentSnapshot.isAdvancing = false;
    currentSnapshot.updatedAt = now;
    lastAudioSyncPushedTime = 0;
    lastAudioSyncPushWallTime = now;
    lastObservedHostPos = 0;
    lastObservedHostWallTime = now;

    try {
      const hostState = folium.playback.getState();
      if (hostState) {
        currentSnapshot.playerState = normalizePlayerState(hostState.state || currentSnapshot.playerState);
        currentSnapshot.liked = Boolean(hostState.liked);
        currentSnapshot.canLike = Boolean(hostState.canLike);
        if (typeof hostState.duration === 'number' && Number.isFinite(hostState.duration) && hostState.duration >= 0) {
          currentSnapshot.duration = hostState.duration;
        }
      }
    } catch {}

    const hasEventSong = Boolean(event && Object.prototype.hasOwnProperty.call(event, 'song'));
    if (event && event.song) {
      rememberOmniSong(event.song);
      currentSnapshot.song = buildSongSnapshot(event.song);
    } else if (event && event.song === null) {
      currentSnapshot.song = null;
      currentSnapshot.liked = false;
      currentSnapshot.canLike = false;
    }

    syncHostLyricsAndSong(true, hasEventSong);
    if (currentSnapshot.song) {
      recordRecentSong(currentSnapshot.song);
    }
    refreshQueue();
    void pushSnapshot({
      song: currentSnapshot.song,
      lyrics: currentSnapshot.lyrics,
      liked: currentSnapshot.liked,
      canLike: currentSnapshot.canLike,
      recentTracks: currentSnapshot.recentTracks,
      queue: currentSnapshot.queue,
      queueTotal: currentSnapshot.queueTotal,
      queuePage: currentSnapshot.queuePage,
      currentIndex: currentSnapshot.currentIndex,
      currentTime: 0,
      duration: currentSnapshot.duration,
      playerState: currentSnapshot.playerState,
      isAdvancing: false,
      updatedAt: now,
      isSeek: true,
    });
    scheduleQuickClockSync();
  }));

  // 2. Playback state changed
  unsubs.push(folium.events.on('playback.stateChanged', (event) => {
    if (event && event.state) {
      currentSnapshot.playerState = normalizePlayerState(event.state);
      pushPlaybackAnchor(true, false);
      if (currentSnapshot.playerState === 'playing') {
        scheduleQuickClockSync();
      }
    }
  }));

  // 3. Lyrics loaded
  unsubs.push(folium.events.on('lyrics.loaded', (event) => {
    if (event && Array.isArray(event.lines) && event.lines.length > 0) {
      currentSnapshot.lyrics = formatLyricsLines(event.lines);
      void pushSnapshot({ lyrics: currentSnapshot.lyrics });
    } else {
      syncHostLyricsAndSong(true);
      void pushSnapshot({ lyrics: currentSnapshot.lyrics });
    }
    scheduleQuickClockSync();
  }));

  // 4. Seeked
  unsubs.push(folium.events.on('playback.seeked', (event) => {
    const now = Date.now();
    songSwitchWallTime = 0;
    const eventPos = (typeof event?.position === 'number' && Number.isFinite(event.position))
      ? Math.max(0, event.position)
      : null;
    const isLocalSeekEcho = (now - lastLocalSeekWallTime) < 800
      && pendingSeekTarget !== null
      && eventPos !== null
      && Math.abs(eventPos - pendingSeekTarget) < 0.8;

    if (eventPos !== null) {
      pendingSeekTarget = eventPos;
      pendingSeekWallTime = now;
    }

    const clock = samplePlaybackClock();
    const pos = eventPos !== null ? eventPos : clock.position;
    currentSnapshot.currentTime = pos;
    currentSnapshot.isAdvancing = clock.isAdvancing;
    currentSnapshot.updatedAt = now;
    lastAudioSyncPushedTime = pos;
    lastAudioSyncPushWallTime = now;
    lastObservedHostPos = pos;
    lastObservedHostWallTime = now;
    void pushSnapshot({
      currentTime: pos,
      duration: currentSnapshot.duration,
      playerState: currentSnapshot.playerState,
      isAdvancing: clock.isAdvancing,
      updatedAt: now,
      isSeek: !isLocalSeekEcho,
    });
    scheduleQuickClockSync();
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

  // 6b. Like changed
  unsubs.push(folium.events.on('playback.likeChanged', (event) => {
    let canLike = currentSnapshot.canLike;
    try {
      const hostState = folium.playback.getState();
      if (hostState) canLike = Boolean(hostState.canLike);
    } catch {}
    currentSnapshot.liked = Boolean(event?.liked);
    currentSnapshot.canLike = canLike;
    void pushSnapshot({
      liked: currentSnapshot.liked,
      canLike: currentSnapshot.canLike,
    });
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

  // 7b. Playback failed
  if (hasFoliumAtLeast(1, 7)) {
    try {
      unsubs.push(folium.events.on('playback.failed', () => {
        const now = Date.now();
        currentSnapshot.isAdvancing = false;
        currentSnapshot.updatedAt = now;
        void pushSnapshot({
          playerState: currentSnapshot.playerState,
          isAdvancing: false,
          currentTime: currentSnapshot.currentTime,
          updatedAt: now,
        });
      }));
    } catch {}
    try {
      unsubs.push(folium.events.on('account.changed', () => {
        const providers = refreshProviders();
        void pushSnapshot({ providers });
      }));
    } catch {}
  }

  function syncPostMountThemeIfNeeded() {
    if (hasReceivedThemeEvent || !hasThemeCurrentApi) return;
    const nextTheme = resolveCurrentTheme();
    if (nextTheme && !sameThemeSnapshot(nextTheme, currentSnapshot.theme)) {
      currentSnapshot.theme = nextTheme;
      void pushSnapshot({ theme: nextTheme });
    }
  }

  // 8. Theme changed
  unsubs.push(folium.events.on('theme.changed', (event) => {
    hasReceivedThemeEvent = true;
    const nextTheme = (event && event.theme && typeof event.theme === 'object'
      ? normalizeThemeSnapshot(event.theme)
      : null) || resolveCurrentTheme();
    cachedLiveTheme = nextTheme;
    currentSnapshot.theme = nextTheme;
    void pushSnapshot({ theme: nextTheme });
  }));

  // Initial Sync
  refreshPlaybackState();
  syncHostLyricsAndSong();
  refreshAudioState();
  refreshQueue();
  refreshProviders();
  currentSnapshot.theme = resolveCurrentTheme();

  void pushSnapshot({
    song: currentSnapshot.song,
    playerState: currentSnapshot.playerState,
    isAdvancing: currentSnapshot.isAdvancing,
    currentTime: currentSnapshot.currentTime,
    duration: currentSnapshot.duration,
    updatedAt: currentSnapshot.updatedAt,
    lyrics: currentSnapshot.lyrics,
    liked: currentSnapshot.liked,
    canLike: currentSnapshot.canLike,
    queue: currentSnapshot.queue,
    queueTotal: currentSnapshot.queueTotal,
    queuePage: currentSnapshot.queuePage,
    queuePageSize: currentSnapshot.queuePageSize,
    currentIndex: currentSnapshot.currentIndex,
    loopMode: currentSnapshot.loopMode,
    volume: currentSnapshot.volume,
    isMuted: currentSnapshot.isMuted,
    theme: currentSnapshot.theme,
    providers: currentSnapshot.providers,
    savedTracks: currentSnapshot.savedTracks,
    recentTracks: currentSnapshot.recentTracks,
    settings: currentSnapshot.settings,
    hasPlaybackControls: currentSnapshot.hasPlaybackControls,
  }).finally(() => {
    if (hasRpcPush) {
      void drainPendingActionsOnce();
    }
  });

  void loadStoredTrackLists();

  async function handleClientAction(item) {
    if (!item || !item.action || isDisposed) return;
    switch (item.action) {
      case 'toggle':
        folium.playback.toggle();
        scheduleQuickClockSync();
        break;
      case 'next':
        folium.playback.next();
        break;
      case 'prev':
        folium.playback.previous();
        break;
      case 'toggleLike':
        try {
          if (typeof folium.playback.toggleLike === 'function') {
            folium.playback.toggleLike();
            const hostState = folium.playback.getState();
            if (hostState) {
              currentSnapshot.liked = Boolean(hostState.liked);
              currentSnapshot.canLike = Boolean(hostState.canLike);
              void pushSnapshot({
                liked: currentSnapshot.liked,
                canLike: currentSnapshot.canLike,
              });
            }
          }
        } catch (err) {
          folium.log.warn('Failed to toggleLike', err);
        }
        break;
      case 'seek':
        if (typeof item.payload === 'number') {
          const targetTime = Math.max(0, item.payload);
          const now = Date.now();
          songSwitchWallTime = 0;
          lastLocalSeekWallTime = now;
          pendingSeekTarget = targetTime;
          pendingSeekWallTime = now;
          currentSnapshot.currentTime = targetTime;
          currentSnapshot.updatedAt = now;
          currentSnapshot.isAdvancing = false;
          lastAudioSyncPushedTime = targetTime;
          lastAudioSyncPushWallTime = now;
          lastObservedHostPos = targetTime;
          lastObservedHostWallTime = now;
          folium.playback.seek(targetTime);
          scheduleQuickClockSync();
        }
        break;
      case 'syncDisplayTarget':
        if (typeof item.payload === 'string' && item.payload) {
          const normalized = normalizeDisplayTarget(item.payload);
          currentSnapshot.settings = {
            ...currentSnapshot.settings,
            targetDisplay: normalized,
          };
          try {
            settingsAccess?.set?.({ targetDisplay: normalized });
          } catch {}
        }
        break;
      case 'setVolume':
        if (typeof item.payload === 'number') {
          const ratio = Math.max(0, Math.min(1, item.payload / 100));
          try {
            folium.playback.setVolume(ratio);
            if (ratio > 0 && currentSnapshot.isMuted) {
              folium.playback.setMuted(false);
              currentSnapshot.isMuted = false;
            }
          } catch (err) {
            folium.log.warn('Failed to setVolume', err);
          }
          currentSnapshot.volume = Math.round(ratio * 100);
          void pushSnapshot({
            volume: currentSnapshot.volume,
            isMuted: currentSnapshot.isMuted,
          });
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
            currentIndex: currentSnapshot.currentIndex,
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
            if (!isDisposed && !played) {
              refreshQueue(currentQueuePageIndex);
              void pushSnapshot({
                queue: currentSnapshot.queue,
                queueTotal: currentSnapshot.queueTotal,
                queuePage: currentSnapshot.queuePage,
                currentIndex: currentSnapshot.currentIndex,
              });
            }
          } catch (err) {
            folium.log.warn('playQueueItem failed', err);
          }
        }
        break;
      }
      case 'fetchQueuePage': {
        const targetPage = Math.max(0, Number(item.payload?.page) || 0);
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
      case 'refreshProviders': {
        const providers = refreshProviders();
        void pushSnapshot({ providers });
        break;
      }
      case 'searchOnlineSongs':
        await handleSearchOnlineSongs(item.payload);
        break;
      case 'playOmniSong':
      case 'enqueueOmniSong': {
        abortControllerSafe(activePlayController);
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        activePlayController = controller;
        const seq = ++playSeq;
        try {
          const liveSong = await resolveLiveSongFromPayload(item.payload, controller?.signal);
          if (isPlayCancelled(seq, controller) || !liveSong) return;
          if (item.action === 'enqueueOmniSong') {
            folium.playback.enqueue(liveSong);
          } else {
            await folium.playback.playSong(liveSong);
          }
        } catch (err) {
          if (!isPlayCancelled(seq, controller) && err?.code !== 'aborted') {
            folium.log.warn(`${item.action} failed`, err);
          }
        }
        break;
      }
      case 'fetchExplore':
        await handleFetchExplore(item.payload);
        break;
      case 'exploreBack':
        handleExploreBack();
        break;
      case 'replaceQueueWithTracks':
        await handleReplaceQueueWithTracks(item.payload);
        break;
      case 'toggleSaveTrack':
        toggleSavedTrackEntry(item.payload);
        break;
      case 'removeSavedTrack':
        removeSavedTrackEntry(item.payload);
        break;
      case 'clearRecentTracks':
        clearRecentTracksList();
        break;
      case 'playAllStoredTracks':
        await handlePlayStoredTracks(item.payload);
        break;
    }
  }

  async function drainPendingActionsOnce() {
    try {
      const actions = await folium.rpc.call('drainActions');
      if (Array.isArray(actions) && actions.length > 0) {
        for (const item of actions) {
          await handleClientAction(item);
        }
      }
    } catch {
      // Ignored
    }
  }

  if (hasRpcPush) {
    const unsubClientAction = folium.rpc.on('clientAction', (item) => {
      void handleClientAction(item);
    });
    if (typeof unsubClientAction === 'function') {
      unsubs.push(unsubClientAction);
    }
  }

  const postMountThemeTimerA = hasThemeCurrentApi
    ? setTimeout(() => syncPostMountThemeIfNeeded(), 350)
    : null;
  const postMountThemeTimerB = hasThemeCurrentApi
    ? setTimeout(() => syncPostMountThemeIfNeeded(), 1500)
    : null;

  const actionPollTimer = setInterval(async () => {
    try {
      if (!hasRpcPush) {
        await drainPendingActionsOnce();
      }
      pushPlaybackAnchor(false, false);
    } catch {
      // Ignored
    }
  }, 200);

  return () => {
    isDisposed = true;
    abortControllerSafe(activeSearchController);
    abortControllerSafe(activeExploreController);
    abortControllerSafe(activePlayController);
    activeSearchController = null;
    activeExploreController = null;
    activePlayController = null;
    clearInterval(actionPollTimer);
    if (postMountThemeTimerA) clearTimeout(postMountThemeTimerA);
    if (postMountThemeTimerB) clearTimeout(postMountThemeTimerB);
    clearQuickSyncTimers();
    unsubs.forEach((unsub) => {
      try { unsub(); } catch {}
    });
  };
}
