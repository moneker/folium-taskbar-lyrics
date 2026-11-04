// mods/taskbar-lyrics/view/taskbar.js
// Client logic for taskbar lyrics drawer: monotonic clock interpolation, fluid karaoke wipe,
// hover-hide coordination, cover rendering, and low-overhead render loop.

(function () {
  'use strict';

  const bridge = window.taskbarBridge;
  if (!bridge) {
    console.error('TaskbarBridge not available in view');
    return;
  }

  // DOM Elements
  const appRoot = document.getElementById('appRoot');
  const toggleBtn = document.getElementById('toggleButton');
  const drawerPanel = document.getElementById('drawerPanel');
  const drawerCoverBg = document.getElementById('drawerCoverBg');
  const coverImg = document.getElementById('coverImg');
  const coverFallback = document.getElementById('coverFallback');
  const songTitle = document.getElementById('songTitle');
  const songArtist = document.getElementById('songArtist');
  const lyricsStage = document.querySelector('.lyrics-stage-section');
  const lyricMain = document.getElementById('lyricMain');
  const lyricSub = document.getElementById('lyricSub');
  const timeCurrent = document.getElementById('timeCurrent');
  const timeDuration = document.getElementById('timeDuration');
  const progressBar = document.getElementById('progressBar');
  const progressFill = document.getElementById('progressFill');
  const progressThumb = document.getElementById('progressThumb');
  const prevBtn = document.getElementById('prevBtn');
  const playPauseBtn = document.getElementById('playPauseBtn');
  const nextBtn = document.getElementById('nextBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');
  const menuBtn = document.getElementById('menuBtn');

  // Drawer & Hover State
  let isExpanded = false;
  let isAnimating = false;
  let isHoverHidden = false;
  let animationSafetyTimer = null;

  function setAnimating(val) {
    isAnimating = val;
    if (animationSafetyTimer) {
      clearTimeout(animationSafetyTimer);
      animationSafetyTimer = null;
    }
    if (val) {
      animationSafetyTimer = setTimeout(() => {
        isAnimating = false;
        syncRenderLoop();
      }, 420);
    }
    syncRenderLoop();
  }

  let snapshot = {
    song: null,
    playerState: 'paused',
    isAdvancing: false,
    currentTime: 0,
    duration: 0,
    updatedAt: Date.now(),
    lyrics: null,
    lyricOffsetMs: 0,
    settings: {
      interactionMode: 'standard',
      targetDisplay: 'primary',
      showTranslation: true,
      useCoverBackground: true,
    },
  };

  // Monotonic clock & deduplication state
  let lastRenderedAudioTime = 0;
  let clockRate = 1.0;
  let activeLineIndex = -999;
  let currentActiveLine = null;
  let lastWipeLineIndex = -999;
  let lastWipePct = 0;
  let lastWipeCssStr = '';
  let lastDisplayedSecond = -1;
  let lastProgressPctStr = '';
  let animationFrameId = null;

  function resetMonotonicTrackers(newTime = 0) {
    lastRenderedAudioTime = Math.max(0, newTime);
    clockRate = 1.0;
    activeLineIndex = -999;
    currentActiveLine = null;
    lastWipeLineIndex = -999;
    lastWipePct = 0;
  }

  function setWipeCssProperty(pctValue) {
    const str = `${pctValue.toFixed(1)}%`;
    if (str !== lastWipeCssStr) {
      lastWipeCssStr = str;
      lyricMain.style.setProperty('--wipe-pct', str);
    }
  }

  // Format seconds to mm:ss
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Get monotonic audio playback time (only extrapolates when actual audio hardware is advancing)
  function getRawAudioTime() {
    let t = snapshot.currentTime || 0;
    const advancing = snapshot.playerState === 'playing' && snapshot.isAdvancing !== false;
    if (advancing && snapshot.updatedAt) {
      const elapsed = Math.max(0, (Date.now() - snapshot.updatedAt) / 1000) * clockRate;
      t += elapsed;
      if (snapshot.duration > 0 && t > snapshot.duration) {
        t = snapshot.duration;
      }
    }
    if (advancing) {
      if (t < lastRenderedAudioTime && (lastRenderedAudioTime - t) < 1.5) {
        t = lastRenderedAudioTime;
      } else {
        lastRenderedAudioTime = t;
      }
    } else {
      lastRenderedAudioTime = t;
    }
    return Math.max(0, t);
  }

  // Get effective lyric timeline position (aligned with Folia's usePlaybackVisualizerBridge convention: time - offset)
  function getEffectiveLyricTime() {
    const raw = getRawAudioTime();
    const offsetSec = (snapshot.lyricOffsetMs || 0) / 1000;
    return Math.max(0, raw - offsetSec);
  }

  // Cover image event handlers
  coverImg.addEventListener('load', () => {
    coverImg.style.opacity = '1';
    if (coverFallback) coverFallback.style.display = 'none';
  });

  coverImg.addEventListener('error', () => {
    coverImg.style.opacity = '0';
    if (coverFallback) coverFallback.style.display = 'flex';
  });

  // =========================================================================
  // Dynamic Folia Theme Palette Derivation
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
      if (appRoot) appRoot.classList.add('daylight');
    } else {
      document.documentElement.classList.remove('daylight');
      document.body.classList.remove('daylight');
      if (appRoot) appRoot.classList.remove('daylight');
    }

    const rootStyle = document.documentElement.style;
    const bg = theme.backgroundColor || (isDaylight ? '#f5f5f4' : '#09090b');
    const primary = theme.primaryColor || (isDaylight ? '#1c1917' : '#f4f4f5');
    const secondary = theme.secondaryColor || (isDaylight ? '#44403c' : '#71717a');
    const accent = theme.accentColor || (isDaylight ? '#ea580c' : '#6366f1');

    rootStyle.setProperty('--bg-acrylic', colorWithAlpha(bg, isDaylight ? 0.95 : 0.94));
    rootStyle.setProperty('--bg-card', colorWithAlpha(primary, isDaylight ? 0.05 : 0.08));
    rootStyle.setProperty('--bg-card-hover', colorWithAlpha(primary, isDaylight ? 0.09 : 0.12));
    rootStyle.setProperty('--border-subtle', colorWithAlpha(primary, isDaylight ? 0.08 : 0.12));
    rootStyle.setProperty('--border-highlight', colorWithAlpha(primary, isDaylight ? 0.18 : 0.22));
    rootStyle.setProperty('--button-hover-bg', colorWithAlpha(primary, isDaylight ? 0.08 : 0.14));
    rootStyle.setProperty('--text-primary', primary);
    rootStyle.setProperty('--text-secondary', secondary);
    rootStyle.setProperty('--text-tertiary', colorWithAlpha(secondary, 0.75));
    rootStyle.setProperty('--lyric-inactive', colorWithAlpha(primary, isDaylight ? 0.32 : 0.38));
    rootStyle.setProperty('--accent-color', accent);
    rootStyle.setProperty('--accent-glow', colorWithAlpha(accent, 0.45));
    rootStyle.setProperty('--accent-gradient', `linear-gradient(135deg, ${accent}, ${colorWithAlpha(accent, 0.8)})`);

    if (theme.fontFamily) {
      rootStyle.setProperty('--app-font-family', theme.fontFamily);
    }
  }

  // Apply Drawer State with unidirectional Right-to-Left animation
  function setDrawerExpanded(expanded) {
    if (isExpanded === expanded) return;
    isExpanded = expanded;

    if (expanded) {
      // Enter from right to left (100% -> 0)
      appRoot.classList.remove('collapsed', 'exiting');
      appRoot.classList.add('expanded');
      renderSingleFrame();
    } else {
      // Exit continuing to left (0 -> -100%)
      appRoot.classList.remove('expanded');
      appRoot.classList.add('exiting');
    }
    syncRenderLoop();
  }

  // Drawer transitionend handler
  drawerPanel.addEventListener('transitionend', (e) => {
    if (e.target === drawerPanel && e.propertyName === 'transform') {
      setAnimating(false);
      if (appRoot.classList.contains('exiting')) {
        appRoot.classList.remove('exiting');
        appRoot.classList.add('collapsed');
        // Instantly reset drawer panel to right side without transition
        drawerPanel.style.transition = 'none';
        drawerPanel.style.transform = 'translateX(100%)';
        void drawerPanel.offsetHeight; // force reflow
        drawerPanel.style.transition = '';
        drawerPanel.style.transform = '';
        bridge.notifyAnimationComplete('collapsed');
      } else if (appRoot.classList.contains('expanded')) {
        bridge.notifyAnimationComplete('expanded');
      }
      syncRenderLoop();
    }
  });

  // Toggle button interaction (on far-left)
  let lastToggleTime = 0;
  function handleToggleTrigger(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const now = Date.now();
    if (now - lastToggleTime < 320) return;
    lastToggleTime = now;
    setAnimating(true);
    bridge.toggleDrawer();
  }

  // Hover-hide & Topmost pointer handlers
  function handlePointerEnterOrMove() {
    if (snapshot.settings?.interactionMode === 'hover-hide') {
      if (!isHoverHidden && typeof bridge.notifyHoverEnter === 'function') {
        bridge.notifyHoverEnter();
      }
      return;
    }
    bridge.assertTop();
  }

  appRoot.addEventListener('pointerdown', () => {
    if (snapshot.settings?.interactionMode === 'hover-hide') {
      if (typeof bridge.notifyHoverEnter === 'function') bridge.notifyHoverEnter();
      return;
    }
    bridge.assertTop();
  });
  appRoot.addEventListener('pointerenter', handlePointerEnterOrMove);
  appRoot.addEventListener('mousemove', () => {
    if (snapshot.settings?.interactionMode === 'hover-hide' && !isHoverHidden) {
      if (typeof bridge.notifyHoverEnter === 'function') bridge.notifyHoverEnter();
    }
  });

  if (typeof bridge.onHoverHidden === 'function') {
    bridge.onHoverHidden((hidden) => {
      isHoverHidden = Boolean(hidden);
      appRoot.classList.toggle('hover-hidden', isHoverHidden);
      if (!isHoverHidden) {
        renderSingleFrame();
      }
      syncRenderLoop();
    });
  }

  toggleBtn.addEventListener('click', handleToggleTrigger);

  // Playback Control Buttons
  prevBtn.addEventListener('click', () => bridge.sendPlaybackAction('prev'));
  nextBtn.addEventListener('click', () => bridge.sendPlaybackAction('next'));
  playPauseBtn.addEventListener('click', () => bridge.sendPlaybackAction('toggle'));

  // Menu button click
  if (menuBtn) {
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.toggleMenu();
    });
  }

  // Interactive Progress Bar Dragging & Seeking
  let isDraggingProgress = false;
  let seekCooldownUntil = 0;

  function updateSeekDisplay(ratio) {
    if (!snapshot.duration || snapshot.duration <= 0) return 0;
    const clampedRatio = Math.max(0, Math.min(1, ratio));
    const targetTime = clampedRatio * snapshot.duration;
    const pct = (clampedRatio * 100).toFixed(1);
    progressFill.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
    lastProgressPctStr = pct;
    const sec = Math.floor(targetTime);
    if (sec !== lastDisplayedSecond) {
      lastDisplayedSecond = sec;
      timeCurrent.textContent = formatTime(targetTime);
    }
    if (isDraggingProgress) {
      const effectivePreviewTime = Math.max(0, targetTime - (snapshot.lyricOffsetMs || 0) / 1000);
      updateLyrics(effectivePreviewTime, true);
    }
    return targetTime;
  }

  function getRatioFromEvent(e) {
    const rect = progressBar.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  progressBar.addEventListener('pointerdown', (e) => {
    if (!snapshot.duration || snapshot.duration <= 0) return;
    e.preventDefault();
    isDraggingProgress = true;
    try { progressBar.setPointerCapture(e.pointerId); } catch {}
    const ratio = getRatioFromEvent(e);
    updateSeekDisplay(ratio);
  });

  progressBar.addEventListener('pointermove', (e) => {
    if (!isDraggingProgress) return;
    e.preventDefault();
    const ratio = getRatioFromEvent(e);
    updateSeekDisplay(ratio);
  });

  const finishSeek = (e) => {
    if (!isDraggingProgress) return;
    isDraggingProgress = false;
    try { progressBar.releasePointerCapture(e.pointerId); } catch {}
    const ratio = getRatioFromEvent(e);
    const targetTime = updateSeekDisplay(ratio);

    // Apply immediate local state update and hold clock extrapolation until audio decoder settles
    const now = Date.now();
    snapshot.currentTime = targetTime;
    snapshot.updatedAt = now;
    snapshot.isAdvancing = false;
    seekCooldownUntil = now + 900;
    resetMonotonicTrackers(targetTime);

    // Send action to Folia engine
    bridge.sendPlaybackAction('seek', targetTime);

    // Immediately sync lyrics to seek position
    updateLyrics(getEffectiveLyricTime(), true);
    syncRenderLoop();
  };

  progressBar.addEventListener('pointerup', finishSeek);
  progressBar.addEventListener('pointercancel', finishSeek);

  // Receive Drawer State from Main Process
  bridge.onDrawerState((state) => {
    setAnimating(false);
    setDrawerExpanded(state === 'expanded');
  });

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

    // If rawFullText already had proper spaces, prefer rawFullText if it matches
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

  // Receive Snapshot from Main Process
  let lastSongTitle = '';
  let lastSongArtist = '';
  let lastCoverBgSrc = '';

  bridge.onSnapshot((data) => {
    if (!data) return;

    if (data.theme) {
      applyTheme(data.theme);
    }

    const currentTitle = data.song !== undefined ? (data.song?.title || '') : lastSongTitle;
    const currentArtist = data.song !== undefined ? (data.song?.artist || '') : lastSongArtist;
    const isSongChanged = Boolean(data.song && (currentTitle !== lastSongTitle || currentArtist !== lastSongArtist));
    const isLyricsLoaded = Boolean(data.lyrics !== undefined && data.lyrics !== snapshot.lyrics);

    if (isSongChanged) {
      lastSongTitle = currentTitle;
      lastSongArtist = currentArtist;
      resetMonotonicTrackers(typeof data.currentTime === 'number' ? data.currentTime : 0);
    } else if (isLyricsLoaded) {
      activeLineIndex = -999;
      currentActiveLine = null;
      lastWipeLineIndex = -999;
      lastWipePct = 0;
    }

    let nextLyrics = snapshot.lyrics;
    if (data.lyrics !== undefined) {
      if (data.lyrics && Array.isArray(data.lyrics.lines)) {
        nextLyrics = {
          ...data.lyrics,
          lines: data.lyrics.lines.map((l) => {
            const rawText = l.fullText || l.text || '';
            const { text: formattedText, words: spacedWords } = buildSpacedWordsAndText(l.words, rawText);
            return {
              ...l,
              fullText: formattedText,
              words: spacedWords,
            };
          }),
        };
      } else {
        nextLyrics = null;
      }
      activeLineIndex = -999;
      currentActiveLine = null;
      lastWipeLineIndex = -999;
      lastWipePct = 0;
    }

    const now = Date.now();
    const nextState = data.playerState !== undefined ? data.playerState : snapshot.playerState;
    let nextAdvancing = data.isAdvancing !== undefined ? Boolean(data.isAdvancing) : snapshot.isAdvancing;
    if (nextState !== 'playing') {
      nextAdvancing = false;
    }
    if (isSongChanged && data.isAdvancing === undefined) {
      nextAdvancing = false;
    }

    let nextCurrentTime = snapshot.currentTime;
    let nextUpdatedAt = snapshot.updatedAt;
    let isDiscontinuous = isSongChanged || Boolean(data.isSeek);

    if (isDraggingProgress && !isSongChanged) {
      // Do not overwrite user drag preview with incoming background ticks
    } else if (typeof data.currentTime === 'number' && Number.isFinite(data.currentTime)) {
      // Guard seek cooldown against stale position echo from audio decoder right after user drags slider
      const inSeekCooldown = seekCooldownUntil > now && !data.isSeek && !isSongChanged;
      if (inSeekCooldown && Math.abs(data.currentTime - snapshot.currentTime) > 1.2) {
        // Ignore stale pre-seek echo and keep holding clock until decoder catches up
        nextAdvancing = false;
      } else {
        if (inSeekCooldown && nextAdvancing) {
          seekCooldownUntil = 0;
        }
        const incomingStamp = data.updatedAt || now;
        const incomingElapsed = (nextState === 'playing' && nextAdvancing)
          ? Math.max(0, (now - incomingStamp) / 1000)
          : 0;
        const incomingLiveTime = data.currentTime + incomingElapsed;
        const timeDelta = incomingLiveTime - lastRenderedAudioTime;

        if (isDiscontinuous || Math.abs(timeDelta) >= 1.5) {
          // Intentional seek, song change, or large correction (>1.5s)
          nextCurrentTime = data.currentTime;
          nextUpdatedAt = incomingStamp;
          resetMonotonicTrackers(incomingLiveTime);
          isDiscontinuous = true;
        } else if (nextState !== 'playing' || !nextAdvancing) {
          // Paused or audio is loading/buffering/seeking: hold clock without resetting activeLineIndex
          nextCurrentTime = timeDelta >= 0 ? data.currentTime : lastRenderedAudioTime;
          nextUpdatedAt = now;
          lastRenderedAudioTime = nextCurrentTime;
          clockRate = 1.0;
        } else if (timeDelta >= 0) {
          // Incoming clock is ahead or aligned: advance smoothly at 1.0x
          nextCurrentTime = data.currentTime;
          nextUpdatedAt = incomingStamp;
          lastRenderedAudioTime = incomingLiveTime;
          clockRate = 1.0;
        } else {
          // Incoming snapshot is slightly behind local extrapolation (-1.5s < timeDelta < 0) due to
          // background timer throttling, memory pressure, or IPC delay.
          // Pin to lastRenderedAudioTime so the lyric wipe and line never bounce backward, and
          // gently slow clockRate until the real audio clock catches up.
          nextCurrentTime = lastRenderedAudioTime;
          nextUpdatedAt = now;
          clockRate = timeDelta < -0.2 ? 0.65 : (timeDelta < -0.05 ? 0.85 : 1.0);
        }
      }
    } else if (
      (data.playerState !== undefined && data.playerState !== snapshot.playerState) ||
      (data.isAdvancing !== undefined && Boolean(data.isAdvancing) !== snapshot.isAdvancing)
    ) {
      // State or advancing flag changed without explicit currentTime: freeze or resume from current position
      nextCurrentTime = lastRenderedAudioTime;
      nextUpdatedAt = now;
      clockRate = 1.0;
    }

    if (data.song !== undefined) snapshot.song = data.song;
    if (data.playerState !== undefined) snapshot.playerState = nextState;
    snapshot.isAdvancing = nextAdvancing;
    if (data.duration !== undefined) snapshot.duration = data.duration;
    if (data.lyricOffsetMs !== undefined) snapshot.lyricOffsetMs = data.lyricOffsetMs;
    snapshot.currentTime = nextCurrentTime;
    snapshot.updatedAt = nextUpdatedAt;
    snapshot.lyrics = nextLyrics;

    if (data.settings) {
      snapshot.settings = {
        ...snapshot.settings,
        ...data.settings,
      };
      const isHoverMode = snapshot.settings.interactionMode === 'hover-hide';
      appRoot.classList.toggle('hover-hide-mode', isHoverMode);
    }

    if (data.song !== undefined || data.duration !== undefined || data.lyrics !== undefined || data.settings !== undefined) {
      updateMetadata();
    }
    if (data.playerState !== undefined) {
      updatePlayerState();
    }

    renderSingleFrame(isDiscontinuous);
    syncRenderLoop();
  });

  // Update Metadata (Song Title, Artist, Cover)
  function updateMetadata() {
    const song = snapshot.song;
    if (song) {
      songTitle.textContent = song.title || '未知曲目';
      songArtist.textContent = song.artist || 'Folia';
      if (song.coverUrl) {
        if (coverImg.getAttribute('data-src') !== song.coverUrl) {
          coverImg.setAttribute('data-src', song.coverUrl);
          coverImg.src = song.coverUrl;
        }
      } else {
        coverImg.removeAttribute('data-src');
        coverImg.src = '';
        coverImg.style.opacity = '0';
        if (coverFallback) coverFallback.style.display = 'flex';
      }

      // If lyrics are not present yet, immediately display song info in center stage
      if (!snapshot.lyrics || !Array.isArray(snapshot.lyrics.lines) || snapshot.lyrics.lines.length === 0) {
        if (song.title) {
          lyricMain.textContent = song.title;
          lyricSub.textContent = song.artist || '';
          if (lyricsStage) {
            if (song.artist) lyricsStage.classList.remove('single-row');
            else lyricsStage.classList.add('single-row');
          }
        } else {
          lyricMain.textContent = '♪ 享受纯净旋律 ♪';
          lyricSub.textContent = '';
          if (lyricsStage) lyricsStage.classList.add('single-row');
        }
        setWipeCssProperty(100);
      }
    } else {
      songTitle.textContent = '等待播放';
      songArtist.textContent = 'Folia';
      coverImg.removeAttribute('data-src');
      coverImg.src = '';
      coverImg.style.opacity = '0';
      if (coverFallback) coverFallback.style.display = 'flex';
      lyricMain.textContent = '♪ 享受纯净旋律 ♪';
      setWipeCssProperty(100);
      lyricSub.textContent = '';
    }

    // Folia-style blurred fluid cover background (load directly into drawerCoverBg without extra Image instance)
    if (drawerCoverBg) {
      const useCoverBg = snapshot.settings?.useCoverBackground !== false;
      const targetCoverUrl = useCoverBg && song && song.coverUrl ? song.coverUrl : '';
      if (targetCoverUrl) {
        if (lastCoverBgSrc !== targetCoverUrl) {
          lastCoverBgSrc = targetCoverUrl;
          drawerCoverBg.onload = () => {
            drawerCoverBg.classList.add('loaded');
          };
          drawerCoverBg.onerror = () => {
            drawerCoverBg.classList.remove('loaded');
          };
          drawerCoverBg.src = targetCoverUrl;
        }
      } else if (lastCoverBgSrc !== '') {
        lastCoverBgSrc = '';
        drawerCoverBg.onload = null;
        drawerCoverBg.onerror = null;
        drawerCoverBg.classList.remove('loaded');
        drawerCoverBg.src = '';
      }
    }

    timeDuration.textContent = formatTime(snapshot.duration || 0);
  }

  // Update Play/Pause button icons & EQ state
  function updatePlayerState() {
    const isPlaying = snapshot.playerState === 'playing';
    if (isPlaying) {
      appRoot.classList.add('playing');
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    } else {
      appRoot.classList.remove('playing');
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
    }
  }

  // Reverse search matching Folia's findLatestActiveLineIndex with intelligent prelude and interlude detection
  function findLatestActiveLine(lines, time) {
    if (!Array.isArray(lines) || lines.length === 0) {
      return { index: -1, line: null, isInterlude: false };
    }

    // Prelude: before the first singing line starts
    const firstLine = lines[0];
    const firstStart = Number(firstLine?.startTime) || 0;
    if (time < firstStart) {
      return { index: -1, line: null, isInterlude: false };
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      const start = Number(line.startTime) || 0;
      if (time < start) continue;

      const nextLine = lines[i + 1];
      const nextStart = nextLine ? (Number(nextLine.startTime) || start + 4) : start + 4;
      const endTime = typeof line.endTime === 'number' && line.endTime > start
        ? line.endTime
        : nextStart;

      // Currently inside this line's singing window
      if (time <= endTime) {
        return { index: i, line, isInterlude: false };
      }

      // Between this line and the next line
      if (nextLine) {
        const gap = nextStart - endTime;
        // If there is a noticeable break (>= 2.0s) and we are past the line end by at least 0.8s
        if (gap >= 2.0 && (time - endTime) >= 0.8 && time < nextStart) {
          return { index: -1, line: null, isInterlude: true };
        }
        // Otherwise hold this line until next line starts
        if (time < nextStart) {
          return { index: i, line, isInterlude: false };
        }
      } else {
        // Outro: after the last line finishes
        if (time > endTime + 2.0) {
          return { index: -1, line: null, isInterlude: true };
        }
        return { index: i, line, isInterlude: false };
      }
    }

    return { index: -1, line: null, isInterlude: false };
  }

  // Update Karaoke Lyric Line
  function updateLyrics(time, allowBackward = false) {
    const lyrics = snapshot.lyrics;
    if (!lyrics || !Array.isArray(lyrics.lines) || lyrics.lines.length === 0) {
      if (activeLineIndex !== -1) {
        activeLineIndex = -1;
        currentActiveLine = null;
        lastWipeLineIndex = -1;
        lastWipePct = 0;
        lyricMain.textContent = snapshot.song?.title
          ? `${snapshot.song.title} - ${snapshot.song.artist || 'Folia'}`
          : '♪ 享受纯净旋律 ♪';
        setWipeCssProperty(0);
        lyricSub.textContent = '';
      }
      return;
    }

    const lines = lyrics.lines;
    let { index: currentIdx, line: matchLine, isInterlude } = findLatestActiveLine(lines, time);

    // Prevent accidental 1-line backward bounce during normal continuous playback
    if (!allowBackward && snapshot.playerState === 'playing' && activeLineIndex >= 0 && currentIdx >= 0 && currentIdx < activeLineIndex) {
      currentIdx = activeLineIndex;
      matchLine = currentActiveLine;
      isInterlude = false;
    }

    if (currentIdx !== activeLineIndex) {
      activeLineIndex = currentIdx;
      currentActiveLine = matchLine;
      lastWipeLineIndex = currentIdx;
      lastWipePct = 0;
      renderActiveLine(currentActiveLine, isInterlude);
    }

    // High frequency continuous fluid wipe progress
    updateContinuousLyricWipe(currentActiveLine, time, allowBackward);
  }

  // Render text for active line with clear hierarchy and micro-transition
  function renderActiveLine(line, isInterlude) {
    if (!line) {
      if (lyricsStage) lyricsStage.classList.add('single-row');
      const song = snapshot.song;
      if (isInterlude && (snapshot.currentTime || 0) > 3) {
        lyricMain.textContent = '♪ 间奏 ♪';
      } else if (song && song.title) {
        lyricMain.textContent = `${song.title} - ${song.artist || 'Folia'}`;
      } else {
        lyricMain.textContent = '♪ 享受纯净旋律 ♪';
      }
      setWipeCssProperty(0);
      lyricSub.textContent = '';
      return;
    }

    const showTrans = snapshot.settings?.showTranslation !== false;
    const hasTranslation = Boolean(showTrans && line.translation && line.translation.trim());

    if (hasTranslation) {
      if (lyricsStage) lyricsStage.classList.remove('single-row');
      lyricSub.textContent = line.translation.trim();
    } else {
      if (lyricsStage) lyricsStage.classList.add('single-row');
      lyricSub.textContent = '';
    }

    // Micro-dissolve transition on line advance
    lyricMain.classList.add('line-switching');
    lyricMain.textContent = line.fullText || line.text || '';
    setWipeCssProperty(0);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        lyricMain.classList.remove('line-switching');
      });
    });
  }

  /**
   * Calculates continuous sub-character progress for professional karaoke gradient sweep.
   * Enforces monotonic forward progress within the same active line unless seeking.
   * @param {object|null} line Active lyric line
   * @param {number} time Current playback timestamp in seconds
   * @param {boolean} allowBackward True when user just seeked
   */
  function updateContinuousLyricWipe(line, time, allowBackward = false) {
    if (!line) {
      setWipeCssProperty(0);
      return;
    }

    const start = Number(line.startTime) || 0;
    const end = Math.max(start + 0.1, Number(line.endTime) || (start + 4));

    let pct = 0;
    if (time <= start) {
      pct = 0;
    } else if (time >= end) {
      pct = 100;
    } else if (Array.isArray(line.words) && line.words.length > 0) {
      const fullTextLen = (line.fullText || line.text || '').length;
      const wordCharsSum = line.words.reduce((sum, w) => sum + (w.text ? w.text.length : 1), 0) || 1;
      const totalChars = Math.max(fullTextLen, wordCharsSum);
      let charsPassed = 0;

      for (let i = 0; i < line.words.length; i++) {
        const w = line.words[i];
        const wStart = Number(w.startTime) || 0;
        const wEnd = Math.max(wStart + 0.05, Number(w.endTime) || (wStart + 0.25));
        const wLen = w.text ? w.text.length : 1;

        if (time >= wEnd) {
          charsPassed += wLen;
        } else if (time >= wStart && time < wEnd) {
          const subProgress = Math.max(0, Math.min(1, (time - wStart) / (wEnd - wStart)));
          charsPassed += subProgress * wLen;
          break;
        } else {
          break;
        }
      }

      pct = Math.max(0, Math.min(100, (charsPassed / totalChars) * 100));
    } else {
      // Line-level fluid progress
      const fraction = Math.max(0, Math.min(1, (time - start) / (end - start)));
      pct = fraction * 100;
    }

    if (!allowBackward && activeLineIndex === lastWipeLineIndex) {
      pct = Math.max(lastWipePct, pct);
    }
    lastWipeLineIndex = activeLineIndex;
    lastWipePct = pct;

    setWipeCssProperty(pct);
  }

  function renderSingleFrame(allowBackward = false) {
    if (isDraggingProgress) {
      return;
    }
    const audioTime = getRawAudioTime();
    const sec = Math.floor(audioTime);
    if (sec !== lastDisplayedSecond) {
      lastDisplayedSecond = sec;
      timeCurrent.textContent = formatTime(audioTime);
    }

    // Progress bar fill (deduplicated)
    if (snapshot.duration > 0) {
      const pct = Math.min(100, Math.max(0, (audioTime / snapshot.duration) * 100)).toFixed(1);
      if (pct !== lastProgressPctStr) {
        lastProgressPctStr = pct;
        progressFill.style.width = `${pct}%`;
        progressThumb.style.left = `${pct}%`;
      }
    } else if (lastProgressPctStr !== '0.0') {
      lastProgressPctStr = '0.0';
      progressFill.style.width = '0%';
      progressThumb.style.left = '0%';
    }

    const lyricTime = getEffectiveLyricTime();
    updateLyrics(lyricTime, allowBackward);
  }

  function shouldRunRenderLoop() {
    return snapshot.playerState === 'playing' && snapshot.isAdvancing !== false && (isExpanded || isAnimating) && !isHoverHidden;
  }

  function tick() {
    animationFrameId = null;
    if (!shouldRunRenderLoop()) return;
    renderSingleFrame(false);
    animationFrameId = requestAnimationFrame(tick);
  }

  function syncRenderLoop() {
    if (shouldRunRenderLoop()) {
      if (!animationFrameId) {
        animationFrameId = requestAnimationFrame(tick);
      }
    } else if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }
})();
