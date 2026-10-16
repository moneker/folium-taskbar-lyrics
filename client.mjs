// mods/taskbar-lyrics/client.mjs
// Renderer ESM entry for the Taskbar Lyrics Drawer mod.
// Listens to Folia playback and lyric events, synchronizes snapshots with the main process,
// dispatches user playback controls, and registers mod settings.
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
    loopMode: 'all',
    volume: 100,
    isMuted: false,
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

  /**
   * Refreshes the play queue using Folium 1.5 getQueue API.
   */
  function refreshQueue() {
    try {
      if (typeof folium.playback.getQueue === 'function') {
        const page = folium.playback.getQueue({ limit: 100 });
        if (page && Array.isArray(page.items)) {
          currentSnapshot.queueTotal = typeof page.length === 'number' ? page.length : page.items.length;
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

  function syncSettings() {
    try {
      if (settingsSection?.params?.get) {
        const values = settingsSection.params.get();
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

  if (settingsSection?.params?.subscribe) {
    settingsSection.params.subscribe(() => {
      syncSettings();
      void pushSnapshot({ settings: currentSnapshot.settings });
    });
  }

  // Listen for Folia Event Bus
  const unsubs = [];

  // 1. Song changed
  unsubs.push(folium.events.on('playback.songChanged', (event) => {
    refreshPlaybackState();
    if (event && event.song) {
      currentSnapshot.song = {
        title: event.song.title || '未知曲目',
        artist: event.song.artist || 'Folia',
        coverUrl: currentSnapshot.song?.coverUrl || null,
      };
    }
    refreshQueue();
    void pushSnapshot({
      song: currentSnapshot.song,
      queue: currentSnapshot.queue,
      lyricOffsetMs: currentSnapshot.lyricOffsetMs,
      currentTime: currentSnapshot.currentTime,
      duration: currentSnapshot.duration,
      playerState: currentSnapshot.playerState,
    });
  }));

  // 2. Playback state changed (playing, paused, stopped)
  // Direct reading of event.state string and host position/duration to eliminate UI flash
  unsubs.push(folium.events.on('playback.stateChanged', (event) => {
    if (event && event.state) {
      const nextState = normalizePlayerState(event.state);
      const hostState = folium.playback.getState();
      const nextPos = typeof hostState?.position === 'number' ? hostState.position : currentSnapshot.currentTime;
      const nextDur = typeof hostState?.duration === 'number' && hostState.duration > 0 ? hostState.duration : currentSnapshot.duration;
      currentSnapshot.playerState = nextState;
      currentSnapshot.currentTime = nextPos;
      currentSnapshot.duration = nextDur;
      currentSnapshot.updatedAt = Date.now();
      void pushSnapshot({
        playerState: nextState,
        currentTime: nextPos,
        duration: nextDur,
        updatedAt: currentSnapshot.updatedAt,
      });
    }
  }));

  // 3. Playback seeked
  unsubs.push(folium.events.on('playback.seeked', (event) => {
    if (typeof event?.position === 'number') {
      currentSnapshot.currentTime = event.position;
      currentSnapshot.updatedAt = Date.now();
      void pushSnapshot({
        currentTime: currentSnapshot.currentTime,
        updatedAt: currentSnapshot.updatedAt,
      });
    }
  }));

  // 4. Lyrics loaded (stable Folium event)
  unsubs.push(folium.events.on('lyrics.loaded', (event) => {
    if (event && Array.isArray(event.lines)) {
      currentSnapshot.lyrics = {
        lines: event.lines.map((line) => ({
          startTime: line.startTime,
          endTime: line.endTime,
          fullText: line.fullText || line.text || '',
          text: line.text || '',
          translation: line.translation || '',
          words: Array.isArray(line.words) ? line.words.map((w) => ({
            text: w.text,
            startTime: w.startTime,
            endTime: w.endTime,
          })) : null,
        })),
      };
      void pushSnapshot({ lyrics: currentSnapshot.lyrics });
    }
  }));

  // 5. Folium 1.5 Playback Event Subscriptions
  if (hasPlaybackControls) {
    unsubs.push(folium.events.on('playback.volumeChanged', (event) => {
      if (event) {
        currentSnapshot.volume = Math.round((event.volume ?? 1) * 100);
        currentSnapshot.isMuted = Boolean(event.muted);
        void pushSnapshot({
          volume: currentSnapshot.volume,
          isMuted: currentSnapshot.isMuted,
        });
      }
    }));

    unsubs.push(folium.events.on('playback.loopModeChanged', (event) => {
      if (event && event.mode) {
        currentSnapshot.loopMode = event.mode;
        void pushSnapshot({ loopMode: event.mode });
      }
    }));

    unsubs.push(folium.events.on('playback.queueChanged', () => {
      refreshQueue();
      void pushSnapshot({ queue: currentSnapshot.queue, queueTotal: currentSnapshot.queueTotal });
    }));
  }

  // Subscribe to Zustand stores.playback for lyric timeline offset and cover URL
  try {
    const pStore = folium.internals?.stores?.playback;
    if (pStore?.subscribe) {
      const unsubStore = pStore.subscribe((state) => {
        if (!state) return;
        if (Number.isFinite(state.lyricTimelineOffsetMs) && state.lyricTimelineOffsetMs !== currentSnapshot.lyricOffsetMs) {
          currentSnapshot.lyricOffsetMs = state.lyricTimelineOffsetMs;
          void pushSnapshot({ lyricOffsetMs: currentSnapshot.lyricOffsetMs });
        }
        const cover = state.transitionDisplay?.coverUrl
          || state.cachedCoverUrl
          || state.currentSong?.album?.coverUrl
          || state.currentSong?.coverUrl
          || state.currentSong?.picUrl
          || null;
        if (cover && currentSnapshot.song && currentSnapshot.song.coverUrl !== cover) {
          currentSnapshot.song.coverUrl = cover;
          void pushSnapshot({ song: currentSnapshot.song });
        }
      });
      unsubs.push(unsubStore);
    }
  } catch {
    // Ignored
  }

  // Register Command Palette Action
  unsubs.push(folium.registries.commands.register({
    id: 'toggle-taskbar-drawer',
    title: {
      'zh-CN': '任务栏歌词：展开/收起抽屉',
      en: 'Taskbar Lyrics: Expand / Collapse Drawer',
    },
    category: {
      'zh-CN': '界面',
      en: 'Interface',
    },
    run: async () => {
      try {
        await folium.rpc.call('toggleDrawer');
      } catch (err) {
        folium.log.warn('Failed to toggle taskbar drawer via command palette', err);
      }
    },
  }));

  // Initial synchronization
  refreshAudioState();
  refreshPlaybackState();
  refreshQueue();
  try {
    const pState = folium.internals?.stores?.playback?.getState?.();
    if (pState) {
      if (Number.isFinite(pState.lyricTimelineOffsetMs)) {
        currentSnapshot.lyricOffsetMs = pState.lyricTimelineOffsetMs;
      }
      const cover = pState.transitionDisplay?.coverUrl
        || pState.cachedCoverUrl
        || pState.currentSong?.album?.coverUrl
        || pState.currentSong?.coverUrl
        || pState.currentSong?.picUrl
        || null;
      if (cover && currentSnapshot.song) {
        currentSnapshot.song.coverUrl = cover;
      }
    }
  } catch {}
  void pushSnapshot(currentSnapshot);

  // Periodic poll: sync playback position and drain user actions from taskbar window
  const actionPollTimer = setInterval(async () => {
    try {
      const state = folium.playback.getState();
      if (state) {
        let needsPush = false;
        const normalized = normalizePlayerState(state.state);
        if (normalized !== currentSnapshot.playerState) {
          currentSnapshot.playerState = normalized;
          needsPush = true;
        }

        if (typeof state.duration === 'number' && state.duration > 0) {
          if (Math.abs(state.duration - (currentSnapshot.duration || 0)) > 0.5) {
            currentSnapshot.duration = state.duration;
            needsPush = true;
          }
        }

        if (typeof state.position === 'number') {
          const delta = Math.abs(state.position - currentSnapshot.currentTime);
          if (normalized !== 'playing' ? delta > 0.05 : delta > 0.6) {
            currentSnapshot.currentTime = state.position;
            currentSnapshot.updatedAt = Date.now();
            needsPush = true;
          }
        }

        if (needsPush) {
          void pushSnapshot({
            currentTime: currentSnapshot.currentTime,
            duration: currentSnapshot.duration,
            playerState: currentSnapshot.playerState,
            updatedAt: currentSnapshot.updatedAt,
          });
        }
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
                folium.playback.seek(item.payload);
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
                refreshQueue();
                void pushSnapshot({ queue: currentSnapshot.queue, queueTotal: currentSnapshot.queueTotal });
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
                    refreshQueue();
                    void pushSnapshot({ queue: currentSnapshot.queue, queueTotal: currentSnapshot.queueTotal });
                  }
                } catch (err) {
                  folium.log.warn('playQueueItem failed', err);
                }
              }
              break;
            }
          }
        }
      }
    } catch {
      // Ignored
    }
  }, 250);

  // Return Disposer
  return () => {
    clearInterval(actionPollTimer);
    unsubs.forEach((unsub) => {
      try { unsub(); } catch { /* ignore */ }
    });
  };
}
