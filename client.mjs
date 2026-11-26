// mods/taskbar-lyrics/client.mjs
// Renderer ESM entry for the Taskbar Lyrics Drawer mod.
// Listens to Folia playback, lyric, and theme events, synchronizes snapshots with the main process,
// dispatches user playback controls, manages pagination & complete library navigation (Online/Local Playlists, Albums, Radio),
// and registers mod settings.
// Note: Supported exclusively on Windows (win32).

'use strict';

/**
 * Taskbar Lyrics Client Entry
 * @param {import('../folium').FoliumClientApi} folium
 */
export default function activate(folium) {
  // Enforce main-window & Windows platform limitations (skip video export contexts cleanly)
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

  // Feature detection across Folium 1.5–1.10 and Folium 2.x (where minor resets to 0/1)
  const foliumMajor = folium.host?.folium?.major ?? 1;
  const foliumMinor = folium.host?.folium?.minor ?? 0;
  const hasFoliumAtLeast = (targetMajor, targetMinor) => (
    foliumMajor > targetMajor || (foliumMajor === targetMajor && foliumMinor >= targetMinor)
  );
  const hasPlaybackControls = hasFoliumAtLeast(1, 5);
  const hasOmniApi = hasFoliumAtLeast(1, 7) && Boolean(folium.omni);
  const hasRpcPush = hasFoliumAtLeast(1, 7) && typeof folium.rpc?.on === 'function';
  const hasReplaceQueueApi = hasFoliumAtLeast(1, 7) && typeof folium.playback?.replaceQueue === 'function';
  const hasThemeCurrentApi = hasFoliumAtLeast(1, 10) && typeof folium.theme?.getCurrent === 'function';
  const QUEUE_PAGE_SIZE = 50;
  let currentQueuePageIndex = 0;
  let isDisposed = false;
  const pendingPlayTimers = new Set();

  // Built-in sources in Folia 0.8.0 used alongside dynamic listProviders() when scanning caches
  const BUILTIN_SNAPSHOT_PROVIDERS = [
    'netease', 'kugou', 'qq', 'bodian',
    'qishui', 'ytm', 'spotify', 'appleMusic', 'fnmusic', 'lxmusic',
  ];

  function tryGetInternalStores() {
    try {
      return folium['internals']?.stores || null;
    } catch {
      return null;
    }
  }

  function getProviderIdOf(providerInfo) {
    return providerInfo?.providerId || providerInfo?.id || null;
  }

  function getKnownSnapshotProviderIds() {
    const ordered = [];
    const seen = new Set();
    const pushId = (id) => {
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    };
    if (hasOmniApi && typeof folium.omni?.listProviders === 'function') {
      try {
        const listed = folium.omni.listProviders() || [];
        listed.filter((p) => p?.selected).forEach((p) => pushId(getProviderIdOf(p)));
        listed.forEach((p) => pushId(getProviderIdOf(p)));
      } catch {}
    }
    BUILTIN_SNAPSHOT_PROVIDERS.forEach(pushId);
    return ordered;
  }

  function formatLocalSongMeta(song) {
    const useImport = song?.titleOrigin === 'import';
    const importedArtists = Array.isArray(song?.importedMetadata?.artistNames)
      ? song.importedMetadata.artistNames.filter(Boolean)
      : [];
    const onlineArtists = Array.isArray(song?.onlineMetadata?.artists)
      ? song.onlineMetadata.artists.map((a) => a?.name).filter(Boolean)
      : [];
    const artistNames = useImport
      ? (importedArtists.length > 0 ? importedArtists : onlineArtists)
      : (onlineArtists.length > 0 ? onlineArtists : importedArtists);
    const artist = artistNames.length > 0 ? artistNames.join(' / ') : (song?.artist || '本地音乐');

    const importedAlbum = song?.importedMetadata?.albumName || '';
    const onlineAlbum = song?.onlineMetadata?.album?.name || '';
    const fallbackAlbum = song?.album?.name || (typeof song?.album === 'string' ? song.album : '');
    const albumName = useImport
      ? (importedAlbum || onlineAlbum || fallbackAlbum)
      : (onlineAlbum || importedAlbum || fallbackAlbum);

    const rawDurationMs = typeof song?.durationMs === 'number'
      ? song.durationMs
      : (typeof song?.duration === 'number' ? song.duration : 0);
    const durationSec = rawDurationMs > 0 ? Math.round(rawDurationMs / 1000) : 0;
    const durationMs = rawDurationMs > 0 ? rawDurationMs : 0;
    const title = song?.title || song?.name || '未知曲目';

    return { title, artist, albumName, durationSec, durationMs };
  }

  function resolveLocalCoverUrl(song) {
    const assetId = song?.localCoverAssetId;
    const localUrl = typeof assetId === 'string' && assetId
      ? `folia-cover://asset/${encodeURIComponent(assetId)}`
      : '';
    const onlineCover = song?.onlineMetadata?.coverUrl || '';
    if (song?.useOnlineCover) {
      return onlineCover || localUrl;
    }
    return localUrl || onlineCover;
  }

  function buildLocalSongEntry(s) {
    const meta = formatLocalSongMeta(s);
    const coverUrl = resolveLocalCoverUrl(s);
    return {
      id: s.id,
      title: meta.title,
      artist: meta.artist,
      album: meta.albumName,
      duration: meta.durationSec,
      rawSong: {
        id: s.id,
        name: meta.title,
        artists: [{ id: 0, name: meta.artist }],
        album: {
          id: 0,
          name: meta.albumName,
          ...(coverUrl ? { coverUrl } : {}),
        },
        durationMs: meta.durationMs,
        isLocal: true,
        localRef: { songId: s.id },
        sourceRef: { kind: 'local', mediaId: s.id },
      },
    };
  }

  function formatRawSongEntry(song, rawSongOverride = song) {
    const artist = Array.isArray(song?.artists)
      ? song.artists.map((a) => a?.name).filter(Boolean).join(' / ') || '未知艺人'
      : (song?.artist || '未知艺人');
    const durSec = typeof song?.durationMs === 'number'
      ? Math.round(song.durationMs / 1000)
      : (typeof song?.duration === 'number' ? song.duration : 0);
    return {
      id: song?.id,
      title: song?.name || song?.title || '未知曲目',
      artist,
      album: song?.album?.name || '',
      duration: durSec,
      rawSong: rawSongOverride,
    };
  }

  function applyInternalPlaybackQueue(pStore, queue, isFmMode) {
    const state = pStore.getState();
    if (typeof state.replacePlayQueue === 'function') {
      state.replacePlayQueue(queue, isFmMode);
      return;
    }
    state.setIsFmMode(isFmMode);
    state.setPlayQueue(queue);
  }

  // In-memory raw item caches kept exclusively in client.mjs to avoid cloning large rawSong/rawCollection
  // graphs across IPC into main process, taskbarWindow, and menuWindow.
  const cachedCollectionMap = new Map();
  const cachedWheelPlaylistMap = new Map();
  const playlistMembershipCache = new Map(); // `${providerId}:${id}` -> { ids: Set<string>, trackCount: number, fetchedAt: number, complete: boolean }
  const MEMBERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;
  let radialFetchSeq = 0;
  let radialSelectSeq = 0;
  let cachedDetailRawSongs = [];
  let cachedLocalPageRawSongs = [];
  let cachedDailyRawSongs = [];

  let currentSnapshot = {
    song: null,
    playerState: 'paused',
    isAdvancing: false,
    currentTime: 0,
    duration: 0,
    lyricOffsetMs: 0,
    updatedAt: Date.now(),
    lyrics: null,
    lyricsVisible: true,
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
    librarySummary: null,
    libraryCategoryData: null,
    libraryDetailData: null,
    settings: {
      interactionMode: 'standard',
      rightFadeDelaySec: 1.5,
      targetDisplay: 'primary',
      showLyrics: true,
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
   * Avoids transmitting full lyrics on lightweight progress ticks and only updates
   * updatedAt when currentTime is actually included in the delta.
   * @param {object} delta Fields to merge and synchronize.
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

  /**
   * Normalizes a FoliumTheme object via folium.theme.resolveFontStack().
   */
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

  /**
   * Resolves the active Folia theme using Folium 1.10 folium.theme.getCurrent()
   * when available, falling back cleanly for older Folium 1.8/1.9 hosts.
   */
  function resolveCurrentTheme() {
    try {
      if (hasReceivedThemeEvent && cachedLiveTheme) {
        return cachedLiveTheme;
      }

      if (hasThemeCurrentApi) {
        try {
          const liveTheme = normalizeThemeSnapshot(folium.theme.getCurrent());
          if (liveTheme && liveTheme.backgroundColor) {
            cachedLiveTheme = liveTheme;
            return liveTheme;
          }
        } catch {}
      }

      let isDaylight = false;
      if (typeof localStorage !== 'undefined') {
        isDaylight = localStorage.getItem('default_theme_daylight') === 'true';
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

  /**
   * Reads existing lyrics and song metadata directly from official Folium APIs (getState and getLines)
   * to immediately populate retained songs on startup or async metadata arrival.
   * @param {boolean} resetIfEmpty When true, clears lyrics if host has none for the current track.
   */
  function syncPlaybackStoreLyricsAndSong(resetIfEmpty = false) {
    try {
      const hostState = folium.playback.getState();
      if (hostState?.song) {
        let coverUrl = null;
        try {
          const details = folium.omni?.describeSong?.(hostState.song);
          coverUrl = details?.coverUrl || null;
        } catch {}

        if (!coverUrl) {
          try {
            const pState = tryGetInternalStores()?.playback?.getState?.();
            coverUrl = pState?.transitionDisplay?.coverUrl
              || pState?.cachedCoverUrl
              || pState?.currentSong?.coverUrl
              || pState?.currentSong?.album?.coverUrl
              || pState?.currentSong?.picUrl
              || null;
          } catch {}
        }

        currentSnapshot.song = {
          title: hostState.song.title || '未知曲目',
          artist: hostState.song.artist || 'Folia',
          coverUrl,
        };
      }

      // Check official folium.lyrics.getLines() for currently active lyric lines
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

  /**
   * Resolves whether the host playback state indicates active advancing playback.
   */
  function isPlaybackStoreActive() {
    try {
      const hostState = folium.playback.getState();
      return hostState?.state === 'playing';
    } catch {
      return true;
    }
  }

  /**
   * Resolves the current audio playback position, whether the audio clock is actively advancing
   * (vs. loading/buffering/seeking), and whether it is a fresh sample.
   * Completely clean: does not query private DOM <audio> elements, purely uses host state & events.
   */
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
        if (typeof state.liked === 'boolean') {
          currentSnapshot.liked = state.liked;
        }
        if (typeof state.canLike === 'boolean') {
          currentSnapshot.canLike = state.canLike;
        }
        const clock = samplePlaybackClock();
        currentSnapshot.playerState = clock.state;
        currentSnapshot.isAdvancing = clock.isAdvancing;
        currentSnapshot.currentTime = clock.position;
        currentSnapshot.duration = clock.duration;
        currentSnapshot.updatedAt = clock.updatedAt;
      }
      syncPlaybackStoreLyricsAndSong();
    } catch {
      // Ignored
    }
  }

  function getCurrentRawSong() {
    try {
      const pState = tryGetInternalStores()?.playback?.getState?.();
      return pState?.transitionDisplay?.song || pState?.currentSong || null;
    } catch {
      return null;
    }
  }

  function getCurrentSongIdentityKey() {
    const rawSong = getCurrentRawSong();
    if (rawSong) {
      const ref = rawSong.sourceRef;
      if (ref?.kind === 'online') return `online:${ref.providerId || ''}:${ref.mediaId ?? rawSong.id ?? ''}`;
      if (ref?.kind) return `${ref.kind}:${ref.mediaId ?? rawSong.id ?? ''}`;
      return `${rawSong.providerId || ''}:${rawSong.id ?? rawSong.name ?? ''}`;
    }
    if (currentSnapshot.song) {
      return `snap:${currentSnapshot.song.title || ''}:${currentSnapshot.song.artist || ''}`;
    }
    return '';
  }

  function refreshLikeStateFromHost() {
    let hasLiked = false;
    let hasCanLike = false;
    try {
      const state = folium.playback.getState();
      if (state) {
        if (typeof state.liked === 'boolean') {
          currentSnapshot.liked = state.liked;
          hasLiked = true;
        }
        if (typeof state.canLike === 'boolean') {
          currentSnapshot.canLike = state.canLike;
          hasCanLike = true;
        }
      }
    } catch {}
    if (hasLiked && hasCanLike) return;
    if (!hasCanLike) {
      const rawSong = getCurrentRawSong();
      const omni = getLegacyInternalOmni();
      currentSnapshot.canLike = Boolean(rawSong && omni?.canLikeSong?.(rawSong));
    }
  }

  function reconcileLikeStateIfChanged() {
    const prevLiked = Boolean(currentSnapshot.liked);
    const prevCanLike = Boolean(currentSnapshot.canLike);
    refreshLikeStateFromHost();
    if (Boolean(currentSnapshot.liked) !== prevLiked || Boolean(currentSnapshot.canLike) !== prevCanLike) {
      void pushSnapshot({
        liked: currentSnapshot.liked,
        canLike: currentSnapshot.canLike,
      });
    }
  }

  function resolveSongProviderId(rawSong, hostSong) {
    if (rawSong?.sourceRef?.kind === 'online' && rawSong.sourceRef.providerId) {
      return rawSong.sourceRef.providerId;
    }
    if (typeof rawSong?.providerId === 'string' && rawSong.providerId) {
      return rawSong.providerId;
    }
    if (typeof hostSong?.source === 'string' && hostSong.source && hostSong.source !== 'local' && hostSong.source !== 'navidrome' && hostSong.source !== 'stage') {
      return hostSong.source;
    }
    return null;
  }

  function getSongMatchKeys(song) {
    const keys = new Set();
    if (!song || typeof song !== 'object') return keys;
    const addKey = (val, lowercase = false) => {
      if (val !== undefined && val !== null && val !== '') {
        const str = String(val).trim();
        if (str) keys.add(lowercase ? str.toLowerCase() : str);
      }
    };
    const pData = song.sourceRef?.kind === 'online' ? song.sourceRef.providerData : null;
    addKey(song.id, true);
    addKey(song.sourceRef?.mediaId, true);
    addKey(song.hash, true);
    addKey(pData?.hash, true);
    addKey(pData?.albumAudioId);
    addKey(pData?.mixSongId);
    addKey(song.mid);
    addKey(pData?.mid);
    addKey(song.songmid);
    addKey(pData?.songmid);
    addKey(song.emixsongid);
    // Note: intentionally exclude providerData.fileId (KuGou playlist-local row id, not a global song identity)
    return keys;
  }

  function makeMembershipCacheKey(providerId, playlistId) {
    return `${providerId || 'online'}:${String(playlistId ?? '')}`;
  }

  function songMatchesTrackIdSet(matchKeys, idSet) {
    if (!matchKeys || matchKeys.size === 0 || !idSet || idSet.size === 0) return false;
    for (const key of matchKeys) {
      if (idSet.has(key)) return true;
    }
    return false;
  }

  function recordSongInMembershipCache(providerId, playlistId, song, trackCount = 0, playlistOwnedTrack = null) {
    const cacheKey = makeMembershipCacheKey(providerId, playlistId);
    const matchKeys = getSongMatchKeys(song);
    if (matchKeys.size === 0) return;
    let entry = playlistMembershipCache.get(cacheKey);
    if (!entry) {
      entry = {
        ids: new Set(),
        tracksByKey: new Map(),
        trackCount: Number(trackCount) || 0,
        fetchedAt: Date.now(),
        complete: false,
      };
      playlistMembershipCache.set(cacheKey, entry);
    }
    if (!entry.tracksByKey) entry.tracksByKey = new Map();
    matchKeys.forEach((k) => {
      entry.ids.add(k);
      if (playlistOwnedTrack) {
        entry.tracksByKey.set(k, playlistOwnedTrack);
      } else {
        // Newly added song does not yet have its playlist-local row id (e.g. KuGou fileId) until re-fetched
        entry.tracksByKey.delete(k);
      }
    });
    if (trackCount > entry.trackCount) {
      entry.trackCount = trackCount;
    }
    entry.fetchedAt = Date.now();
  }

  function removeSongFromMembershipCache(providerId, playlistId, song) {
    const cacheKey = makeMembershipCacheKey(providerId, playlistId);
    const entry = playlistMembershipCache.get(cacheKey);
    if (!entry) return;
    const matchKeys = getSongMatchKeys(song);
    let removed = false;
    matchKeys.forEach((k) => {
      if (entry.ids.delete(k)) removed = true;
      entry.tracksByKey?.delete(k);
    });
    if (removed && entry.trackCount > 0) {
      entry.trackCount = Math.max(0, entry.trackCount - 1);
    }
    entry.fetchedAt = Date.now();
  }

  function getCachedPlaylistOwnedTrack(providerId, playlistId, matchKeys) {
    const entry = playlistMembershipCache.get(makeMembershipCacheKey(providerId, playlistId));
    if (!entry || !entry.tracksByKey || !matchKeys) return null;
    for (const k of matchKeys) {
      const found = entry.tracksByKey.get(k);
      if (found) return found;
    }
    return null;
  }

  /**
   * Resolves the exact track row object owned by `playlist` (carrying playlist-local metadata such as
   * KuGou's `sourceRef.providerData.fileId`). Never reuses a song object from another playlist for deletion.
   */
  async function resolvePlaylistOwnedTrackForRemoval(omni, playlist, rawSong, forceRefresh = false) {
    const matchKeys = getSongMatchKeys(rawSong);
    if (matchKeys.size === 0) return null;

    if (!forceRefresh) {
      const cachedTrack = getCachedPlaylistOwnedTrack(playlist.providerId, playlist.id, matchKeys);
      if (cachedTrack) {
        return cachedTrack;
      }
    }

    if (typeof omni?.getCollectionTracks !== 'function') {
      return null;
    }

    const pageSize = 100;
    const maxPages = 20;
    const ids = new Set();
    const tracksByKey = new Map();
    let offset = 0;
    let matched = null;
    let complete = true;

    for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
      let page;
      try {
        page = await omni.getCollectionTracks(playlist, { limit: pageSize, offset });
      } catch {
        complete = false;
        break;
      }
      const items = Array.isArray(page?.items) ? page.items : [];
      for (const item of items) {
        const itemKeys = getSongMatchKeys(item);
        itemKeys.forEach((k) => {
          ids.add(k);
          tracksByKey.set(k, item);
        });
        if (!matched && songMatchesTrackIdSet(matchKeys, itemKeys)) {
          matched = item;
        }
      }
      const reportedMore = typeof page?.hasMore === 'boolean' ? page.hasMore : items.length >= pageSize;
      if (matched || !reportedMore || items.length === 0) {
        if (reportedMore && items.length > 0) {
          complete = false;
        }
        break;
      }
      if (pageIdx === maxPages - 1) {
        complete = false;
      }
      offset = (typeof page?.nextOffset === 'number' && page.nextOffset > offset)
        ? page.nextOffset
        : (offset + items.length);
    }

    if (ids.size > 0) {
      const existing = playlistMembershipCache.get(makeMembershipCacheKey(playlist.providerId, playlist.id));
      const mergedIds = existing ? new Set([...existing.ids, ...ids]) : ids;
      const mergedTracks = existing?.tracksByKey ? new Map(existing.tracksByKey) : new Map();
      tracksByKey.forEach((v, k) => mergedTracks.set(k, v));
      playlistMembershipCache.set(makeMembershipCacheKey(playlist.providerId, playlist.id), {
        ids: mergedIds,
        tracksByKey: mergedTracks,
        trackCount: Number(playlist.trackCount ?? playlist.songCount ?? mergedIds.size) || mergedIds.size,
        fetchedAt: Date.now(),
        complete: complete || Boolean(existing?.complete),
      });
    }

    return matched;
  }

  function isMembershipCacheFresh(entry, expectedTrackCount) {
    if (!entry || !entry.complete) return false;
    if (Date.now() - entry.fetchedAt > MEMBERSHIP_CACHE_TTL_MS) return false;
    const expected = Number(expectedTrackCount) || 0;
    if (expected > 0 && entry.trackCount > 0 && expected !== entry.trackCount) return false;
    return true;
  }

  async function hydrateWheelPlaylistMembership(reqSeq, initialSongKey, matchKeys, playlistsToCheck, baseTargets) {
    const omni = getLegacyInternalOmni();
    if (!omni || typeof omni.getCollectionTracks !== 'function' || matchKeys.size === 0) return;

    // Prioritize first 12 playlists and cap per-playlist scan at 5 pages (500 tracks) to avoid rate limits
    const candidates = playlistsToCheck.slice(0, 12);
    const maxPagesPerPlaylist = 5;
    const pageSize = 100;
    const concurrency = 2;
    let cursor = 0;

    const currentTargets = baseTargets.map((t) => ({ ...t }));
    const targetById = new Map(currentTargets.map((t) => [String(t.id), t]));

    const scanOne = async (collection) => {
      if (isDisposed || reqSeq !== radialFetchSeq || getCurrentSongIdentityKey() !== initialSongKey) return;
      const cacheKey = makeMembershipCacheKey(collection.providerId, collection.id);
      const expectedCount = Number(collection.trackCount ?? collection.songCount ?? 0) || 0;
      const existing = playlistMembershipCache.get(cacheKey);
      if (isMembershipCacheFresh(existing, expectedCount)) return;

      const ids = existing ? new Set(existing.ids) : new Set();
      const tracksByKey = existing?.tracksByKey ? new Map(existing.tracksByKey) : new Map();
      let offset = 0;
      let complete = true;

      for (let pageIdx = 0; pageIdx < maxPagesPerPlaylist; pageIdx++) {
        if (isDisposed || reqSeq !== radialFetchSeq || getCurrentSongIdentityKey() !== initialSongKey) return;
        let page;
        try {
          page = await omni.getCollectionTracks(collection, { limit: pageSize, offset });
        } catch {
          complete = false;
          break;
        }
        const items = Array.isArray(page?.items) ? page.items : [];
        for (const item of items) {
          getSongMatchKeys(item).forEach((k) => {
            ids.add(k);
            tracksByKey.set(k, item);
          });
        }
        const reportedMore = typeof page?.hasMore === 'boolean' ? page.hasMore : items.length >= pageSize;
        if (!reportedMore || items.length === 0) {
          break;
        }
        if (pageIdx === maxPagesPerPlaylist - 1) {
          complete = false;
        }
        offset = (typeof page?.nextOffset === 'number' && page.nextOffset > offset)
          ? page.nextOffset
          : (offset + items.length);
      }

      playlistMembershipCache.set(cacheKey, {
        ids,
        tracksByKey,
        trackCount: expectedCount || ids.size,
        fetchedAt: Date.now(),
        complete,
      });

      if (isDisposed || reqSeq !== radialFetchSeq || getCurrentSongIdentityKey() !== initialSongKey) return;
      const inPlaylist = songMatchesTrackIdSet(matchKeys, ids);
      const targetDto = targetById.get(String(collection.id));
      if (targetDto && Boolean(targetDto.inPlaylist) !== inPlaylist) {
        targetDto.inPlaylist = inPlaylist;
        void pushSnapshot({
          liked: currentSnapshot.liked,
          canLike: currentSnapshot.canLike,
          radialTargets: currentTargets.map((t) => ({ ...t })),
        });
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        if (isDisposed || reqSeq !== radialFetchSeq || getCurrentSongIdentityKey() !== initialSongKey) return;
        const item = candidates[cursor++];
        await scanOne(item);
      }
    });

    await Promise.all(workers);
  }

  /**
   * Builds the radial wheel target list for the currently playing song:
   * slot 0 is always "我喜欢的音乐" (toggle like), followed by up to 36 writable online playlists
   * belonging to the song's signed-in platform, with membership highlight for already-collected playlists.
   */
  async function buildRadialWheelTargets() {
    const reqSeq = ++radialFetchSeq;
    const initialSongKey = getCurrentSongIdentityKey();
    refreshLikeStateFromHost();

    const hostState = (() => {
      try { return folium.playback.getState(); } catch { return null; }
    })();
    const rawSong = getCurrentRawSong();
    const hasSong = Boolean(hostState?.song || rawSong || currentSnapshot.song);
    if (!hasSong) {
      cachedWheelPlaylistMap.clear();
      return { stale: false, targets: [] };
    }

    const liked = Boolean(currentSnapshot.liked);
    const canLike = Boolean(currentSnapshot.canLike);
    const omni = getLegacyInternalOmni();
    const matchKeys = getSongMatchKeys(rawSong || hostState?.song);
    let likedCoverUrl = currentSnapshot.song?.coverUrl || '';
    const maxPlaylists = 36;
    const seenIds = new Set();
    const nextPlaylistMap = new Map();
    const playlistTargets = [];
    const playlistsNeedingScan = [];

    const pushPlaylistCandidate = (collection) => {
      if (!collection || playlistTargets.length >= maxPlaylists) return;
      const id = String(collection.id ?? '');
      if (!id || seenIds.has(id)) return;
      if (collection.isLiked) {
        if (!likedCoverUrl && (collection.coverUrl || collection.picUrl)) {
          likedCoverUrl = collection.coverUrl || collection.picUrl || '';
        }
        if (canLike) return;
      }
      seenIds.add(id);
      nextPlaylistMap.set(id, collection);
      const name = String(collection.name || '自建歌单').trim();
      const trackCount = Number(collection.trackCount ?? collection.songCount ?? 0) || 0;
      const cacheKey = makeMembershipCacheKey(collection.providerId, id);
      const cached = playlistMembershipCache.get(cacheKey);
      const inPlaylist = Boolean(cached && songMatchesTrackIdSet(matchKeys, cached.ids));
      if (!isMembershipCacheFresh(cached, trackCount)) {
        playlistsNeedingScan.push(collection);
      }
      const canRemove = Boolean(
        typeof omni?.updateCollectionTracks === 'function'
        && (typeof omni?.canEditCollectionTracks !== 'function' || omni.canEditCollectionTracks(collection)),
      );
      playlistTargets.push({
        id,
        kind: 'playlist',
        name,
        shortName: name,
        coverUrl: collection.coverUrl || collection.picUrl || '',
        providerId: collection.providerId || null,
        trackCount,
        inPlaylist,
        canRemove,
        disabled: false,
      });
    };

    if (rawSong && omni && typeof omni.canAddSongToPlaylist === 'function' && omni.canAddSongToPlaylist(rawSong)) {
      if (typeof omni.getPlaylistsForSong === 'function') {
        try {
          const directPlaylists = omni.getPlaylistsForSong(rawSong) || [];
          for (const pl of directPlaylists) {
            if (pl?.type === 'playlist') {
              pushPlaylistCandidate(pl);
            }
          }
        } catch (err) {
          folium.log.warn('Failed to read omni.getPlaylistsForSong for radial wheel', err);
        }
      } else if (typeof omni.getProviderSummaries === 'function') {
        // Older host fallback: only read currently signed-in provider summaries with writable playlists
        try {
          const providerId = resolveSongProviderId(rawSong, hostState?.song);
          const summaries = omni.getProviderSummaries() || [];
          const summary = summaries.find((s) => s && s.providerId === providerId && s.user?.id);
          if (summary && Array.isArray(summary.collections)) {
            for (const c of summary.collections) {
              if (c?.type === 'playlist' && c.canAddToPlaylist !== false) {
                pushPlaylistCandidate(c);
              }
            }
          }
        } catch (err) {
          folium.log.warn('Failed to read signed-in provider summaries for radial wheel', err);
        }
      }
    }

    const targets = [
      {
        id: '__liked__',
        kind: 'like',
        name: liked ? '取消喜欢' : '我喜欢的音乐',
        shortName: liked ? '取消喜欢' : '我喜欢',
        coverUrl: likedCoverUrl,
        liked,
        canLike,
        disabled: !canLike,
      },
      ...playlistTargets,
    ];

    if (isDisposed || reqSeq !== radialFetchSeq || getCurrentSongIdentityKey() !== initialSongKey) {
      return { stale: true, targets: [] };
    }

    cachedWheelPlaylistMap.clear();
    nextPlaylistMap.forEach((value, key) => cachedWheelPlaylistMap.set(key, value));

    const startHydration = (playlistsNeedingScan.length > 0 && matchKeys.size > 0)
      ? () => {
          void hydrateWheelPlaylistMembership(reqSeq, initialSongKey, matchKeys, playlistsNeedingScan, targets);
        }
      : null;

    return { stale: false, targets, startHydration };
  }

  async function toggleCurrentSongLike() {
    refreshLikeStateFromHost();
    const prevLiked = Boolean(currentSnapshot.liked);
    if (typeof folium.playback?.toggleLike === 'function') {
      try {
        const acted = folium.playback.toggleLike();
        if (acted) {
          // Read host state immediately if updated synchronously; otherwise reconcile via event & 200ms poll
          refreshLikeStateFromHost();
          const nextLiked = currentSnapshot.liked !== prevLiked ? Boolean(currentSnapshot.liked) : !prevLiked;
          currentSnapshot.liked = nextLiked;
          void pushSnapshot({ liked: nextLiked, canLike: currentSnapshot.canLike });
          return { ok: true, liked: nextLiked, message: nextLiked ? '已加入我喜欢' : '已取消喜欢' };
        }
      } catch (err) {
        folium.log.warn('folium.playback.toggleLike failed', err);
      }
    }

    const rawSong = getCurrentRawSong();
    const omni = getLegacyInternalOmni();
    if (rawSong && omni && typeof omni.toggleSongLike === 'function') {
      try {
        const nextLiked = await omni.toggleSongLike(rawSong);
        currentSnapshot.liked = Boolean(nextLiked);
        void pushSnapshot({ liked: currentSnapshot.liked, canLike: currentSnapshot.canLike });
        return { ok: true, liked: currentSnapshot.liked, message: currentSnapshot.liked ? '已加入我喜欢' : '已取消喜欢' };
      } catch (err) {
        folium.log.warn('omni.toggleSongLike failed', err);
        return { ok: false, message: err?.message || '喜欢操作失败' };
      }
    }

    return { ok: false, message: '当前歌曲不支持喜欢操作' };
  }

  async function handleRadialTargetSelection(target) {
    if (!target || typeof target !== 'object') return;
    const selectSeq = ++radialSelectSeq;
    const initialSongKey = getCurrentSongIdentityKey();

    if (target.kind === 'like' || target.id === '__liked__') {
      const res = await toggleCurrentSongLike();
      if (isDisposed || selectSeq !== radialSelectSeq) {
        return;
      }
      const sameSong = getCurrentSongIdentityKey() === initialSongKey;
      void pushSnapshot({
        ...(sameSong ? { liked: currentSnapshot.liked, canLike: currentSnapshot.canLike } : {}),
        radialFeedback: {
          ok: Boolean(res.ok),
          targetId: '__liked__',
          message: res.message || (res.ok ? '操作成功' : '操作失败'),
        },
      });
      return;
    }

    const rawSong = getCurrentRawSong();
    const omni = getLegacyInternalOmni();
    const targetId = String(target.id ?? '');
    const playlist = cachedWheelPlaylistMap.get(targetId);

    if (!rawSong || !playlist || !omni) {
      const message = '当前歌曲无法操作该歌单';
      try { folium.ui?.toast?.(message, { type: 'error', durationMs: 2200 }); } catch {}
      void pushSnapshot({
        radialFeedback: { ok: false, targetId, message },
      });
      return;
    }

    const memKey = makeMembershipCacheKey(playlist.providerId, playlist.id);
    const cachedMem = playlistMembershipCache.get(memKey);
    const isAlreadyInPlaylist = Boolean(
      target.inPlaylist
      || (cachedMem && songMatchesTrackIdSet(getSongMatchKeys(rawSong), cachedMem.ids)),
    );

    if (isAlreadyInPlaylist) {
      const canRemove = Boolean(
        typeof omni.updateCollectionTracks === 'function'
        && (typeof omni.canEditCollectionTracks !== 'function' || omni.canEditCollectionTracks(playlist)),
      );
      if (!canRemove) {
        const message = '该歌单不支持移出歌曲';
        try { folium.ui?.toast?.(message, { type: 'error', durationMs: 2200 }); } catch {}
        void pushSnapshot({
          radialFeedback: { ok: false, targetId, message },
        });
        return;
      }
      try {
        // Resolve the track row belonging to THIS specific playlist (required by KuGou playlist_tracks_del fileid)
        const playlistOwnedTrack = await resolvePlaylistOwnedTrackForRemoval(omni, playlist, rawSong);
        const isKugouPlaylist = String(playlist.providerId || '').toLowerCase() === 'kugou';
        if (isKugouPlaylist && !playlistOwnedTrack) {
          removeSongFromMembershipCache(playlist.providerId, playlist.id, rawSong);
          const message = `该歌曲已不在「${playlist.name || '歌单'}」中`;
          try { folium.ui?.toast?.(message, { type: 'info', durationMs: 2200 }); } catch {}
          if (!isDisposed && selectSeq === radialSelectSeq) {
            void pushSnapshot({
              radialFeedback: { ok: true, removed: true, targetId, message },
            });
          }
          return;
        }
        const trackToDelete = playlistOwnedTrack || rawSong;
        try {
          await omni.updateCollectionTracks(playlist, 'del', [trackToDelete]);
        } catch (delErr) {
          if (!isKugouPlaylist) throw delErr;
          // Retry once with freshly fetched KuGou playlist row in case cached fileId became stale
          const freshTrack = await resolvePlaylistOwnedTrackForRemoval(omni, playlist, rawSong, true);
          if (!freshTrack) {
            removeSongFromMembershipCache(playlist.providerId, playlist.id, rawSong);
            const message = `该歌曲已不在「${playlist.name || '歌单'}」中`;
            try { folium.ui?.toast?.(message, { type: 'info', durationMs: 2200 }); } catch {}
            if (!isDisposed && selectSeq === radialSelectSeq) {
              void pushSnapshot({
                radialFeedback: { ok: true, removed: true, targetId, message },
              });
            }
            return;
          }
          await omni.updateCollectionTracks(playlist, 'del', [freshTrack]);
        }
        removeSongFromMembershipCache(playlist.providerId, playlist.id, rawSong);
        if (typeof omni.refreshProviderPlaylists === 'function' && playlist.providerId) {
          void omni.refreshProviderPlaylists(playlist.providerId).catch(() => {});
        }
        const message = `已从「${playlist.name || '歌单'}」移出`;
        try { folium.ui?.toast?.(message, { type: 'success', durationMs: 2200 }); } catch {}
        if (!isDisposed && selectSeq === radialSelectSeq) {
          void pushSnapshot({
            radialFeedback: { ok: true, removed: true, targetId, message },
          });
        }
      } catch (err) {
        folium.log.warn('Failed to remove current song from playlist via radial wheel', err);
        const message = err?.message || '移出歌单失败';
        try { folium.ui?.toast?.(message, { type: 'error', durationMs: 2600 }); } catch {}
        if (!isDisposed && selectSeq === radialSelectSeq) {
          void pushSnapshot({
            radialFeedback: { ok: false, targetId, message },
          });
        }
      }
      return;
    }

    if (typeof omni.addSongToPlaylist !== 'function') {
      const message = '当前歌曲无法加入该歌单';
      try { folium.ui?.toast?.(message, { type: 'error', durationMs: 2200 }); } catch {}
      void pushSnapshot({
        radialFeedback: { ok: false, targetId, message },
      });
      return;
    }

    try {
      await omni.addSongToPlaylist(rawSong, playlist);
      recordSongInMembershipCache(playlist.providerId, playlist.id, rawSong, (Number(playlist.trackCount) || 0) + 1);
      const message = `已加入「${playlist.name || '歌单'}」`;
      try { folium.ui?.toast?.(message, { type: 'success', durationMs: 2200 }); } catch {}
      if (!isDisposed && selectSeq === radialSelectSeq) {
        void pushSnapshot({
          radialFeedback: { ok: true, removed: false, targetId, message },
        });
      }
    } catch (err) {
      folium.log.warn('Failed to add current song to playlist from radial wheel', err);
      const message = err?.message || '加入歌单失败';
      try { folium.ui?.toast?.(message, { type: 'error', durationMs: 2600 }); } catch {}
      if (!isDisposed && selectSeq === radialSelectSeq) {
        void pushSnapshot({
          radialFeedback: { ok: false, targetId, message },
        });
      }
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
  // IndexedDB Helpers for KineticPlayerDB & FoliaPlaylistsDB
  // =========================================================================

  function openExistingIndexedDb(dbName = 'KineticPlayerDB', createIfMissing = false) {
    return new Promise(async (resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        // Never implicitly create FoliaPlaylistsDB before Folia initializes Dexie schema v1
        if (!createIfMissing && typeof indexedDB.databases === 'function') {
          try {
            const dbs = await indexedDB.databases();
            if (Array.isArray(dbs) && !dbs.some((entry) => entry?.name === dbName)) {
              return resolve(null);
            }
          } catch {}
        }
        const req = indexedDB.open(dbName);
        req.onerror = () => resolve(null);
        req.onsuccess = () => resolve(req.result);
      } catch {
        resolve(null);
      }
    });
  }

  function readIndexedDbTable(tableName, dbName = 'KineticPlayerDB') {
    return new Promise(async (resolve) => {
      try {
        const db = await openExistingIndexedDb(dbName, false);
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

  function readCacheKeyFromStores(key, storeNames = ['user_cache']) {
    return new Promise(async (resolve) => {
      try {
        const db = await openExistingIndexedDb('KineticPlayerDB', false);
        if (!db) return resolve(null);
        const available = storeNames.filter((name) => db.objectStoreNames.contains(name));
        if (available.length === 0) {
          db.close();
          return resolve(null);
        }

        const readFromStore = (storeName) => new Promise((innerResolve) => {
          try {
            const tx = db.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const getReq = store.get(key);
            getReq.onsuccess = () => {
              const res = getReq.result;
              innerResolve(res ? res.data : null);
            };
            getReq.onerror = () => innerResolve(null);
          } catch {
            innerResolve(null);
          }
        });

        let found = null;
        for (const storeName of available) {
          found = await readFromStore(storeName);
          if (found != null) break;
        }
        db.close();
        resolve(found);
      } catch {
        resolve(null);
      }
    });
  }

  function readUserCacheKey(key) {
    return readCacheKeyFromStores(key, ['user_cache']);
  }

  // =========================================================================
  // Comprehensive Music Library Services (Online & Local, Memory-Optimized)
  // =========================================================================

  function toLightSongDto(songObj) {
    return {
      id: songObj.id,
      title: songObj.title,
      artist: songObj.artist,
      album: songObj.album,
      duration: songObj.duration,
    };
  }

  function makeCollectionCacheKey(type, providerId, id) {
    return `${type || 'playlist'}:${providerId || 'local'}:${id}`;
  }

  /**
   * Transitional host Omni helper reserved ONLY for capabilities not yet in official folium.omni
   * (user playlists/saved albums, provider summaries, home feed, and Personal FM).
   * Public catalog reads (describeSong, resolveCollection, album getTracks, resolveSongs) use folium.omni.
   */
  function getLegacyInternalOmni() {
    try {
      return folium['internals']?.omni || null;
    } catch {
      return null;
    }
  }

  /**
   * Retrieves all playlists combining active Omni online collections and local playlists.
   * Stores raw objects in cachedCollectionMap and returns lightweight DTOs for IPC.
   */
  async function getLibraryPlaylists() {
    const omni = getLegacyInternalOmni();
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
                  const cacheKey = makeCollectionCacheKey('playlist', c.providerId, c.id);
                  cachedCollectionMap.set(cacheKey, { rawCollection: c });
                  list.push({
                    id: c.id,
                    providerId: c.providerId,
                    cacheKey,
                    name: c.name || (c.isLiked ? '我喜欢的音乐' : '自建歌单'),
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: c.type || 'playlist',
                    isLiked: Boolean(c.isLiked),
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
              const pId = c.providerId || activeSummary.providerId;
              const key = `${pId}:${c.id}`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                const cacheKey = makeCollectionCacheKey('playlist', pId, c.id);
                cachedCollectionMap.set(cacheKey, { rawCollection: c });
                list.push({
                  id: c.id,
                  providerId: pId,
                  cacheKey,
                  name: c.name || '在线歌单',
                  coverUrl: c.coverUrl || '',
                  songCount: c.trackCount || 0,
                  type: c.type || 'playlist',
                  isLiked: Boolean(c.isLiked),
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
      const providers = getKnownSnapshotProviderIds();
      for (const p of providers) {
        try {
          const snap = await readUserCacheKey(`online_provider_${p}_user_home_snapshot`);
          if (snap && Array.isArray(snap.collections)) {
            for (const c of snap.collections) {
              if (c.type === 'playlist' || c.type === 'cloud' || c.isLiked) {
                const key = `${p}:${c.id}`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  const cacheKey = makeCollectionCacheKey('playlist', p, c.id);
                  cachedCollectionMap.set(cacheKey, { rawCollection: c });
                  list.push({
                    id: c.id,
                    providerId: p,
                    cacheKey,
                    name: c.name || (c.isLiked ? '我喜欢的音乐' : '精选歌单'),
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: c.type || 'playlist',
                    isLiked: Boolean(c.isLiked),
                  });
                }
              }
            }
          }
        } catch {}
      }
    }

    // 4. Append Folia 0.8.0 FoliaPlaylistsDB playlists and legacy local_playlists fallback
    const seenLocalIds = new Set();
    try {
      const foliaPlaylists = await readIndexedDbTable('playlists', 'FoliaPlaylistsDB');
      if (Array.isArray(foliaPlaylists) && foliaPlaylists.length > 0) {
        const sorted = [...foliaPlaylists].sort((a, b) => Number(a?.rank ?? 0) - Number(b?.rank ?? 0));
        const needsLocalCoverLookup = sorted.some(
          (fp) => !fp?.coverUrl && Array.isArray(fp?.coverLocalSongIds) && fp.coverLocalSongIds.length > 0,
        );
        let localSongById = null;
        if (needsLocalCoverLookup) {
          const allLocalSongs = await readIndexedDbTable('local_music');
          localSongById = new Map(allLocalSongs.map((s) => [s.id, s]));
        }

        for (const fp of sorted) {
          if (!fp?.id || seenLocalIds.has(fp.id)) continue;
          seenLocalIds.add(fp.id);
          let coverUrl = fp.coverUrl || '';
          if (!coverUrl && localSongById && Array.isArray(fp.coverLocalSongIds)) {
            for (const songId of fp.coverLocalSongIds) {
              const songCover = resolveLocalCoverUrl(localSongById.get(songId));
              if (songCover) {
                coverUrl = songCover;
                break;
              }
            }
          }
          const cacheKey = makeCollectionCacheKey('playlist', 'local', fp.id);
          cachedCollectionMap.set(cacheKey, {
            isLocal: true,
            isFoliaPlaylist: true,
            rawLocalPlaylist: { ...fp, isFoliaPlaylist: true },
          });
          list.push({
            id: fp.id,
            cacheKey,
            name: fp.name || (fp.isFavorite ? '我喜欢的音乐' : '本地歌单'),
            coverUrl,
            songCount: typeof fp.entryCount === 'number' ? fp.entryCount : 0,
            type: 'playlist',
            isLocal: true,
            isFoliaPlaylist: true,
            isLiked: Boolean(fp.isFavorite),
          });
        }
      }
    } catch {}

    try {
      // Legacy pre-0.8.0 storage placed local_playlists in KineticPlayerDB api_cache
      const localPlaylists = (await readCacheKeyFromStores('local_playlists', ['api_cache', 'user_cache'])) || [];
      if (Array.isArray(localPlaylists)) {
        for (const lp of localPlaylists) {
          if (!lp?.id || seenLocalIds.has(lp.id)) continue;
          seenLocalIds.add(lp.id);
          const count = Array.isArray(lp.songIds)
            ? lp.songIds.length
            : (Array.isArray(lp.songs)
              ? lp.songs.length
              : (Array.isArray(lp.trackIds) ? lp.trackIds.length : 0));
          const cacheKey = makeCollectionCacheKey('playlist', 'local', lp.id);
          cachedCollectionMap.set(cacheKey, { isLocal: true, rawLocalPlaylist: lp });
          list.push({
            id: lp.id,
            cacheKey,
            name: lp.name || '本地歌单',
            coverUrl: lp.coverUrl || '',
            songCount: count,
            type: 'playlist',
            isLocal: true,
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
    const omni = getLegacyInternalOmni();
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
                  const cacheKey = makeCollectionCacheKey('album', c.providerId, c.id);
                  cachedCollectionMap.set(cacheKey, { rawCollection: c });
                  list.push({
                    id: c.id,
                    providerId: c.providerId,
                    cacheKey,
                    name: c.name || '专辑',
                    artist: c.artist || c.creator?.name || '未知艺人',
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: 'album',
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
              const pId = c.providerId || activeSummary.providerId;
              const key = `${pId}:${c.id}`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                const cacheKey = makeCollectionCacheKey('album', pId, c.id);
                cachedCollectionMap.set(cacheKey, { rawCollection: c });
                list.push({
                  id: c.id,
                  providerId: pId,
                  cacheKey,
                  name: c.name || '专辑',
                  artist: c.artist || c.creator?.name || '未知艺人',
                  coverUrl: c.coverUrl || '',
                  songCount: c.trackCount || 0,
                  type: 'album',
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
      const providers = getKnownSnapshotProviderIds();
      for (const p of providers) {
        try {
          const snap = await readUserCacheKey(`online_provider_${p}_user_home_snapshot`);
          if (snap && Array.isArray(snap.collections)) {
            for (const c of snap.collections) {
              if (c.type === 'album') {
                const key = `${p}:${c.id}`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  const cacheKey = makeCollectionCacheKey('album', p, c.id);
                  cachedCollectionMap.set(cacheKey, { rawCollection: c });
                  list.push({
                    id: c.id,
                    providerId: p,
                    cacheKey,
                    name: c.name || '专辑',
                    artist: c.artist || c.creator?.name || '未知艺人',
                    coverUrl: c.coverUrl || '',
                    songCount: c.trackCount || 0,
                    type: 'album',
                  });
                }
              }
            }
          }
        } catch {}
      }
    }

    // 4. Local albums grouped from local_music (keep raw songs only in cachedCollectionMap)
    try {
      const allLocalSongs = await readIndexedDbTable('local_music');
      const albumMap = new Map();
      allLocalSongs.forEach((song) => {
        const meta = formatLocalSongMeta(song);
        const albumName = meta.albumName || '未知专辑';
        const artist = meta.artist;
        if (!albumMap.has(albumName)) {
          const albId = `local_album_${albumName}`;
          const cacheKey = makeCollectionCacheKey('album', 'local', albId);
          albumMap.set(albumName, {
            dto: {
              id: albId,
              cacheKey,
              name: albumName,
              artist,
              coverUrl: resolveLocalCoverUrl(song),
              songCount: 0,
              type: 'album',
              isLocal: true,
            },
            songs: [],
          });
        }
        const entry = albumMap.get(albumName);
        entry.dto.songCount += 1;
        entry.songs.push(song);
      });
      albumMap.forEach((entry) => {
        cachedCollectionMap.set(entry.dto.cacheKey, { isLocal: true, songs: entry.songs });
        list.push(entry.dto);
      });
    } catch {}

    return list;
  }

  /**
   * Retrieves Radio feed: Personal FM, Daily Recommendations, and Recommended Collections.
   */
  async function getLibraryRadioFeed() {
    const omni = getLegacyInternalOmni();
    let homeFeed = null;
    if (omni?.getHomeFeed) {
      try {
        homeFeed = await omni.getHomeFeed(35);
      } catch (err) {
        folium.log.warn('getHomeFeed error', err);
      }
    }

    cachedDailyRawSongs = (homeFeed?.dailySongs || []).map((song) => {
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
    });

    const selectedProvider = resolveSelectedProviderId(null);

    const recommendedCollections = (homeFeed?.recommendedCollections || []).map((c) => {
      const pId = c.providerId || selectedProvider;
      const cacheKey = makeCollectionCacheKey('playlist', pId, c.id);
      cachedCollectionMap.set(cacheKey, { rawCollection: c });
      return {
        id: c.id,
        providerId: pId,
        cacheKey,
        name: c.name || '推荐歌单',
        coverUrl: c.coverUrl || '',
        songCount: c.trackCount || 0,
        type: 'playlist',
      };
    });

    return {
      hasFm: true,
      dailyCount: cachedDailyRawSongs.length || 30,
      recommendedPlaylistsCount: recommendedCollections.length,
      dailySongs: cachedDailyRawSongs.map(toLightSongDto),
      recommendedCollections,
    };
  }

  let activePlaylistDetailRequestId = 0;

  /**
   * Retrieves songs inside a playlist (online or local).
   * Automatically loops through collection track pages to fetch tracks (100 per page),
   * storing rawSong objects in cachedDetailRawSongs and returning lightweight DTOs.
   */
  async function getLibraryPlaylistSongs(playlistItem, reqId) {
    const omni = getLegacyInternalOmni();
    const cachedEntry = playlistItem.cacheKey ? cachedCollectionMap.get(playlistItem.cacheKey) : null;

    // 1. Local / Folia aggregated playlist (0.8.0 FoliaPlaylistsDB + legacy local_playlists fallback)
    const rawLocalPlaylist = cachedEntry?.rawLocalPlaylist || playlistItem.rawLocalPlaylist;
    if (playlistItem.isLocal && (rawLocalPlaylist || playlistItem.isFoliaPlaylist || cachedEntry?.isFoliaPlaylist)) {
      const allLocalSongs = await readIndexedDbTable('local_music');
      if (isDisposed || (reqId && reqId !== activePlaylistDetailRequestId)) return [];
      const songMap = new Map(allLocalSongs.map((s) => [s.id, s]));
      const matched = [];

      if (playlistItem.isFoliaPlaylist || cachedEntry?.isFoliaPlaylist || rawLocalPlaylist?.isFoliaPlaylist) {
        const allEntries = await readIndexedDbTable('entries', 'FoliaPlaylistsDB');
        if (isDisposed || (reqId && reqId !== activePlaylistDetailRequestId)) return [];
        const playlistEntries = allEntries
          .filter((entry) => entry && entry.playlistId === playlistItem.id)
          .sort((a, b) => Number(a.pos ?? 0) - Number(b.pos ?? 0));
        for (const entry of playlistEntries) {
          const localId = entry.localSongId || entry.song?.localRef?.songId || (entry.song?.isLocal ? entry.song?.id : null);
          if (localId && songMap.has(localId)) {
            matched.push(buildLocalSongEntry(songMap.get(localId)));
          } else if (entry.song) {
            matched.push(formatRawSongEntry(entry.song));
          }
        }
      } else if (rawLocalPlaylist) {
        const lp = rawLocalPlaylist;
        const songIds = Array.isArray(lp.songIds)
          ? lp.songIds
          : (Array.isArray(lp.songs) ? lp.songs.map((s) => (typeof s === 'string' ? s : s?.id)) : []);
        songIds.forEach((id) => {
          const s = songMap.get(id);
          if (s) {
            matched.push(buildLocalSongEntry(s));
          }
        });
      }

      if (!reqId || reqId === activePlaylistDetailRequestId) {
        cachedDetailRawSongs = matched;
      }
      return matched.map(toLightSongDto);
    }

    // 2. Online playlist
    const fallbackProvider = resolveSelectedProviderId(null);
    const baseCollection = cachedEntry?.rawCollection || playlistItem.rawCollection || {
      id: playlistItem.id,
      providerId: playlistItem.providerId || fallbackProvider,
      type: playlistItem.type || 'playlist',
    };
    const collection = {
      ...baseCollection,
      providerId: baseCollection.providerId || fallbackProvider,
      type: baseCollection.type || 'playlist',
    };

    if (omni?.getCollectionTracks) {
      try {
        const allRawSongs = [];
        const seenTrackKeys = new Set();
        let offset = 0;
        const batchSize = 100;
        let hasMore = true;
        let iteration = 0;
        let consecutiveEmptyAdds = 0;
        const maxIterations = 50; // support up to 5000 songs
        let effectiveTotal = Math.max(
          Number(collection.trackCount) || 0,
          Number(playlistItem.songCount) || 0,
        );

        const trackDedupKey = (song) => {
          if (!song || typeof song !== 'object') return '';
          const ref = song.sourceRef;
          if (ref?.kind === 'online') return `online:${ref.providerId || ''}:${ref.mediaId ?? song.id}`;
          if (ref?.kind) return `${ref.kind}:${ref.mediaId ?? song.id}`;
          const pId = song.providerId || song.source || collection.providerId || '';
          return `${pId}:${song.id ?? ''}`;
        };

        while (hasMore && iteration < maxIterations) {
          iteration += 1;
          const pageStartOffset = offset;
          const page = await omni.getCollectionTracks(collection, { limit: batchSize, offset: pageStartOffset });
          if (isDisposed || (reqId && reqId !== activePlaylistDetailRequestId)) {
            return allRawSongs.map(toLightSongDto);
          }

          const items = Array.isArray(page?.items) ? page.items : [];
          if (items.length === 0) break;

          const pageTotal = Number(page?.total) || 0;
          if (pageTotal > effectiveTotal) {
            effectiveTotal = pageTotal;
          }

          let addedThisPage = 0;
          for (const song of items) {
            const key = trackDedupKey(song);
            if (key && seenTrackKeys.has(key)) continue;
            if (key) seenTrackKeys.add(key);
            addedThisPage += 1;
            allRawSongs.push(formatRawSongEntry(song));
          }

          const nextBucketOffset = (Math.floor(pageStartOffset / batchSize) + 1) * batchSize;
          const reportedHasMore = typeof page?.hasMore === 'boolean'
            ? page.hasMore
            : items.length >= batchSize;
          // KuGou (count === page size) & NetEase (items.length === limit) report hasMore: false on a
          // filtered short page (e.g. 99 < 100 on page 2) even when trackCount is much larger.
          const shouldProbeNextBucket = !reportedHasMore
            && addedThisPage > 0
            && effectiveTotal > nextBucketOffset;
          const pageHasMore = reportedHasMore || shouldProbeNextBucket;

          // Push intermediate snapshot after the first batch so user immediately sees first page
          if (iteration === 1 && pageHasMore) {
            if (!reqId || reqId === activePlaylistDetailRequestId) {
              cachedDetailRawSongs = [...allRawSongs];
              void pushSnapshot({
                libraryDetailData: {
                  type: playlistItem.type || 'playlist',
                  id: playlistItem.id,
                  title: playlistItem.name,
                  songs: allRawSongs.map(toLightSongDto),
                },
              });
            }
          }

          if (!pageHasMore) {
            hasMore = false;
          } else if (shouldProbeNextBucket) {
            consecutiveEmptyAdds = 0;
            offset = nextBucketOffset;
          } else if (addedThisPage === 0) {
            consecutiveEmptyAdds += 1;
            if (consecutiveEmptyAdds > 1 || nextBucketOffset <= pageStartOffset) break;
            offset = nextBucketOffset;
          } else {
            consecutiveEmptyAdds = 0;
            const nextCandidate = typeof page?.nextOffset === 'number' && page.nextOffset > pageStartOffset
              ? page.nextOffset
              : pageStartOffset + items.length;
            offset = nextCandidate;
          }
        }

        if (!reqId || reqId === activePlaylistDetailRequestId) {
          cachedDetailRawSongs = allRawSongs;
        }
        // Seed membership cache for free whenever user browses an online playlist in the menu
        if (collection.type === 'playlist' && allRawSongs.length > 0) {
          const ids = new Set();
          const tracksByKey = new Map();
          allRawSongs.forEach((entry) => {
            const raw = entry.rawSong || entry;
            getSongMatchKeys(raw).forEach((k) => {
              ids.add(k);
              tracksByKey.set(k, raw);
            });
          });
          playlistMembershipCache.set(makeMembershipCacheKey(collection.providerId, collection.id), {
            ids,
            tracksByKey,
            trackCount: effectiveTotal || allRawSongs.length,
            fetchedAt: Date.now(),
            complete: !hasMore,
          });
        }
        return allRawSongs.map(toLightSongDto);
      } catch (err) {
        folium.log.warn('omni getCollectionTracks failed', err);
      }
    }

    return [];
  }

  /**
   * Resolves the currently active Omni online provider id using official folium.omni.listProviders()
   * when available, falling back to legacy host summary.
   */
  function resolveSelectedProviderId(preferredId = null) {
    if (preferredId && typeof preferredId === 'string') return preferredId;
    if (hasOmniApi && typeof folium.omni?.listProviders === 'function') {
      try {
        const selected = folium.omni.listProviders().find((p) => p?.selected);
        const selectedId = getProviderIdOf(selected);
        if (selectedId) return selectedId;
      } catch {}
    }
    return getLegacyInternalOmni()?.getActiveProviderSummary?.()?.providerId || 'netease';
  }

  /**
   * Retrieves songs inside an album (online via official folium.omni or local).
   */
  async function getLibraryAlbumSongs(albumItem, reqId) {
    const cachedEntry = albumItem.cacheKey ? cachedCollectionMap.get(albumItem.cacheKey) : null;
    const localSongs = cachedEntry?.songs || albumItem.songs;
    if (albumItem.isLocal && Array.isArray(localSongs)) {
      const mapped = localSongs.map(buildLocalSongEntry);
      if (!reqId || reqId === activePlaylistDetailRequestId) {
        cachedDetailRawSongs = mapped;
      }
      return mapped.map(toLightSongDto);
    }

    // Online album: use official Folium 1.7+ folium.omni.resolveCollection + getTracks
    if (hasOmniApi && typeof folium.omni?.resolveCollection === 'function' && typeof folium.omni?.getTracks === 'function') {
      try {
        const providerId = resolveSelectedProviderId(albumItem.providerId);
        const collection = await folium.omni.resolveCollection({
          source: providerId,
          kind: 'album',
          id: String(albumItem.id),
        });
        if (isDisposed || (reqId && reqId !== activePlaylistDetailRequestId)) return [];
        if (collection) {
          const allRawSongs = [];
          let cursor = null;
          let iteration = 0;
          const maxIterations = 50;

          while (iteration < maxIterations) {
            iteration += 1;
            const page = await folium.omni.getTracks(collection, cursor ? { cursor } : { limit: 100 });
            if (isDisposed || (reqId && reqId !== activePlaylistDetailRequestId)) {
              return allRawSongs.map(toLightSongDto);
            }
            const items = Array.isArray(page?.items) ? page.items : [];
            if (items.length === 0) break;

            for (const song of items) {
              let durSec = 0;
              try {
                const details = folium.omni.describeSong?.(song);
                if (typeof details?.durationMs === 'number' && Number.isFinite(details.durationMs)) {
                  durSec = Math.round(details.durationMs / 1000);
                }
              } catch {}
              allRawSongs.push({
                id: song.id,
                title: song.title || '未知曲目',
                artist: song.artist || '未知艺人',
                album: song.album || collection.name || albumItem.name || '',
                duration: durSec,
                rawSong: song,
              });
            }

            if (iteration === 1 && page?.hasMore && page?.nextCursor) {
              if (!isDisposed && (!reqId || reqId === activePlaylistDetailRequestId)) {
                cachedDetailRawSongs = [...allRawSongs];
                void pushSnapshot({
                  libraryDetailData: {
                    type: 'album',
                    id: albumItem.id,
                    title: albumItem.name,
                    songs: allRawSongs.map(toLightSongDto),
                  },
                });
              }
            }

            if (!page?.hasMore || !page?.nextCursor) {
              break;
            }
            cursor = page.nextCursor;
          }

          if (allRawSongs.length > 0) {
            if (!reqId || reqId === activePlaylistDetailRequestId) {
              cachedDetailRawSongs = allRawSongs;
            }
            return allRawSongs.map(toLightSongDto);
          }
        }
      } catch (err) {
        folium.log.warn('folium.omni album read failed, falling back to collection tracks', err);
      }
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
        const meta = formatLocalSongMeta(s);
        return meta.title.toLowerCase().includes(q)
          || meta.artist.toLowerCase().includes(q)
          || meta.albumName.toLowerCase().includes(q);
      });
    }
    const total = filtered.length;
    const rawItems = filtered.slice(offset, offset + limit).map(buildLocalSongEntry);
    if (limit > 1) {
      cachedLocalPageRawSongs = rawItems;
    }
    return { items: rawItems.map(toLightSongDto), total };
  }

  /**
   * Plays a selected song from the library and sets context queue using client-cached rawSong objects.
   * Prioritizes official folium.playback.playSong when a valid ref is present.
   */
  async function playLibrarySong(payload = {}) {
    try {
      const songId = payload.songId !== undefined ? payload.songId : payload.song?.id;
      const contextType = payload.contextType || 'detail';
      const filterQuery = typeof payload.filterQuery === 'string' ? payload.filterQuery.trim().toLowerCase() : '';

      let sourceList = cachedDetailRawSongs;
      if (contextType === 'local') {
        sourceList = cachedLocalPageRawSongs;
      } else if (contextType === 'daily') {
        sourceList = cachedDailyRawSongs;
      } else if (filterQuery) {
        sourceList = cachedDetailRawSongs.filter((s) => {
          const title = (s.title || '').toLowerCase();
          const artist = (s.artist || '').toLowerCase();
          const album = (s.album || '').toLowerCase();
          return title.includes(filterQuery) || artist.includes(filterQuery) || album.includes(filterQuery);
        });
      }

      const matchedEntry = sourceList.find((item) => String(item.id) === String(songId))
        || cachedDetailRawSongs.find((item) => String(item.id) === String(songId))
        || cachedLocalPageRawSongs.find((item) => String(item.id) === String(songId))
        || cachedDailyRawSongs.find((item) => String(item.id) === String(songId));

      const rawSong = matchedEntry?.rawSong || payload.song?.rawSong;
      if (!rawSong) return;

      // 0. Official Folium 1.7+ replaceQueue + playQueueItem for reffed online tracks (e.g. album views)
      const reffedQueue = sourceList
        .map((q) => q.rawSong)
        .filter((s) => s && typeof s.ref === 'string' && s.ref.startsWith('song-'));
      if (
        hasReplaceQueueApi
        && rawSong.ref
        && reffedQueue.length > 0
        && reffedQueue.length === sourceList.length
        && typeof folium.playback?.getQueue === 'function'
      ) {
        try {
          const queueSnap = folium.playback.getQueue({ limit: 1 });
          const expectedVersion = queueSnap?.version;
          if (typeof expectedVersion === 'string' && expectedVersion) {
            const replaceRes = await folium.playback.replaceQueue(reffedQueue, { expectedVersion });
            if (isDisposed) return;
            if (replaceRes?.status === 'replaced') {
              const targetIndex = reffedQueue.findIndex((q) => q === rawSong || String(q.id) === String(songId));
              if (targetIndex >= 0) {
                const played = await folium.playback.playQueueItem(targetIndex, reffedQueue[targetIndex].ref);
                if (isDisposed) return;
                if (played) {
                  refreshQueue();
                  void pushSnapshot({
                    queue: currentSnapshot.queue,
                    queueTotal: currentSnapshot.queueTotal,
                    queuePage: currentSnapshot.queuePage,
                    currentIndex: currentSnapshot.currentIndex,
                  });
                  return;
                }
              }
            }
          }
        } catch (err) {
          folium.log?.warn?.('folium.playback.replaceQueue fell back', err);
        }
      }

      // 1. Official Folium API: if the song carries a valid session ref, play directly
      if (rawSong.ref && typeof folium.playback?.playSong === 'function') {
        try {
          const played = await folium.playback.playSong(rawSong);
          if (isDisposed) return;
          if (played) {
            refreshQueue();
            return;
          }
        } catch (err) {
          folium.log?.warn?.('folium.playback.playSong rejected ref, trying queue fallback', err);
        }
      }

      // 2. Official Folium API: check if the song exists in current host queue
      const queueSnapshot = folium.playback?.getQueue?.();
      if (queueSnapshot && Array.isArray(queueSnapshot.items)) {
        const queueIndex = queueSnapshot.items.findIndex((item) => String(item.song?.id) === String(songId));
        if (queueIndex >= 0) {
          await folium.playback.playQueueItem(queueIndex);
          if (isDisposed) return;
          refreshQueue();
          return;
        }
      }

      // 3. Transitional fallback for un-reffed local/playlist tracks
      const pStore = tryGetInternalStores()?.playback;
      if (!pStore) {
        // Forward-compatible Folium 2+ fallback: resolve online track key via official folium.omni
        if (!rawSong.isLocal && hasOmniApi && typeof folium.omni?.resolveSongs === 'function') {
          const source = rawSong.source || rawSong.providerId || rawSong.sourceRef?.providerId || resolveSelectedProviderId(null);
          if (source && rawSong.id !== undefined && rawSong.id !== null) {
            const resolved = await folium.omni.resolveSongs([{ source, id: String(rawSong.id) }]);
            if (isDisposed) return;
            const found = Array.isArray(resolved) ? resolved.find((r) => r?.status === 'found' && r.song) : null;
            if (found?.song) {
              await folium.playback.playSong(found.song);
              if (isDisposed) return;
              refreshQueue();
            }
          }
        }
        return;
      }

      const rawQueue = sourceList.map((q) => q.rawSong).filter(Boolean);
      const nextQueue = rawQueue.length > 0 ? rawQueue : [rawSong];

      applyInternalPlaybackQueue(pStore, nextQueue, false);

      const targetIndex = nextQueue.findIndex((q) => String(q.id) === String(rawSong.id));
      const safeIndex = targetIndex >= 0 ? targetIndex : 0;

      const timer = setTimeout(async () => {
        pendingPlayTimers.delete(timer);
        if (isDisposed) return;
        try {
          await folium.playback.playQueueItem(safeIndex);
          if (isDisposed) return;
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
      pendingPlayTimers.add(timer);
    } catch (err) {
      folium.log.warn('playLibrarySong error', err);
    }
  }

  /**
   * Switches to Personal FM mode.
   */
  async function playPersonalFmMode() {
    try {
      const omni = getLegacyInternalOmni();
      const pStore = tryGetInternalStores()?.playback;
      if (!omni || !pStore) return;

      let tracks = [];
      try {
        tracks = await omni.getPersonalFm?.();
      } catch (err) {
        folium.log.warn('getPersonalFm error', err);
      }
      if (isDisposed) return;

      if (!Array.isArray(tracks) || tracks.length === 0) {
        try {
          const feed = await omni.getHomeFeed?.(20);
          tracks = feed?.personalFm || [];
        } catch {}
      }
      if (isDisposed) return;

      if (Array.isArray(tracks) && tracks.length > 0) {
        applyInternalPlaybackQueue(pStore, tracks, true);
        const timer = setTimeout(async () => {
          pendingPlayTimers.delete(timer);
          if (isDisposed) return;
          try {
            await folium.playback.playQueueItem(0);
            if (isDisposed) return;
            refreshQueue();
            void pushSnapshot({
              queue: currentSnapshot.queue,
              queueTotal: currentSnapshot.queueTotal,
              currentIndex: 0,
            });
          } catch (err) {
            folium.log.warn('playPersonalFmMode failed', err);
          }
        }, 60);
        pendingPlayTimers.add(timer);
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
        key: 'rightFadeDelaySec',
        type: 'number',
        label: {
          'zh-CN': '悬停隐藏右侧缓冲时间（秒）',
          en: 'Hover-Hide Right Controls Buffer (s)',
        },
        description: {
          'zh-CN': '悬停隐藏模式下，鼠标移入右侧控制区后的缓慢渐隐缓冲时长（默认 1.5 秒，设为 0 则立即隐藏）',
          en: 'Slow fade-out buffer duration when hovering the right controls in hover-hide mode (default 1.5s; 0 hides immediately)',
        },
        defaultValue: 1.5,
        min: 0,
        max: 6,
        step: 0.1,
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
            value: 'wallpaper',
            label: {
              'zh-CN': '跟随壁纸显示器',
              en: 'Follow Folia Wallpaper Display',
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
        key: 'showLyrics',
        type: 'boolean',
        label: {
          'zh-CN': '显示任务栏歌词',
          en: 'Show Taskbar Lyrics',
        },
        description: {
          'zh-CN': '关闭后任务栏中央仅静态显示当前曲目标题与作者（也可点击弹窗底部眼睛按钮或绑定全局快捷键）',
          en: 'When disabled, the center stage shows song title and artist only instead of scrolling lyrics',
        },
        defaultValue: true,
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

  // Register Command Palette & Global Shortcut commands (Folium 1.7+)
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
    folium.registries.commands.register({
      id: 'toggle-lyrics',
      label: {
        'zh-CN': '显示/隐藏任务栏歌词正文',
        en: 'Toggle Taskbar Lyrics Text',
      },
      description: {
        'zh-CN': '切换任务栏中央是否显示滚动歌词（隐藏时仅展示歌名与作者）',
        en: 'Toggle scrolling lyrics in the taskbar drawer (shows song title and artist when hidden)',
      },
      globalShortcut: true,
      run: () => {
        toggleGlobalShowLyrics();
      },
    });
  }

  function toggleGlobalShowLyrics() {
    const nextShow = currentSnapshot.settings?.showLyrics === false;
    currentSnapshot.settings = {
      ...currentSnapshot.settings,
      showLyrics: nextShow,
    };
    currentSnapshot.lyricsVisible = nextShow;
    try {
      settingsAccess?.set?.({ showLyrics: nextShow });
    } catch {}
    void pushSnapshot({
      settings: currentSnapshot.settings,
      lyricsVisible: nextShow,
    });
  }

  function syncSettings() {
    try {
      if (settingsAccess?.get) {
        const values = settingsAccess.get();
        const showLyrics = values?.showLyrics;
        const showTr = values?.showTranslation;
        const useBg = values?.useCoverBackground;
        const mode = values?.interactionMode === 'hover-hide' ? 'hover-hide' : 'standard';
        const rawFadeSec = Number(values?.rightFadeDelaySec);
        const rightFadeDelaySec = Number.isFinite(rawFadeSec)
          ? Math.round(Math.max(0, Math.min(6, rawFadeSec)) * 10) / 10
          : 1.5;
        const display = typeof values?.targetDisplay === 'string' && values.targetDisplay
          ? values.targetDisplay
          : 'primary';
        const resolvedShowLyrics = typeof showLyrics === 'boolean' ? showLyrics : true;
        currentSnapshot.settings = {
          interactionMode: mode,
          rightFadeDelaySec,
          targetDisplay: display,
          showLyrics: resolvedShowLyrics,
          showTranslation: typeof showTr === 'boolean' ? showTr : true,
          useCoverBackground: typeof useBg === 'boolean' ? useBg : true,
        };
        currentSnapshot.lyricsVisible = resolvedShowLyrics;
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
      void pushSnapshot({
        settings: currentSnapshot.settings,
        lyricsVisible: currentSnapshot.lyricsVisible,
      });
    }));
  }

  function resolveEffectiveLyricOffsetMs() {
    try {
      let songOffset = 0;
      const internalStores = tryGetInternalStores();
      try {
        const pState = internalStores?.playback?.getState?.();
        if (pState && typeof pState.lyricTimelineOffsetMs === 'number' && Number.isFinite(pState.lyricTimelineOffsetMs)) {
          songOffset = pState.lyricTimelineOffsetMs;
        }
      } catch {
        // Ignored
      }

      let globalOffset = 0;
      let hasStoreGlobal = false;
      try {
        const lState = internalStores?.lyricSettings?.getState?.();
        if (lState && typeof lState.globalLyricTimelineOffsetMs === 'number' && Number.isFinite(lState.globalLyricTimelineOffsetMs)) {
          globalOffset = lState.globalLyricTimelineOffsetMs;
          hasStoreGlobal = true;
        }
      } catch {
        // Ignored
      }

      if (!hasStoreGlobal && typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('global_lyric_timeline_offset_ms');
        const val = Number(stored);
        if (Number.isFinite(val)) {
          globalOffset = val;
        }
      }

      return songOffset + globalOffset;
    } catch {
      return 0;
    }
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

  /**
   * Pushes high-frequency playback anchor to the taskbar drawer window.
   * Ensures the taskbar extrapolation clock is regularly pinned to the real audio decoder without backward bounce.
   * @param {boolean} force Force immediate push regardless of threshold
   * @param {boolean} isSeek Flag indicating an intentional seek or state reset
   */
  function pushPlaybackAnchor(force = false, isSeek = false) {
    try {
      const clock = samplePlaybackClock();
      const now = clock.updatedAt;
      const pos = clock.position;
      const state = clock.state;
      const isAdvancing = Boolean(clock.isAdvancing);
      const prevState = currentSnapshot.playerState;
      const prevAdvancing = Boolean(currentSnapshot.isAdvancing);

      currentSnapshot.currentTime = pos;
      currentSnapshot.playerState = state;
      currentSnapshot.isAdvancing = isAdvancing;
      currentSnapshot.duration = clock.duration;
      currentSnapshot.updatedAt = now;
      currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();

      // When Folia is in the background without an active DOM <audio> and host position is frozen,
      // avoid pushing redundant extrapolated anchors unless forced or state/advancing changed.
      if (!force && !clock.isFresh && state === prevState && isAdvancing === prevAdvancing) {
        return;
      }

      const elapsedWallSec = (lastAudioSyncPushWallTime > 0 && prevAdvancing)
        ? (now - lastAudioSyncPushWallTime) / 1000
        : 0;
      const expectedExtrapolatedPos = lastAudioSyncPushedTime >= 0
        ? lastAudioSyncPushedTime + elapsedWallSec
        : -1;
      const driftFromExtrapolation = expectedExtrapolatedPos >= 0
        ? Math.abs(pos - expectedExtrapolatedPos)
        : 999;
      const wallDiff = now - lastAudioSyncPushWallTime;

      const shouldPush = force
        || lastAudioSyncPushedTime < 0
        || state !== prevState
        || isAdvancing !== prevAdvancing
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
          lyricOffsetMs: currentSnapshot.lyricOffsetMs,
          updatedAt: now,
          isSeek: Boolean(isSeek),
        });
      }
    } catch {
      // Ignored
    }
  }

  // Listen for Folia Event Bus

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
        if (typeof hostState.duration === 'number' && Number.isFinite(hostState.duration) && hostState.duration >= 0) {
          currentSnapshot.duration = hostState.duration;
        }
        if (typeof hostState.liked === 'boolean') {
          currentSnapshot.liked = hostState.liked;
        }
        if (typeof hostState.canLike === 'boolean') {
          currentSnapshot.canLike = hostState.canLike;
        }
      }
    } catch {}
    cachedWheelPlaylistMap.clear();

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
      liked: currentSnapshot.liked,
      canLike: currentSnapshot.canLike,
      queue: currentSnapshot.queue,
      queueTotal: currentSnapshot.queueTotal,
      queuePage: currentSnapshot.queuePage,
      currentIndex: currentSnapshot.currentIndex,
      lyricOffsetMs: currentSnapshot.lyricOffsetMs,
      currentTime: 0,
      duration: currentSnapshot.duration,
      playerState: currentSnapshot.playerState,
      isAdvancing: false,
      updatedAt: now,
      isSeek: true,
    });
    scheduleQuickClockSync();
  }));

  // 2. Playback state changed (playing, paused, stopped)
  unsubs.push(folium.events.on('playback.stateChanged', (event) => {
    if (event && event.state) {
      currentSnapshot.playerState = normalizePlayerState(event.state);
      pushPlaybackAnchor(true, false);
      if (currentSnapshot.playerState === 'playing') {
        scheduleQuickClockSync();
      }
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
    currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();
    lastAudioSyncPushedTime = pos;
    lastAudioSyncPushWallTime = now;
    lastObservedHostPos = pos;
    lastObservedHostWallTime = now;
    void pushSnapshot({
      currentTime: pos,
      duration: currentSnapshot.duration,
      playerState: currentSnapshot.playerState,
      isAdvancing: clock.isAdvancing,
      lyricOffsetMs: currentSnapshot.lyricOffsetMs,
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

  // 7b. Playback failed (freeze extrapolation immediately so taskbar clock does not drift on unplayable tracks)
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

    // 7c. Account sign-in settled or changed (refresh cached library summaries/lists loaded during cold start)
    try {
      unsubs.push(folium.events.on('account.changed', () => {
        cachedCollectionMap.clear();
        cachedWheelPlaylistMap.clear();
        playlistMembershipCache.clear();
        refreshLikeStateFromHost();
        void pushSnapshot({
          liked: currentSnapshot.liked,
          canLike: currentSnapshot.canLike,
        });
        if (currentSnapshot.librarySummary) {
          void handleClientAction({ action: 'fetchLibrarySummary' });
        }
        const openCat = currentSnapshot.libraryCategoryData?.category;
        if (openCat === 'playlists' || openCat === 'albums' || openCat === 'radio') {
          void handleClientAction({ action: 'fetchLibraryCategory', payload: { category: openCat } });
        }
      }));
    } catch {}

    // 7d. Like state changed
    try {
      unsubs.push(folium.events.on('playback.likeChanged', (event) => {
        refreshLikeStateFromHost();
        if (typeof event?.liked === 'boolean') {
          currentSnapshot.liked = event.liked;
        }
        void pushSnapshot({
          liked: currentSnapshot.liked,
          canLike: currentSnapshot.canLike,
        });
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

  // 8. Theme changed (official Folium theme event and theme helpers)
  unsubs.push(folium.events.on('theme.changed', (event) => {
    hasReceivedThemeEvent = true;
    const nextTheme = (event && event.theme && typeof event.theme === 'object'
      ? normalizeThemeSnapshot(event.theme)
      : null) || resolveCurrentTheme();
    cachedLiveTheme = nextTheme;
    currentSnapshot.theme = nextTheme;
    void pushSnapshot({ theme: nextTheme });
  }));

  // 9. Per-song & global lyric timeline offset changes
  try {
    const internalStores = tryGetInternalStores();
    const pStore = internalStores?.playback;
    if (typeof pStore?.subscribe === 'function') {
      let prevSongOffset = pStore.getState?.()?.lyricTimelineOffsetMs;
      unsubs.push(pStore.subscribe((state) => {
        const nextSongOffset = state?.lyricTimelineOffsetMs;
        if (typeof nextSongOffset === 'number' && nextSongOffset !== prevSongOffset) {
          prevSongOffset = nextSongOffset;
          const nextEffective = resolveEffectiveLyricOffsetMs();
          if (nextEffective !== currentSnapshot.lyricOffsetMs) {
            currentSnapshot.lyricOffsetMs = nextEffective;
            void pushSnapshot({ lyricOffsetMs: nextEffective });
          }
        }
      }));
    }

    const lStore = internalStores?.lyricSettings;
    if (typeof lStore?.subscribe === 'function') {
      let prevGlobalOffset = lStore.getState?.()?.globalLyricTimelineOffsetMs;
      unsubs.push(lStore.subscribe((state) => {
        const nextGlobalOffset = state?.globalLyricTimelineOffsetMs;
        if (typeof nextGlobalOffset === 'number' && nextGlobalOffset !== prevGlobalOffset) {
          prevGlobalOffset = nextGlobalOffset;
          const nextEffective = resolveEffectiveLyricOffsetMs();
          if (nextEffective !== currentSnapshot.lyricOffsetMs) {
            currentSnapshot.lyricOffsetMs = nextEffective;
            void pushSnapshot({ lyricOffsetMs: nextEffective });
          }
        }
      }));
    }
  } catch {
    // Ignored
  }

  // Initial Sync
  refreshPlaybackState();
  syncPlaybackStoreLyricsAndSong();
  refreshAudioState();
  refreshQueue();
  currentSnapshot.theme = resolveCurrentTheme();
  currentSnapshot.lyricOffsetMs = resolveEffectiveLyricOffsetMs();

  void pushSnapshot({
    song: currentSnapshot.song,
    playerState: currentSnapshot.playerState,
    isAdvancing: currentSnapshot.isAdvancing,
    currentTime: currentSnapshot.currentTime,
    duration: currentSnapshot.duration,
    lyricOffsetMs: currentSnapshot.lyricOffsetMs,
    updatedAt: currentSnapshot.updatedAt,
    lyrics: currentSnapshot.lyrics,
    lyricsVisible: currentSnapshot.lyricsVisible,
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
    settings: currentSnapshot.settings,
    hasPlaybackControls: currentSnapshot.hasPlaybackControls,
  }).finally(() => {
    if (hasRpcPush) {
      void drainPendingActionsOnce();
    }
  });

  async function handleClientAction(item) {
    if (!item || !item.action) return;
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
          currentSnapshot.settings = {
            ...currentSnapshot.settings,
            targetDisplay: item.payload,
          };
          try {
            settingsAccess?.set?.({ targetDisplay: item.payload });
          } catch {}
        }
        break;
      case 'releaseMenuMemory':
        cachedCollectionMap.clear();
        cachedDetailRawSongs = [];
        cachedLocalPageRawSongs = [];
        cachedDailyRawSongs = [];
        currentSnapshot.libraryCategoryData = null;
        currentSnapshot.libraryDetailData = null;
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
        if (isDisposed) return;
        const albums = await getLibraryAlbums();
        if (isDisposed) return;
        const local = await getLibraryLocalSongs(0, 1);
        if (isDisposed) return;
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
          if (isDisposed) return;
          void pushSnapshot({ libraryCategoryData: { category: 'playlists', items: lists } });
        } else if (cat === 'albums') {
          const albums = await getLibraryAlbums();
          if (isDisposed) return;
          void pushSnapshot({ libraryCategoryData: { category: 'albums', items: albums } });
        } else if (cat === 'radio') {
          const radioFeed = await getLibraryRadioFeed();
          if (isDisposed) return;
          void pushSnapshot({ libraryCategoryData: { category: 'radio', radioFeed } });
        } else if (cat === 'local') {
          const page = Number(item.payload?.page) || 0;
          const query = item.payload?.query || '';
          const pageSize = 100;
          const res = await getLibraryLocalSongs(page * pageSize, pageSize, query);
          if (isDisposed) return;
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
          if (!isDisposed && reqId === activePlaylistDetailRequestId) {
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
          if (!isDisposed && reqId === activePlaylistDetailRequestId) {
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
        if (item.payload) {
          await playLibrarySong(item.payload);
        }
        break;
      }
      case 'playRadioFm': {
        await playPersonalFmMode();
        break;
      }
      case 'toggleShowLyrics': {
        toggleGlobalShowLyrics();
        break;
      }
      case 'toggleLike': {
        await toggleCurrentSongLike();
        break;
      }
      case 'fetchRadialTargets': {
        const result = await buildRadialWheelTargets();
        if (!isDisposed && !result.stale) {
          void pushSnapshot({
            liked: currentSnapshot.liked,
            canLike: currentSnapshot.canLike,
            radialTargets: result.targets,
          });
          if (typeof result.startHydration === 'function') {
            result.startHydration();
          }
        }
        break;
      }
      case 'selectRadialTarget': {
        await handleRadialTargetSelection(item.payload);
        break;
      }
      case 'openPlayerPage': {
        try {
          if (typeof folium.ui?.navigate === 'function') {
            folium.ui.navigate('player');
          } else {
            tryGetInternalStores()?.appView?.getState?.()?.setView?.('player');
          }
        } catch (err) {
          folium.log.warn('Failed to navigate to player page', err);
        }
        break;
      }
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

  // Subscribe to Folium 1.7+ RPC push channel for immediate control & seek dispatch
  if (hasRpcPush) {
    const unsubClientAction = folium.rpc.on('clientAction', (item) => {
      void handleClientAction(item);
    });
    if (typeof unsubClientAction === 'function') {
      unsubs.push(unsubClientAction);
    }
  }

  // Cold-start post-mount theme catch-up (App's first useEffect primes getCurrent() without emitting theme.changed)
  const postMountThemeTimerA = hasThemeCurrentApi
    ? setTimeout(() => syncPostMountThemeIfNeeded(), 350)
    : null;
  const postMountThemeTimerB = hasThemeCurrentApi
    ? setTimeout(() => syncPostMountThemeIfNeeded(), 1500)
    : null;

  // Audio Clock Poll Loop (200ms) + legacy drainActions polling only on pre-1.7 hosts without rpc.on
  const actionPollTimer = setInterval(async () => {
    try {
      if (!hasRpcPush) {
        await drainPendingActionsOnce();
      }

      // High-assurance audio synchronization: check playback anchor & reconcile like state on each poll cycle
      pushPlaybackAnchor(false, false);
      reconcileLikeStateIfChanged();
    } catch {
      // Ignored
    }
  }, 200);

  // Return Disposer
  return () => {
    isDisposed = true;
    clearInterval(actionPollTimer);
    if (postMountThemeTimerA) clearTimeout(postMountThemeTimerA);
    if (postMountThemeTimerB) clearTimeout(postMountThemeTimerB);
    clearQuickSyncTimers();
    pendingPlayTimers.forEach((timer) => clearTimeout(timer));
    pendingPlayTimers.clear();
    cachedCollectionMap.clear();
    cachedWheelPlaylistMap.clear();
    playlistMembershipCache.clear();
    cachedDetailRawSongs = [];
    cachedLocalPageRawSongs = [];
    cachedDailyRawSongs = [];
    unsubs.forEach((unsub) => {
      try { unsub(); } catch { /* ignore */ }
    });
  };
}
