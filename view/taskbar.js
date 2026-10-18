// mods/taskbar-lyrics/view/taskbar.js
// Client logic for taskbar lyrics drawer: clock interpolation, fluid karaoke wipe,
// robust cover rendering, and unidirectional right-to-left slide animation.

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

  // State
  let isExpanded = false;
  let isAnimating = false;
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
      }, 420);
    }
  }

  let snapshot = {
    song: null,
    playerState: 'paused',
    currentTime: 0,
    duration: 0,
    updatedAt: Date.now(),
    lyrics: null,
    lyricOffsetMs: 0,
    settings: { showTranslation: true },
  };

  let activeLineIndex = -999;
  let currentActiveLine = null;
  let animationFrameId = null;

  // Format seconds to mm:ss
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Get raw audio playback time (for elapsed clock & seek bar)
  function getRawAudioTime() {
    let t = snapshot.currentTime || 0;
    if (snapshot.playerState === 'playing' && snapshot.updatedAt) {
      const elapsed = Math.max(0, (Date.now() - snapshot.updatedAt) / 1000);
      t += elapsed;
      if (snapshot.duration > 0 && t > snapshot.duration) {
        t = snapshot.duration;
      }
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
    } else {
      // Exit continuing to left (0 -> -100%)
      appRoot.classList.remove('expanded');
      appRoot.classList.add('exiting');
    }
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

  // Assert topmost on any pointer interaction with the taskbar lyrics window
  appRoot.addEventListener('pointerdown', () => {
    bridge.assertTop();
  });
  appRoot.addEventListener('pointerenter', () => {
    bridge.assertTop();
  });

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
    const pct = clampedRatio * 100;
    progressFill.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
    timeCurrent.textContent = formatTime(targetTime);
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

    // Apply immediate local state update
    snapshot.currentTime = targetTime;
    snapshot.updatedAt = Date.now();
    seekCooldownUntil = Date.now() + 600;

    // Send action to Folia engine
    bridge.sendPlaybackAction('seek', targetTime);

    // Immediately sync lyrics to seek position
    activeLineIndex = -999;
    currentActiveLine = null;
    updateLyrics(getEffectiveLyricTime());
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

  /**
   * Applies the synchronized Folia theme (Daylight vs Dark, accent colors, and custom fonts).
   */
  function applyTheme(theme) {
    if (!theme) return;
    const isDaylight = Boolean(theme.isDaylight);
    if (isDaylight) {
      document.documentElement.classList.add('daylight');
      document.body.classList.add('daylight');
      appRoot.classList.add('daylight');
    } else {
      document.documentElement.classList.remove('daylight');
      document.body.classList.remove('daylight');
      appRoot.classList.remove('daylight');
    }

    const rootStyle = document.documentElement.style;
    if (theme.accentColor) {
      rootStyle.setProperty('--accent-color', theme.accentColor);
      rootStyle.setProperty('--accent-glow', `${theme.accentColor}55`);
      rootStyle.setProperty('--accent-gradient', `linear-gradient(135deg, ${theme.accentColor}, ${theme.accentColor}cc)`);
    }
    if (theme.primaryColor) {
      rootStyle.setProperty('--text-primary', theme.primaryColor);
    }
    if (theme.secondaryColor) {
      rootStyle.setProperty('--text-secondary', theme.secondaryColor);
    }
    if (theme.fontFamily) {
      rootStyle.setProperty('--app-font-family', theme.fontFamily);
    }
  }

  // Receive Snapshot from Main Process
  let lastSongTitle = '';
  let lastSongArtist = '';
  bridge.onSnapshot((data) => {
    if (!data) return;

    if (data.theme) {
      applyTheme(data.theme);
    }

    const currentTitle = data.song?.title || '';
    const currentArtist = data.song?.artist || '';
    const isSongChanged = Boolean(data.song && (currentTitle !== lastSongTitle || currentArtist !== lastSongArtist));
    const isLyricsLoaded = Boolean(data.lyrics !== undefined && data.lyrics !== snapshot.lyrics);

    if (isSongChanged) {
      lastSongTitle = currentTitle;
      lastSongArtist = currentArtist;
      activeLineIndex = -999;
      currentActiveLine = null;
    } else if (isLyricsLoaded) {
      activeLineIndex = -999;
      currentActiveLine = null;
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
    }

    // Guard seek cooldown against stale position echo from audio decoder during seek
    if (seekCooldownUntil > Date.now() && typeof data.currentTime === 'number') {
      if (Math.abs(data.currentTime - snapshot.currentTime) > 1.5) {
        delete data.currentTime;
        delete data.updatedAt;
      } else {
        seekCooldownUntil = 0;
      }
    }

    snapshot = {
      ...snapshot,
      ...data,
      lyrics: nextLyrics,
      settings: {
        ...snapshot.settings,
        ...(data.settings || {}),
      },
      updatedAt: data.updatedAt || Date.now(),
    };

    if (data.theme) {
      applyTheme(data.theme);
    }

    updateMetadata();
    updatePlayerState();
    updateLyrics(getEffectiveLyricTime());
  });

  // Update Metadata (Song Title, Artist, Cover)
  function updateMetadata() {
    const song = snapshot.song;
    if (song) {
      songTitle.textContent = song.title || '未知曲目';
      songArtist.textContent = song.artist || 'Folia';
      if (song.coverUrl) {
        if (coverImg.src !== song.coverUrl) {
          coverImg.src = song.coverUrl;
        }
      } else {
        coverImg.src = '';
        coverImg.style.opacity = '0';
        if (coverFallback) coverFallback.style.display = 'flex';
      }

      // If lyrics are not present yet, immediately display song info in center stage to eliminate stuck placeholder
      if (!snapshot.lyrics || !Array.isArray(snapshot.lyrics.lines) || snapshot.lyrics.lines.length === 0) {
        const lyricsStage = document.querySelector('.lyrics-stage-section');
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
        lyricMain.style.setProperty('--wipe-pct', '100%');
      }
    } else {
      songTitle.textContent = '等待播放';
      songArtist.textContent = 'Folia';
      coverImg.src = '';
      coverImg.style.opacity = '0';
      if (coverFallback) coverFallback.style.display = 'flex';
      lyricMain.textContent = '♪ 享受纯净旋律 ♪';
      lyricMain.style.setProperty('--wipe-pct', '100%');
      lyricSub.textContent = '';
    }

    // Folia-style blurred fluid cover background
    if (drawerCoverBg) {
      const useCoverBg = snapshot.settings?.useCoverBackground !== false;
      const targetCoverUrl = song && song.coverUrl ? song.coverUrl : '';
      if (useCoverBg && targetCoverUrl) {
        if (drawerCoverBg.getAttribute('data-src') !== targetCoverUrl) {
          drawerCoverBg.setAttribute('data-src', targetCoverUrl);
          const bgLoader = new Image();
          bgLoader.onload = () => {
            drawerCoverBg.src = targetCoverUrl;
            drawerCoverBg.classList.add('loaded');
          };
          bgLoader.onerror = () => {
            drawerCoverBg.classList.remove('loaded');
          };
          bgLoader.src = targetCoverUrl;
        }
      } else {
        drawerCoverBg.classList.remove('loaded');
        drawerCoverBg.removeAttribute('data-src');
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
  function updateLyrics(time) {
    const lyrics = snapshot.lyrics;
    if (!lyrics || !Array.isArray(lyrics.lines) || lyrics.lines.length === 0) {
      if (activeLineIndex !== -1) {
        activeLineIndex = -1;
        currentActiveLine = null;
        lyricMain.textContent = snapshot.song?.title
          ? `${snapshot.song.title} - ${snapshot.song.artist || 'Folia'}`
          : '♪ 享受纯净旋律 ♪';
        lyricMain.style.setProperty('--wipe-pct', '0%');
        lyricSub.textContent = '';
      }
      return;
    }

    const lines = lyrics.lines;
    const { index: currentIdx, line: matchLine, isInterlude } = findLatestActiveLine(lines, time);

    if (currentIdx !== activeLineIndex) {
      activeLineIndex = currentIdx;
      currentActiveLine = matchLine;
      renderActiveLine(currentActiveLine, isInterlude);
    }

    // High frequency continuous fluid wipe progress
    updateContinuousLyricWipe(currentActiveLine, time);
  }

  // Render text for active line with clear hierarchy and micro-transition
  function renderActiveLine(line, isInterlude) {
    const lyricsStage = document.querySelector('.lyrics-stage-section');
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
      lyricMain.style.setProperty('--wipe-pct', '0%');
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
    lyricMain.style.setProperty('--wipe-pct', '0%');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        lyricMain.classList.remove('line-switching');
      });
    });
  }

  /**
   * Calculates continuous sub-character progress for professional karaoke gradient sweep.
   * @param {object|null} line Active lyric line
   * @param {number} time Current playback timestamp in seconds
   */
  function updateContinuousLyricWipe(line, time) {
    if (!line) {
      lyricMain.style.setProperty('--wipe-pct', '0%');
      return;
    }

    const start = Number(line.startTime) || 0;
    const end = Math.max(start + 0.1, Number(line.endTime) || (start + 4));

    if (time <= start) {
      lyricMain.style.setProperty('--wipe-pct', '0%');
      return;
    }
    if (time >= end) {
      lyricMain.style.setProperty('--wipe-pct', '100%');
      return;
    }

    // If word-by-word timestamps are available
    if (Array.isArray(line.words) && line.words.length > 0) {
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

      const pct = Math.max(0, Math.min(100, (charsPassed / totalChars) * 100));
      lyricMain.style.setProperty('--wipe-pct', `${pct.toFixed(2)}%`);
    } else {
      // Line-level fluid progress
      const fraction = Math.max(0, Math.min(1, (time - start) / (end - start)));
      const pct = fraction * 100;
      lyricMain.style.setProperty('--wipe-pct', `${pct.toFixed(2)}%`);
    }
  }

  // Main high-frequency render loop
  function tick() {
    if (!isDraggingProgress) {
      const audioTime = getRawAudioTime();
      timeCurrent.textContent = formatTime(audioTime);

      // Progress bar fill
      if (snapshot.duration > 0) {
        const pct = Math.min(100, Math.max(0, (audioTime / snapshot.duration) * 100));
        progressFill.style.width = `${pct}%`;
        progressThumb.style.left = `${pct}%`;
      } else {
        progressFill.style.width = '0%';
        progressThumb.style.left = '0%';
      }
    }

    // Lyrics update driven by effective lyric timeline
    const lyricTime = getEffectiveLyricTime();
    updateLyrics(lyricTime);

    animationFrameId = requestAnimationFrame(tick);
  }

  // Start tick loop
  animationFrameId = requestAnimationFrame(tick);

  window.addEventListener('beforeunload', () => {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }
  });
})();
