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

  let currentSnapshot = {
    song: null,
    playerState: 'paused',
    currentTime: 0,
    duration: 0,
    lyricOffsetMs: 0,
    updatedAt: Date.now(),
    lyrics: null,
    queue: [],
    loopMode: 'all',
    volume: 100,
    isMuted: false,
    settings: {
      showTranslation: true,
      useCoverBackground: true,
    },
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

  // Refresh play queue and lyric offset from playback store
  function refreshQueue() {
    try {
      const pState = folium.internals?.stores?.playback?.getState?.();
      if (pState) {
        currentSnapshot.lyricOffsetMs = Number.isFinite(pState.lyricTimelineOffsetMs) ? pState.lyricTimelineOffsetMs : 0;
        const currentSong = pState.currentSong;
        currentSnapshot.queue = (pState.playQueue || []).map((s, idx) => ({
          index: idx,
          title: s.name || s.title || '未知曲目',
          artist: (s.artists || []).map((a) => a?.name).filter(Boolean).join(' / ') || s.artist || '未知艺人',
          active: currentSong ? (s.id === currentSong.id || s === currentSong) : false,
        }));
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
            coverUrl: state.song.coverUrl || null,
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
        coverUrl: event.song.coverUrl || null,
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
  unsubs.push(folium.events.on('playback.stateChanged', (event) => {
    if (event?.state) {
      const nextState = normalizePlayerState(event.state.state);
      const nextPos = typeof event.state.position === 'number' ? event.state.position : currentSnapshot.currentTime;
      const nextDur = typeof event.state.duration === 'number' && event.state.duration > 0 ? event.state.duration : currentSnapshot.duration;
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

  // Dynamic resolution of host useAudioSettingsStore
  let audioSettingsStore = null;
  let audioSettingsInitPromise = null;

  async function resolveAudioSettingsStore() {
    // 1. First priority: check folium.internals
    try {
      const s = folium.internals?.stores?.audioSettings;
      if (s?.getState && typeof s.getState().handleSetVolume === 'function') {
        return s;
      }
    } catch {}

    // 2. Locate the loaded useAudioSettingsStore chunk from performance resource timing or document
    try {
      let scriptUrl = null;
      if (typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function') {
        const entries = performance.getEntriesByType('resource');
        for (const r of entries) {
          if (r.name && r.name.includes('useAudioSettingsStore') && r.name.endsWith('.js')) {
            scriptUrl = r.name;
            break;
          }
        }
      }

      if (!scriptUrl && typeof document !== 'undefined') {
        const el = document.querySelector('link[href*="useAudioSettingsStore"], script[src*="useAudioSettingsStore"]');
        if (el) {
          scriptUrl = el.href || el.src;
        }
      }

      if (!scriptUrl && typeof window !== 'undefined' && window.location) {
        scriptUrl = new URL('./assets/useAudioSettingsStore-Dsrh8mUm.js', window.location.href).href;
      }

      if (scriptUrl) {
        const mod = await import(/* @vite-ignore */ scriptUrl);
        for (const key of Object.keys(mod)) {
          const val = mod[key];
          if (val && typeof val.getState === 'function') {
            const st = val.getState();
            if (st && typeof st.handleSetVolume === 'function' && typeof st.handleToggleLoopMode === 'function') {
              return val;
            }
          }
        }
      }
    } catch (err) {
      folium.log.warn('Could not resolve audio settings store dynamically', err);
    }

    return null;
  }

  // Initial read from localStorage cache for instant UI response before async import completes
  try {
    if (typeof localStorage !== 'undefined') {
      const savedVol = localStorage.getItem('player_volume');
      if (savedVol !== null && Number.isFinite(Number(savedVol))) {
        currentSnapshot.volume = Math.round(Math.max(0, Math.min(1, Number(savedVol))) * 100);
      }
      const savedLoop = localStorage.getItem('player_loop_mode');
      if (savedLoop) {
        currentSnapshot.loopMode = savedLoop;
      }
      const savedMute = localStorage.getItem('player_is_muted');
      if (savedMute !== null) {
        currentSnapshot.isMuted = savedMute === 'true';
      }
    }
  } catch {}

  function refreshAudioSettings() {
    if (!audioSettingsStore?.getState) return;
    try {
      const state = audioSettingsStore.getState();
      if (typeof state?.volume === 'number') {
        currentSnapshot.volume = Math.round(state.volume * 100);
      }
      if (typeof state?.isMuted === 'boolean') {
        currentSnapshot.isMuted = state.isMuted;
      }
      if (state?.loopMode) {
        if (!(currentSnapshot.loopMode === 'shuffle' && state.loopMode === 'all')) {
          currentSnapshot.loopMode = state.loopMode;
        }
      }
    } catch {
      // Ignored
    }
  }

  function getAudioSettings() {
    if (audioSettingsStore) return Promise.resolve(audioSettingsStore);
    if (!audioSettingsInitPromise) {
      audioSettingsInitPromise = resolveAudioSettingsStore().then((store) => {
        if (store) {
          audioSettingsStore = store;
          refreshAudioSettings();
          void pushSnapshot({
            volume: currentSnapshot.volume,
            isMuted: currentSnapshot.isMuted,
            loopMode: currentSnapshot.loopMode,
          });

          if (store.subscribe) {
            const unsub = store.subscribe((state) => {
              if (!state) return;
              const vol = typeof state.volume === 'number' ? Math.round(state.volume * 100) : currentSnapshot.volume;
              const muted = typeof state.isMuted === 'boolean' ? state.isMuted : currentSnapshot.isMuted;
              let mode = state.loopMode || currentSnapshot.loopMode;
              if (currentSnapshot.loopMode === 'shuffle' && state.loopMode === 'all') {
                mode = 'shuffle';
              }
              if (vol !== currentSnapshot.volume || muted !== currentSnapshot.isMuted || mode !== currentSnapshot.loopMode) {
                currentSnapshot.volume = vol;
                currentSnapshot.isMuted = muted;
                currentSnapshot.loopMode = mode;
                void pushSnapshot({
                  volume: vol,
                  isMuted: muted,
                  loopMode: mode,
                });
              }
            });
            unsubs.push(unsub);
          }
        }
        return store;
      });
    }
    return audioSettingsInitPromise;
  }

  // Kick off resolution immediately
  void getAudioSettings();

  // Direct subscription to Zustand playback store for instant queue and offset synchronization
  try {
    const pStore = folium.internals?.stores?.playback;
    if (pStore?.subscribe) {
      const unsubStore = pStore.subscribe((state) => {
        refreshQueue();
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
  refreshAudioSettings();
  refreshPlaybackState();
  refreshQueue();
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
                let handled = false;
                try {
                  const aStore = await getAudioSettings();
                  if (aStore?.getState) {
                    const st = aStore.getState();
                    if (typeof st.handleSetVolume === 'function') {
                      st.handleSetVolume(ratio);
                      handled = true;
                    } else if (typeof aStore.setState === 'function') {
                      aStore.setState({ volume: ratio });
                      if (typeof localStorage !== 'undefined') {
                        localStorage.setItem('player_volume', String(ratio));
                      }
                      handled = true;
                    }
                    if (st.isMuted && typeof st.handleToggleMute === 'function') {
                      st.handleToggleMute();
                    }
                  }
                } catch {
                  // Ignored
                }
                currentSnapshot.volume = Math.round(ratio * 100);
                void pushSnapshot({ volume: currentSnapshot.volume });
                if (!handled) {
                  folium.ui.openVolume();
                }
              }
              break;
            case 'toggleMute': {
              let handled = false;
              try {
                const aStore = await getAudioSettings();
                if (aStore?.getState) {
                  const st = aStore.getState();
                  if (typeof st.handleToggleMute === 'function') {
                    st.handleToggleMute();
                    handled = true;
                  } else if (typeof aStore.setState === 'function') {
                    const next = !st.isMuted;
                    aStore.setState({ isMuted: next });
                    if (typeof localStorage !== 'undefined') {
                      localStorage.setItem('player_is_muted', String(next));
                    }
                    handled = true;
                  }
                }
              } catch {
                // Ignored
              }
              if (!handled) {
                currentSnapshot.isMuted = !currentSnapshot.isMuted;
                void pushSnapshot({ isMuted: currentSnapshot.isMuted });
                folium.ui.openVolume();
              }
              break;
            }
            case 'toggleLoopMode': {
              const current = currentSnapshot.loopMode || 'all';
              let nextMode = 'all';
              if (current === 'all') {
                nextMode = 'shuffle';
              } else if (current === 'shuffle') {
                nextMode = 'one';
              } else if (current === 'one') {
                nextMode = 'off';
              } else {
                nextMode = 'all';
              }

              currentSnapshot.loopMode = nextMode;
              void pushSnapshot({ loopMode: nextMode });

              try {
                if (nextMode === 'shuffle') {
                  folium.playback.shuffleQueue();
                  const aStore = await getAudioSettings();
                  if (typeof aStore?.setState === 'function') {
                    aStore.setState({ loopMode: 'all' });
                  }
                  if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('player_loop_mode', 'all');
                  }
                } else {
                  const aStore = await getAudioSettings();
                  if (typeof aStore?.setState === 'function') {
                    aStore.setState({ loopMode: nextMode });
                  }
                  if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('player_loop_mode', nextMode);
                  }
                }
              } catch (err) {
                folium.log.warn('Failed to apply loop mode change', err);
              }
              break;
            }
            case 'playQueueIndex':
              if (typeof item.payload === 'number') {
                try {
                  const pStore = folium.internals?.stores?.playback?.getState?.();
                  const queue = pStore?.playQueue || [];
                  const targetSong = queue[item.payload];
                  let played = false;
                  if (targetSong) {
                    try {
                      if (typeof folium.internals?.toFoliumSong === 'function') {
                        const fSong = folium.internals.toFoliumSong(targetSong);
                        if (fSong) {
                          await folium.playback.playSong(fSong);
                          played = true;
                        }
                      }
                    } catch {
                      // Ignored
                    }
                  }
                  if (!played) {
                    const currentSong = pStore?.currentSong;
                    const currentIdx = queue.findIndex(s => s && currentSong && (s.id === currentSong.id || s === currentSong));
                    if (currentIdx !== -1) {
                      const diff = item.payload - currentIdx;
                      if (diff > 0) {
                        for (let i = 0; i < diff; i++) folium.playback.next();
                      } else if (diff < 0) {
                        for (let i = 0; i < Math.abs(diff); i++) folium.playback.previous();
                      }
                    }
                  }
                } catch {
                  // Ignored
                }
              }
              break;
          }
        }
      }
    } catch {
      // Ignored
    }
  }, 160);

  // Return Disposer
  return () => {
    clearInterval(actionPollTimer);
    unsubs.forEach((unsub) => {
      try { unsub(); } catch { /* ignore */ }
    });
  };
}
