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

  let activeLineIndex = -1;
  let currentActiveLine = null;
  let animationFrameId = null;

  // Format seconds to mm:ss
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Get interpolated current audio time
  function getInterpolatedTime() {
    let t = snapshot.currentTime || 0;
    if (snapshot.playerState === 'playing' && snapshot.updatedAt) {
      const elapsed = Math.max(0, (Date.now() - snapshot.updatedAt) / 1000);
      t += elapsed;
      if (snapshot.duration > 0 && t > snapshot.duration) {
        t = snapshot.duration;
      }
    }
    const offsetSec = (snapshot.lyricOffsetMs || 0) / 1000;
    return Math.max(0, t + offsetSec);
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

  // Seek bar interaction
  progressBar.addEventListener('click', (e) => {
    if (!snapshot.duration || snapshot.duration <= 0) return;
    const rect = progressBar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetTime = ratio * snapshot.duration;
    bridge.sendPlaybackAction('seek', targetTime);
  });

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
  bridge.onSnapshot((data) => {
    if (!data) return;
    const nextLyrics = data.lyrics && Array.isArray(data.lyrics.lines) ? {
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
    } : (data.lyrics ?? snapshot.lyrics);

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

    updateMetadata();
    updatePlayerState();
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
    } else {
      songTitle.textContent = '等待播放';
      songArtist.textContent = 'Folia';
      coverImg.src = '';
      coverImg.style.opacity = '0';
      if (coverFallback) coverFallback.style.display = 'flex';
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

  // Update Karaoke Lyric Line
  function updateLyrics(time) {
    const lyrics = snapshot.lyrics;
    if (!lyrics || !Array.isArray(lyrics.lines) || lyrics.lines.length === 0) {
      if (activeLineIndex !== -1) {
        activeLineIndex = -1;
        currentActiveLine = null;
        lyricMain.textContent = snapshot.song ? '♪ 间奏 ♪' : '♪ 享受纯净旋律 ♪';
        lyricMain.style.setProperty('--wipe-pct', '0%');
        lyricSub.textContent = '';
      }
      return;
    }

    const lines = lyrics.lines;
    let currentIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const start = Number(line.startTime) || 0;
      const end = Number(line.endTime) || (lines[i + 1] ? Number(lines[i + 1].startTime) : start + 5);
      if (time >= start && time <= end) {
        currentIdx = i;
        break;
      } else if (time < start) {
        currentIdx = Math.max(0, i - 1);
        break;
      }
    }

    if (currentIdx === -1 && lines.length > 0) {
      if (time > (lines[lines.length - 1].startTime || 0)) {
        currentIdx = lines.length - 1;
      } else {
        currentIdx = 0;
      }
    }

    if (currentIdx !== activeLineIndex) {
      activeLineIndex = currentIdx;
      currentActiveLine = lines[currentIdx] || null;
      renderActiveLine(currentActiveLine);
    }

    // High frequency continuous fluid wipe progress
    updateContinuousLyricWipe(currentActiveLine, time);
  }

  // Render text for active line with clear hierarchy and micro-transition
  function renderActiveLine(line) {
    const lyricsStage = document.querySelector('.lyrics-stage-section');
    if (!line) {
      if (lyricsStage) lyricsStage.classList.add('single-row');
      lyricMain.textContent = snapshot.song ? '♪ 间奏 ♪' : '♪ 享受纯净旋律 ♪';
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
    const time = getInterpolatedTime();
    timeCurrent.textContent = formatTime(time);

    // Progress bar fill
    if (snapshot.duration > 0) {
      const pct = Math.min(100, Math.max(0, (time / snapshot.duration) * 100));
      progressFill.style.width = `${pct}%`;
      progressThumb.style.left = `${pct}%`;
    } else {
      progressFill.style.width = '0%';
      progressThumb.style.left = '0%';
    }

    // Lyrics update
    updateLyrics(time);

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
