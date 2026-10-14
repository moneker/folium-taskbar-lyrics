// mods/taskbar-lyrics/client.mjs
// Renderer ESM entry for the Taskbar Lyrics Drawer mod.
// Listens to Folia playback and lyric events, synchronizes snapshots with the main process,
// dispatches user playback controls, and registers command palette actions and mod settings.

// Client coordinator for taskbar lyrics mod
export default function activate(folium) {
  folium.log.info(`Taskbar Lyrics Drawer client activating for mod ${folium.modId}`);

  let currentSnapshot = {
    song: null,
    playerState: 'paused',
    currentTime: 0,
    duration: 0,
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

  /**
   * Resolves the album cover artwork URL using Folia internals, playback state, or DOM fallback.
   * @returns {string|null} Cover artwork URL or null.
   */
  function resolveCurrentCoverUrl() {
    try {
      const pState = folium.internals?.stores?.playback?.getState?.();
      if (pState) {
        if (typeof pState.cachedCoverUrl === 'string' && pState.cachedCoverUrl) {
          return pState.cachedCoverUrl;
        }
        if (typeof pState.transitionDisplay?.coverUrl === 'string' && pState.transitionDisplay.coverUrl) {
          return pState.transitionDisplay.coverUrl;
        }
        if (typeof pState.currentSong?.album?.coverUrl === 'string' && pState.currentSong.album.coverUrl) {
          return pState.currentSong.album.coverUrl;
        }
        if (typeof pState.currentSong?.coverUrl === 'string' && pState.currentSong.coverUrl) {
          return pState.currentSong.coverUrl;
        }
        if (typeof pState.currentSong?.picUrl === 'string' && pState.currentSong.picUrl) {
          return pState.currentSong.picUrl;
        }
        if (typeof pState.currentSong?.album?.picUrl === 'string' && pState.currentSong.album.picUrl) {
          return pState.currentSong.album.picUrl;
        }
        if (typeof pState.currentSong?.onlineMetadata?.coverUrl === 'string' && pState.currentSong.onlineMetadata.coverUrl) {
          return pState.currentSong.onlineMetadata.coverUrl;
        }
      }
    } catch {
      // Ignored
    }

    try {
      const coverEl = document.querySelector(
        'img[alt*="Cover"], img[alt*="封面"], img[src*="cover"], .player-cover img, img[src*="music.126.net"], img[src*="kugou"], img[src*="gtimg"]'
      );
      if (coverEl && coverEl.src) {
        return coverEl.src;
      }
    } catch {
      // Ignored
    }
    return null;
  }

  // Push latest snapshot to main process window
  async function pushSnapshot() {
    try {
      await folium.rpc.call('syncSnapshot', currentSnapshot);
    } catch {
      // Ignored if main process is busy or reloaded
    }
  }

  // Synchronize play queue and audio settings (volume, mute, loopMode)
  function refreshQueueAndAudioState() {
    try {
      const pState = folium.internals?.stores?.playback?.getState?.();
      const aState = folium.internals?.stores?.audioSettings?.getState?.();

      if (pState) {
        const currentSong = pState.currentSong;
        currentSnapshot.queue = (pState.playQueue || []).map((s, idx) => ({
          index: idx,
          title: s.name || s.title || '未知曲目',
          artist: (s.artists || []).map((a) => a?.name).filter(Boolean).join(' / ') || s.artist || '未知艺人',
          active: currentSong ? (s.id === currentSong.id || s === currentSong) : false,
        }));
      }

      if (aState) {
        currentSnapshot.loopMode = aState.loopMode || 'all';
        currentSnapshot.volume = Math.round((aState.volume ?? 1) * 100);
        currentSnapshot.isMuted = Boolean(aState.isMuted);
      } else {
        // Fallback to reading localStorage in packaged Folia releases where audioSettings is not on internals
        try {
          const savedVol = localStorage.getItem('player_volume');
          const parsedVol = savedVol !== null ? parseFloat(savedVol) : 1;
          currentSnapshot.volume = Math.round((Number.isFinite(parsedVol) ? parsedVol : 1) * 100);

          const savedLoop = localStorage.getItem('player_loop_mode');
          currentSnapshot.loopMode = savedLoop === 'all' || savedLoop === 'one' ? savedLoop : 'off';

          currentSnapshot.isMuted = localStorage.getItem('player_is_muted') === 'true';
        } catch {
          // Ignored
        }
      }
    } catch {
      // Ignored
    }
  }

  /**
   * Resolves ground-truth audio playback position, duration, and playing state
   * from Folium playback API, Zustand playback store, and active DOM <audio> elements.
   */
  function resolveLiveAudioMetrics() {
    let position = 0;
    let duration = 0;
    let playerState = currentSnapshot.playerState || 'paused';

    // 1. Folium playback service
    try {
      const state = folium.playback.getState();
      if (state) {
        if (typeof state.position === 'number' && Number.isFinite(state.position)) {
          position = state.position;
        }
        if (typeof state.duration === 'number' && Number.isFinite(state.duration) && state.duration > 0) {
          duration = state.duration;
        }
        if (state.state) {
          playerState = state.state;
        }
      }
    } catch {
      // Ignored
    }

    // 2. Zustand playback store
    try {
      const pStore = folium.internals?.stores?.playback?.getState?.();
      if (pStore) {
        if ((!duration || duration <= 0) && typeof pStore.duration === 'number' && pStore.duration > 0) {
          duration = pStore.duration;
        }
        if (pStore.playerState) {
          playerState = pStore.playerState === 'playing' || pStore.playerState === 1 ? 'playing' : 'paused';
        }
      }
    } catch {
      // Ignored
    }

    // 3. Live HTMLAudioElement instances (direct browser media pipeline ground truth)
    try {
      const audios = Array.from(document.querySelectorAll('audio'));
      const activeAudio = audios.find((a) => !a.paused && a.currentTime > 0) || audios[0];
      if (activeAudio) {
        if ((!duration || duration <= 0) && Number.isFinite(activeAudio.duration) && activeAudio.duration > 0) {
          duration = activeAudio.duration;
        }
        if (Number.isFinite(activeAudio.currentTime) && activeAudio.currentTime >= 0) {
          if (!position || Math.abs(activeAudio.currentTime - position) > 1) {
            position = activeAudio.currentTime;
          }
        }
        if (!activeAudio.paused && !activeAudio.ended) {
          playerState = 'playing';
        }
      }
    } catch {
      // Ignored
    }

    return { position, duration, playerState };
  }

  // Update snapshot from folium.playback.getState(), internals, and live audio elements
  function refreshPlaybackState() {
    try {
      const state = folium.playback.getState();
      const live = resolveLiveAudioMetrics();
      const coverUrl = resolveCurrentCoverUrl();
      currentSnapshot.song = state.song ? {
        title: state.song.title,
        artist: state.song.artists ? state.song.artists.join(' / ') : state.song.artist,
        album: state.song.album,
        coverUrl: coverUrl,
      } : null;
      currentSnapshot.playerState = live.playerState;
      currentSnapshot.currentTime = live.position || (typeof state.position === 'number' ? state.position : 0);
      currentSnapshot.duration = live.duration || (typeof state.duration === 'number' ? state.duration : 0);
      currentSnapshot.updatedAt = Date.now();
      refreshQueueAndAudioState();
    } catch {
      // Ignored
    }
  }

  const CJK_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;

  function isCJK(str) {
    return CJK_REGEX.test(str);
  }

  function isLatinOrDigit(str) {
    return /[a-zA-Z0-9]/.test(str);
  }

  /**
   * Reconstructs natural word spacing for Latin / mixed lyric words.
   * Solves the issue where word-by-word lyrics omit spaces between tokens (e.g. "ilikeyou" -> "i like you").
   */
  function buildSpacedWordsAndText(words, rawFullText) {
    if (!Array.isArray(words) || words.length === 0) {
      return {
        text: rawFullText || '',
        words: null,
      };
    }

    const spacedWords = [];
    let reconstructedText = '';

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const text = w.text || '';
      let spaceBefore = false;

      if (i > 0) {
        const prevW = words[i - 1];
        const prevText = prevW.text || '';
        const hasExistingSpace = /\s$/.test(prevText) || /^\s/.test(text);

        if (!hasExistingSpace) {
          const prevLastChar = prevText.slice(-1);
          const currFirstChar = text.charAt(0);

          // Never insert space before apostrophe, hyphen, or closing punctuation
          const isPunctuationCling = /^['’\-–—.,!?:;)\]}]/.test(text);
          const isPrevPunctuationCling = /['’\-–—(\[{]$/.test(prevText);

          if (!isPunctuationCling && !isPrevPunctuationCling) {
            if (isLatinOrDigit(prevLastChar) && isLatinOrDigit(currFirstChar)) {
              spaceBefore = true;
            } else if (isLatinOrDigit(prevLastChar) && isCJK(currFirstChar)) {
              spaceBefore = true;
            } else if (isCJK(prevLastChar) && isLatinOrDigit(currFirstChar)) {
              spaceBefore = true;
            } else if (/[,.!?:;]/.test(prevLastChar) && !isCJK(currFirstChar)) {
              spaceBefore = true;
            }
          }
        }
      }

      if (spaceBefore) {
        reconstructedText += ' ';
      }
      reconstructedText += text;

      spacedWords.push({
        text: (spaceBefore ? ' ' : '') + text,
        cleanText: text,
        hasPrecedingSpace: spaceBefore,
        startTime: w.startTime,
        endTime: w.endTime,
      });
    }

    // If rawFullText already had proper spaces (e.g. from standard LRC), prefer rawFullText if it matches
    const joinedNoSpace = words.map((w) => w.text || '').join('');
    let finalText = reconstructedText;
    if (rawFullText && /\s/.test(rawFullText) && rawFullText.replace(/\s+/g, '') === joinedNoSpace.replace(/\s+/g, '')) {
      finalText = rawFullText;
    }

    return {
      text: finalText,
      words: spacedWords,
    };
  }

  // Helper to normalize lyrics and restore inter-word spacing
  function normalizeLyrics(rawLyrics) {
    if (!rawLyrics || !Array.isArray(rawLyrics.lines)) return null;
    return {
      lines: rawLyrics.lines.map((l) => {
        const rawText = l.fullText || l.text || '';
        const { text: formattedText, words: spacedWords } = buildSpacedWordsAndText(l.words, rawText);
        return {
          fullText: formattedText,
          translation: l.translation || '',
          startTime: l.startTime,
          endTime: l.endTime,
          words: spacedWords,
        };
      }),
    };
  }

  // Register Command in Command Palette (Ctrl+K)
  folium.registries.commands.register({
    id: 'toggle-taskbar-drawer',
    label: {
      'zh-CN': '切换任务栏歌词抽屉',
      en: 'Toggle taskbar lyrics drawer',
    },
    description: {
      'zh-CN': '从右侧滑动展开或收起任务栏歌词覆盖抽屉',
      en: 'Expand or collapse the drawer replacing the Windows taskbar',
    },
    run: async () => {
      const result = await folium.rpc.call('toggleDrawer');
      return result ? '已展开任务栏歌词抽屉' : '已收起任务栏歌词抽屉';
    },
  });

  /**
   * Introspects Folia's active React component tree from the DOM to find live host actions
   * (playSong, onToggleLoop, onVolumeChange, toggleMute) when Folium internals stores are not directly exported.
   */
  function findHostPlaybackActions() {
    try {
      const root = document.getElementById('root') || document.body;
      if (!root) return null;
      const key = Object.keys(root).find(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
      if (!key) return null;

      let playSongFn = null;
      let toggleLoopFn = null;
      let setVolumeFn = null;
      let toggleMuteFn = null;

      const queue = [root[key]];
      let visited = 0;

      while (queue.length > 0 && visited < 3000) {
        const fiber = queue.shift();
        visited++;
        if (!fiber) continue;

        const props = fiber.memoizedProps;
        if (props && typeof props === 'object') {
          // 1. CommandPaletteContext
          if (props.context?.playback) {
            const pb = props.context.playback;
            if (!playSongFn && typeof pb.playSong === 'function') playSongFn = pb.playSong;
            if (!toggleLoopFn && typeof pb.toggleLoop === 'function') toggleLoopFn = pb.toggleLoop;
            if (!setVolumeFn && typeof pb.setVolume === 'function') setVolumeFn = pb.setVolume;
            if (!toggleMuteFn && typeof pb.toggleMute === 'function') toggleMuteFn = pb.toggleMute;
          }
          // 2. Direct playback/controls props
          if (props.playback) {
            const pb = props.playback;
            if (!playSongFn && typeof pb.playSong === 'function') playSongFn = pb.playSong;
            if (!toggleLoopFn && typeof pb.toggleLoop === 'function') toggleLoopFn = pb.toggleLoop;
            if (!setVolumeFn && typeof pb.setVolume === 'function') setVolumeFn = pb.setVolume;
            if (!toggleMuteFn && typeof pb.toggleMute === 'function') toggleMuteFn = pb.toggleMute;
          }
          if (props.controls?.playback) {
            const pb = props.controls.playback;
            if (!playSongFn && typeof pb.playSong === 'function') playSongFn = pb.playSong;
            if (!toggleLoopFn && typeof pb.toggleLoop === 'function') toggleLoopFn = pb.toggleLoop;
            if (!setVolumeFn && typeof pb.setVolume === 'function') setVolumeFn = pb.setVolume;
            if (!toggleMuteFn && typeof pb.toggleMute === 'function') toggleMuteFn = pb.toggleMute;
          }
          // 3. Panel/Floating model props
          if (props.model?.panelProps?.queue?.onPlaySong) {
            if (!playSongFn) playSongFn = props.model.panelProps.queue.onPlaySong;
          }
          if (props.model?.panelProps?.playback) {
            const pb = props.model.panelProps.playback;
            if (!setVolumeFn && typeof pb.onVolumeChange === 'function') setVolumeFn = pb.onVolumeChange;
            if (!toggleLoopFn && typeof pb.onToggleLoop === 'function') toggleLoopFn = pb.onToggleLoop;
          }
          if (props.model?.floatingControls?.onToggleLoop) {
            if (!toggleLoopFn) toggleLoopFn = props.model.floatingControls.onToggleLoop;
          }
          // 4. Individual callback props
          if (!playSongFn) {
            if (typeof props.onPlaySong === 'function') playSongFn = props.onPlaySong;
            else if (typeof props.playSong === 'function') playSongFn = props.playSong;
            else if (props.queue && typeof props.queue.onPlaySong === 'function') playSongFn = props.queue.onPlaySong;
            else if (props.host && typeof props.host.playQueueSong === 'function') playSongFn = (song) => props.host.playQueueSong(song);
          }
          if (!toggleLoopFn) {
            if (typeof props.onToggleLoop === 'function') toggleLoopFn = props.onToggleLoop;
            else if (typeof props.handleToggleLoopMode === 'function') toggleLoopFn = props.handleToggleLoopMode;
            else if (typeof props.toggleLoop === 'function') toggleLoopFn = props.toggleLoop;
          }
          if (!setVolumeFn) {
            if (typeof props.onVolumeChange === 'function') setVolumeFn = props.onVolumeChange;
            else if (typeof props.setVolume === 'function') setVolumeFn = props.setVolume;
            else if (typeof props.handleSetVolume === 'function') setVolumeFn = props.handleSetVolume;
          }
          if (!toggleMuteFn) {
            if (typeof props.handleToggleMute === 'function') toggleMuteFn = props.handleToggleMute;
            else if (typeof props.toggleMute === 'function') toggleMuteFn = props.toggleMute;
          }
        }

        if (playSongFn && toggleLoopFn && setVolumeFn && toggleMuteFn) break;

        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }

      return { playSongFn, toggleLoopFn, setVolumeFn, toggleMuteFn };
    } catch {
      return null;
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

  if (settingsSection?.params?.subscribe) {
    settingsSection.params.subscribe((values) => {
      try {
        currentSnapshot.settings = {
          showTranslation: values && typeof values.showTranslation === 'boolean' ? values.showTranslation : true,
          useCoverBackground: values && typeof values.useCoverBackground === 'boolean' ? values.useCoverBackground : true,
        };
        void pushSnapshot();
      } catch {
        // Ignored
      }
    });
  }

  // Listen for Folia Event Bus
  const unsubs = [];

  unsubs.push(folium.events.on('playback.songChanged', (event) => {
    refreshPlaybackState();
    if (event.song) {
      currentSnapshot.song = {
        title: event.song.title,
        artist: event.song.artists ? event.song.artists.join(' / ') : event.song.artist,
        album: event.song.album,
        coverUrl: resolveCurrentCoverUrl(),
      };
    } else {
      currentSnapshot.song = null;
    }
    void pushSnapshot();

    // Re-check cover after 200ms and 600ms in case cover is asynchronously cached or downloaded
    setTimeout(() => {
      const nextCover = resolveCurrentCoverUrl();
      if (nextCover && currentSnapshot.song && currentSnapshot.song.coverUrl !== nextCover) {
        currentSnapshot.song.coverUrl = nextCover;
        void pushSnapshot();
      }
    }, 200);

    setTimeout(() => {
      const nextCover = resolveCurrentCoverUrl();
      if (nextCover && currentSnapshot.song && currentSnapshot.song.coverUrl !== nextCover) {
        currentSnapshot.song.coverUrl = nextCover;
        void pushSnapshot();
      }
    }, 600);
  }));

  unsubs.push(folium.events.on('playback.stateChanged', (event) => {
    refreshPlaybackState();
    currentSnapshot.playerState = event.state;
    void pushSnapshot();
  }));

  unsubs.push(folium.events.on('playback.seeked', (event) => {
    currentSnapshot.currentTime = event.position || 0;
    currentSnapshot.updatedAt = Date.now();
    void pushSnapshot();
  }));

  unsubs.push(folium.events.on('lyrics.loaded', (event) => {
    currentSnapshot.lyrics = normalizeLyrics(event);
    void pushSnapshot();
  }));

  unsubs.push(folium.events.on('theme.changed', () => {
    const nextCover = resolveCurrentCoverUrl();
    if (nextCover && currentSnapshot.song && currentSnapshot.song.coverUrl !== nextCover) {
      currentSnapshot.song.coverUrl = nextCover;
      void pushSnapshot();
    }
  }));

  // Direct subscription to Zustand playback store for instant cover, lyrics, and queue updates
  try {
    const pStore = folium.internals?.stores?.playback;
    if (pStore?.subscribe) {
      const unsubStore = pStore.subscribe((state) => {
        refreshQueueAndAudioState();
        const cover = state.transitionDisplay?.coverUrl
          || state.cachedCoverUrl
          || state.currentSong?.album?.coverUrl
          || state.currentSong?.coverUrl
          || state.currentSong?.picUrl
          || null;
        if (cover && currentSnapshot.song && currentSnapshot.song.coverUrl !== cover) {
          currentSnapshot.song.coverUrl = cover;
        }
        void pushSnapshot();
      });
      unsubs.push(unsubStore);
    }
  } catch {
    // Ignored
  }

  // Direct subscription to audio settings store for instant volume, mute, and loop mode updates
  try {
    const aStore = folium.internals?.stores?.audioSettings;
    if (aStore?.subscribe) {
      const unsubAudio = aStore.subscribe((state) => {
        let changed = false;
        const newVol = Math.round((state.volume ?? 1) * 100);
        if (currentSnapshot.volume !== newVol) {
          currentSnapshot.volume = newVol;
          changed = true;
        }
        if (currentSnapshot.isMuted !== Boolean(state.isMuted)) {
          currentSnapshot.isMuted = Boolean(state.isMuted);
          changed = true;
        }
        if (currentSnapshot.loopMode !== (state.loopMode || 'all')) {
          currentSnapshot.loopMode = state.loopMode || 'all';
          changed = true;
        }
        if (changed) {
          void pushSnapshot();
        }
      });
      unsubs.push(unsubAudio);
    }
  } catch {
    // Ignored
  }

  // Initial sync with fallback to already loaded lyrics and song
  try {
    const initialPlayback = folium.internals?.stores?.playback?.getState?.();
    if (initialPlayback?.lyrics) {
      currentSnapshot.lyrics = normalizeLyrics(initialPlayback.lyrics);
    }
  } catch {
    // Ignored
  }

  refreshPlaybackState();
  void pushSnapshot();

  // Periodic poll: sync playback position and drain user actions from taskbar window
  const actionPollTimer = setInterval(async () => {
    try {
      const live = resolveLiveAudioMetrics();
      let snapshotNeedsPush = false;

      if (live.duration > 0 && Math.abs(live.duration - (currentSnapshot.duration || 0)) > 0.5) {
        currentSnapshot.duration = live.duration;
        snapshotNeedsPush = true;
      }

      if (live.playerState && live.playerState !== currentSnapshot.playerState) {
        currentSnapshot.playerState = live.playerState;
        snapshotNeedsPush = true;
      }

      if (typeof live.position === 'number') {
        const delta = Math.abs(live.position - currentSnapshot.currentTime);
        if (live.playerState !== 'playing' ? delta > 0.05 : delta > 0.5) {
          currentSnapshot.currentTime = live.position;
          currentSnapshot.updatedAt = Date.now();
          snapshotNeedsPush = true;
        }
      }

      if (snapshotNeedsPush) {
        void pushSnapshot();
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
            case 'setVolume':
              if (typeof item.payload === 'number') {
                const volRatio = Math.max(0, Math.min(1, item.payload / 100));
                const aStore = folium.internals?.stores?.audioSettings?.getState?.();
                if (typeof aStore?.handleSetVolume === 'function') {
                  aStore.handleSetVolume(volRatio);
                }
                const liveActions = findHostPlaybackActions();
                if (typeof liveActions?.setVolumeFn === 'function') {
                  liveActions.setVolumeFn(volRatio);
                }
                try {
                  localStorage.setItem('player_volume', String(volRatio));
                  document.querySelectorAll('audio').forEach((a) => {
                    a.volume = volRatio;
                  });
                } catch {
                  // Ignored
                }
                currentSnapshot.volume = Math.round(volRatio * 100);
                void pushSnapshot();
              }
              break;
            case 'toggleMute':
              {
                const aStore = folium.internals?.stores?.audioSettings?.getState?.();
                if (typeof aStore?.handleToggleMute === 'function') {
                  aStore.handleToggleMute();
                }
                const liveActions = findHostPlaybackActions();
                if (typeof liveActions?.toggleMuteFn === 'function') {
                  liveActions.toggleMuteFn();
                }
                try {
                  const nextMuted = !currentSnapshot.isMuted;
                  localStorage.setItem('player_is_muted', String(nextMuted));
                  document.querySelectorAll('audio').forEach((a) => {
                    a.muted = nextMuted;
                  });
                  currentSnapshot.isMuted = nextMuted;
                  void pushSnapshot();
                } catch {
                  // Ignored
                }
              }
              break;
            case 'toggleLoopMode':
              {
                const aStore = folium.internals?.stores?.audioSettings?.getState?.();
                if (typeof aStore?.handleToggleLoopMode === 'function') {
                  aStore.handleToggleLoopMode();
                }
                const liveActions = findHostPlaybackActions();
                if (typeof liveActions?.toggleLoopFn === 'function') {
                  liveActions.toggleLoopFn();
                } else {
                  const currentMode = currentSnapshot.loopMode || 'all';
                  const nextMode = currentMode === 'off' ? 'all' : (currentMode === 'all' ? 'one' : 'off');
                  try {
                    localStorage.setItem('player_loop_mode', nextMode);
                  } catch {
                    // Ignored
                  }
                  currentSnapshot.loopMode = nextMode;
                  void pushSnapshot();
                }
              }
              break;
            case 'playQueueIndex':
              if (typeof item.payload === 'number') {
                const pStore = folium.internals?.stores?.playback?.getState?.();
                const queue = pStore?.playQueue || [];
                const targetSong = queue[item.payload];
                if (targetSong) {
                  let played = false;
                  const liveActions = findHostPlaybackActions();
                  if (typeof liveActions?.playSongFn === 'function') {
                    try {
                      liveActions.playSongFn(targetSong, queue);
                      played = true;
                    } catch {
                      // Ignored
                    }
                  }
                  if (!played && folium.internals?.toFoliumSong) {
                    try {
                      const foliumSong = folium.internals.toFoliumSong(targetSong);
                      if (foliumSong) {
                        void folium.playback.playSong(foliumSong);
                        played = true;
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
