// mods/taskbar-lyrics/view/radial.js
// Renders a rotary, cover-art-backed 180-degree semicircle radial playlist wheel
// with smooth left-to-right rotational launch entrance, retract exit, mouse-wheel/drag/button rotation.

(function () {
  'use strict';

  const bridge = window.taskbarBridge;
  if (!bridge) {
    console.error('TaskbarBridge not available in radial view');
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VISIBLE_SLOTS = 5;
  const TOTAL_SPAN_DEG = 172;
  const R_INNER = 54;
  const R_OUTER = 144;
  const R_LABEL = 102;

  const radialRoot = document.getElementById('radialRoot');
  const wheelSvg = document.getElementById('wheelSvg');
  const hubControls = document.getElementById('hubControls');
  const hubBadge = document.getElementById('hubBadge');
  const hubTitle = document.getElementById('hubTitle');
  const hubSub = document.getElementById('hubSub');
  const rotPrevBtn = document.getElementById('rotPrevBtn');
  const rotNextBtn = document.getElementById('rotNextBtn');

  let currentPayload = {
    song: null,
    liked: false,
    canLike: false,
    targets: [],
    loading: false,
    theme: null,
    placement: 'top',
    hubOffsetX: 164,
  };
  let isSubmitting = false;
  let feedbackTimer = null;
  let submitSafetyTimer = null;

  // Rotary wheel animation state (in slot units)
  let targetRotation = 0;
  let animatedRotation = 0;
  let rotationRafId = null;
  let sectorEntries = [];
  let wheelMeta = {
    cx: 164,
    cy: 180,
    isBottom: false,
    count: 0,
    isRotary: false,
    slotDeg: TOTAL_SPAN_DEG / VISIBLE_SLOTS,
  };

  // Drag-to-spin state
  let dragActive = false;
  let dragMoved = false;
  let dragStartX = 0;
  let dragStartRotation = 0;
  let suppressClickUntil = 0;

  function clearSubmitSafetyTimer() {
    if (submitSafetyTimer) {
      clearTimeout(submitSafetyTimer);
      submitSafetyTimer = null;
    }
  }

  function stopRotationLoop() {
    if (rotationRafId !== null) {
      cancelAnimationFrame(rotationRafId);
      rotationRafId = null;
    }
  }

  function parseRgb(colorStr) {
    if (!colorStr) return null;
    let s = String(colorStr).trim();
    if (s.startsWith('rgb')) {
      const m = s.match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) return [Number(m[0]) || 0, Number(m[1]) || 0, Number(m[2]) || 0];
    }
    if (s.startsWith('#')) s = s.slice(1);
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length >= 6) {
      return [
        parseInt(s.substring(0, 2), 16) || 0,
        parseInt(s.substring(2, 4), 16) || 0,
        parseInt(s.substring(4, 6), 16) || 0,
      ];
    }
    return null;
  }

  function withAlpha(colorStr, alpha) {
    const rgb = parseRgb(colorStr);
    if (!rgb) return `rgba(99, 102, 241, ${alpha})`;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
  }

  function mixRgb(colorStr, targetRgb, ratio, alpha) {
    const rgb = parseRgb(colorStr);
    if (!rgb) return `rgba(${targetRgb[0]}, ${targetRgb[1]}, ${targetRgb[2]}, ${alpha})`;
    const r = Math.round(rgb[0] + (targetRgb[0] - rgb[0]) * ratio);
    const g = Math.round(rgb[1] + (targetRgb[1] - rgb[1]) * ratio);
    const b = Math.round(rgb[2] + (targetRgb[2] - rgb[2]) * ratio);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function applyTheme(theme) {
    if (!theme) return;
    const isDaylight = Boolean(theme.isDaylight);
    document.documentElement.classList.toggle('daylight', isDaylight);
    document.body.classList.toggle('daylight', isDaylight);
    const rootStyle = document.documentElement.style;
    const accent = theme.accentColor || (isDaylight ? '#ea580c' : '#6366f1');
    const bg = theme.backgroundColor || (isDaylight ? '#f8f8fa' : '#14141c');
    const primary = theme.primaryColor || (isDaylight ? '#18181b' : '#f8fafc');
    rootStyle.setProperty('--wheel-accent', accent);
    rootStyle.setProperty('--wheel-accent-soft', withAlpha(accent, isDaylight ? 0.2 : 0.3));
    rootStyle.setProperty('--wheel-bg', withAlpha(bg, isDaylight ? 0.95 : 0.92));
    rootStyle.setProperty(
      '--wheel-bg-hover',
      mixRgb(bg, [255, 255, 255], isDaylight ? 0.45 : 0.12, isDaylight ? 0.99 : 0.96),
    );
    rootStyle.setProperty('--wheel-hub-bg', withAlpha(bg, isDaylight ? 0.97 : 0.95));
    rootStyle.setProperty('--wheel-text', primary);
    rootStyle.setProperty('--wheel-sub', withAlpha(primary, isDaylight ? 0.64 : 0.72));
  }

  function setHubText(title, sub, feedbackKind = '') {
    hubBadge.classList.remove('feedback-ok', 'feedback-err');
    if (feedbackKind === 'ok') hubBadge.classList.add('feedback-ok');
    if (feedbackKind === 'err') hubBadge.classList.add('feedback-err');
    hubTitle.textContent = title || '选择收藏';
    hubSub.textContent = sub || '';
  }

  function resolveEffectiveTargets() {
    if (Array.isArray(currentPayload.targets) && currentPayload.targets.length > 0) {
      return currentPayload.targets;
    }
    if (currentPayload.song) {
      return [{
        id: '__liked__',
        kind: 'like',
        name: currentPayload.liked ? '取消喜欢' : '我喜欢的音乐',
        shortName: currentPayload.liked ? '取消喜欢' : '我喜欢',
        coverUrl: currentPayload.song?.coverUrl || '',
        liked: Boolean(currentPayload.liked),
        disabled: !currentPayload.canLike,
      }];
    }
    return [];
  }

  function resetHubToIdle() {
    if (isSubmitting || feedbackTimer) return;
    const targets = resolveEffectiveTargets();
    if (currentPayload.loading && (!Array.isArray(currentPayload.targets) || currentPayload.targets.length === 0)) {
      setHubText('加载中…', '读取歌单');
      return;
    }
    if (targets.length > VISIBLE_SLOTS) {
      setHubText('旋转选歌单', `滚轮/拖拽 · ${targets.length}个`);
    } else if (targets.length > 1) {
      setHubText('收藏到', `${targets.length} 个位置`);
    } else if (targets.length === 1) {
      if (targets[0].disabled) {
        setHubText('暂不可收藏', '当前曲目不支持');
      } else {
        setHubText(currentPayload.liked ? '已喜欢' : '红心喜欢', '点击切换喜欢');
      }
    } else {
      setHubText('暂无歌曲', '播放后可用');
    }
  }

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }

  function buildSectorPath(cx, cy, rInner, rOuter, startDeg, endDeg) {
    const outerStart = polarToCartesian(cx, cy, rOuter, startDeg);
    const outerEnd = polarToCartesian(cx, cy, rOuter, endDeg);
    const innerEnd = polarToCartesian(cx, cy, rInner, endDeg);
    const innerStart = polarToCartesian(cx, cy, rInner, startDeg);
    const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;

    return [
      `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
      `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
      `A ${rInner} ${rInner} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  function createSvgEl(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      el.setAttribute(k, String(v));
    }
    return el;
  }

  function createSectorIcon(kind, x, y, collected = false) {
    const iconGroup = createSvgEl('g', {
      class: 'sector-icon-wrap',
      transform: `translate(${(x - 9).toFixed(2)}, ${(y - 9).toFixed(2)}) scale(0.75)`,
    });
    if (kind === 'like') {
      iconGroup.appendChild(createSvgEl('path', {
        class: 'sector-icon',
        d: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
      }));
    } else if (collected) {
      iconGroup.appendChild(createSvgEl('circle', {
        class: 'sector-icon',
        cx: '12',
        cy: '12',
        r: '9.5',
      }));
      iconGroup.appendChild(createSvgEl('polyline', {
        class: 'sector-icon',
        points: '8 12.2 10.9 15 16.4 9.2',
      }));
    } else {
      iconGroup.appendChild(createSvgEl('path', {
        class: 'sector-icon',
        d: 'M9 18V5l12-2v13',
      }));
      iconGroup.appendChild(createSvgEl('circle', {
        class: 'sector-icon',
        cx: '6',
        cy: '18',
        r: '3',
      }));
      iconGroup.appendChild(createSvgEl('circle', {
        class: 'sector-icon',
        cx: '18',
        cy: '16',
        r: '3',
      }));
    }
    return iconGroup;
  }

  /**
   * Computes shortest signed modular offset in [-count/2, +count/2) relative to center slot 2.
   */
  function wrapSlotDelta(index, rotOffset, count) {
    // Center visible slot is slot 2 (index 2 of 0..4)
    const centerIndex = rotOffset + (VISIBLE_SLOTS - 1) / 2;
    let delta = ((index - centerIndex) % count + count) % count;
    if (delta >= count / 2) {
      delta -= count;
    }
    return delta;
  }

  /**
   * Positions all rendered sectors around (cx, cy) based on current animatedRotation.
   * Cover images & DOM nodes stay mounted so rotation runs smoothly at 60fps without reloading covers.
   */
  function updateRotaryPositions() {
    const { cx, cy, isBottom, count, isRotary, slotDeg } = wheelMeta;
    const baseAngle = isBottom ? 90 : -90;
    const dir = isBottom ? -1 : 1; // Keep slot index increasing left-to-right for both placements

    for (let i = 0; i < sectorEntries.length; i++) {
      const entry = sectorEntries[i];
      let relSlot;
      if (isRotary) {
        relSlot = wrapSlotDelta(entry.index, animatedRotation, count);
      } else {
        relSlot = entry.index - (count - 1) / 2;
      }

      const deltaDeg = dir * relSlot * slotDeg;
      const absDelta = Math.abs(deltaDeg);
      const maxVisibleHalf = TOTAL_SPAN_DEG / 2 + slotDeg * 0.65;

      if (isRotary && absDelta > maxVisibleHalf) {
        entry.group.style.display = 'none';
        entry.group.style.pointerEvents = 'none';
        continue;
      }

      entry.group.style.display = '';
      // Smoothly ramp opacity near the taskbar horizon so entering/exiting sectors glide cleanly
      let edgeAlpha = 1;
      if (isRotary) {
        const fadeStart = TOTAL_SPAN_DEG / 2 - slotDeg * 0.25;
        if (absDelta > fadeStart) {
          edgeAlpha = Math.max(0, Math.min(1, 1 - (absDelta - fadeStart) / (slotDeg * 0.85)));
        }
      }
      entry.group.style.opacity = edgeAlpha.toFixed(3);
      entry.group.style.pointerEvents = edgeAlpha < 0.2 ? 'none' : '';
      entry.group.setAttribute('transform', `rotate(${deltaDeg.toFixed(2)}, ${cx}, ${cy})`);
      // Counter-rotate icon + label upright around their radial centroid
      entry.labelGroup.setAttribute(
        'transform',
        `rotate(${(-deltaDeg).toFixed(2)}, ${entry.labelX.toFixed(2)}, ${entry.labelY.toFixed(2)})`,
      );

      // Update radial hover pop direction for this sector's live angle
      const liveDeg = baseAngle + deltaDeg;
      entry.liveRad = (liveDeg * Math.PI) / 180;
    }
  }

  function ensureRotationLoop() {
    if (rotationRafId !== null) return;
    const step = () => {
      rotationRafId = null;
      const diff = targetRotation - animatedRotation;
      if (Math.abs(diff) < 0.002) {
        animatedRotation = targetRotation;
        updateRotaryPositions();
        return;
      }
      animatedRotation += diff * 0.22;
      updateRotaryPositions();
      rotationRafId = requestAnimationFrame(step);
    };
    rotationRafId = requestAnimationFrame(step);
  }

  function rotateBy(deltaSlots) {
    if (!wheelMeta.isRotary || isSubmitting || feedbackTimer) return;
    targetRotation += deltaSlots;
    ensureRotationLoop();
  }

  function renderWheel(preserveRotation = false) {
    stopRotationLoop();
    while (wheelSvg.firstChild) {
      wheelSvg.removeChild(wheelSvg.firstChild);
    }
    sectorEntries = [];

    const isBottom = currentPayload.placement === 'bottom';
    radialRoot.classList.toggle('placement-top', !isBottom);
    radialRoot.classList.toggle('placement-bottom', isBottom);

    const rawHubX = typeof currentPayload.hubOffsetX === 'number' && Number.isFinite(currentPayload.hubOffsetX)
      ? currentPayload.hubOffsetX
      : 164;
    const cx = Math.max(148, Math.min(180, Math.round(rawHubX)));
    const cy = isBottom ? 16 : 180;
    radialRoot.style.transformOrigin = `${cx}px ${cy}px`;
    if (hubControls) {
      hubControls.style.left = `${cx}px`;
    }

    const targets = resolveEffectiveTargets();
    const count = targets.length;
    const isRotary = count > VISIBLE_SLOTS;
    const visibleCount = isRotary ? VISIBLE_SLOTS : Math.max(1, count);
    const slotDeg = TOTAL_SPAN_DEG / visibleCount;
    const gapDeg = visibleCount > 1 ? 2.6 : 0;

    wheelMeta = { cx, cy, isBottom, count, isRotary, slotDeg };
    if (!preserveRotation || !isRotary) {
      targetRotation = 0;
      animatedRotation = 0;
    }

    if (rotPrevBtn && rotNextBtn) {
      rotPrevBtn.classList.toggle('hidden', !isRotary);
      rotNextBtn.classList.toggle('hidden', !isRotary);
    }

    if (count === 0) {
      resetHubToIdle();
      return;
    }

    // Build SVG defs: horizon clipPath so rotating wedges cleanly emerge from / dip below taskbar border
    const defs = createSvgEl('defs');
    const horizonClip = createSvgEl('clipPath', { id: 'horizonClip' });
    horizonClip.appendChild(createSvgEl('rect', {
      x: '-40',
      y: isBottom ? String(cy - 2) : '-40',
      width: '408',
      height: isBottom ? String(240 - cy) : String(cy + 42),
    }));
    defs.appendChild(horizonClip);

    // Canonical sector geometry centered straight up (-90deg) or straight down (+90deg)
    const baseAngle = isBottom ? 90 : -90;
    const halfArc = (slotDeg - gapDeg) / 2;
    const canonicalStart = baseAngle - halfArc;
    const canonicalEnd = baseAngle + halfArc;
    const canonicalPathD = buildSectorPath(cx, cy, R_INNER, R_OUTER, canonicalStart, canonicalEnd);
    const canonicalClipId = 'canonicalSectorClip';
    const canonicalClip = createSvgEl('clipPath', { id: canonicalClipId });
    canonicalClip.appendChild(createSvgEl('path', { d: canonicalPathD }));
    defs.appendChild(canonicalClip);
    wheelSvg.appendChild(defs);

    const dialGroup = createSvgEl('g', {
      class: 'wheel-dial',
      'clip-path': 'url(#horizonClip)',
    });
    wheelSvg.appendChild(dialGroup);

    const contentPt = polarToCartesian(cx, cy, R_LABEL, baseAngle);
    const coverBoxSize = Math.ceil(R_OUTER - R_INNER + 44);
    const coverX = contentPt.x - coverBoxSize / 2;
    const coverY = contentPt.y - coverBoxSize / 2;

    targets.forEach((target, idx) => {
      const hasCover = typeof target.coverUrl === 'string' && target.coverUrl.trim().length > 0;
      const isCollected = target.kind === 'playlist' && Boolean(target.inPlaylist);
      const isLockedCollected = isCollected && target.canRemove === false;
      const g = createSvgEl('g', {
        class: [
          'wheel-sector',
          target.kind === 'like' ? 'like-sector' : 'playlist-sector',
          target.liked ? 'liked' : '',
          isCollected ? 'collected' : '',
          isLockedCollected ? 'locked-collected' : '',
          target.disabled ? 'disabled' : '',
          hasCover ? 'has-cover' : 'no-cover',
        ].filter(Boolean).join(' '),
        'data-id': target.id,
      });

      // Stationary hit target prevents edge jitter when sector visual lifts outward
      g.appendChild(createSvgEl('path', {
        class: 'sector-hit',
        d: canonicalPathD,
      }));

      // Staggered launch container (left-to-right cascade launching from wheel hub cx, cy)
      const launchGroup = createSvgEl('g', { class: 'sector-launch' });
      launchGroup.style.transformOrigin = `${cx}px ${cy}px`;
      const staggerIndex = Math.min(idx, VISIBLE_SLOTS - 1);
      const launchDelayMs = preserveRotation ? 0 : staggerIndex * 38;
      launchGroup.style.transitionDelay = `${launchDelayMs}ms`;

      // Hover pop container (translates straight outward along canonical axis, which rotates with g!)
      const popGroup = createSvgEl('g', { class: 'sector-pop' });
      const popOffsetY = isBottom ? 6 : -6;

      // Clipped artwork + scrim interior
      const clippedFill = createSvgEl('g', { 'clip-path': `url(#${canonicalClipId})` });
      clippedFill.appendChild(createSvgEl('path', {
        class: 'sector-base',
        d: canonicalPathD,
      }));

      if (hasCover) {
        const imgEl = createSvgEl('image', {
          class: 'sector-cover',
          x: coverX.toFixed(1),
          y: coverY.toFixed(1),
          width: coverBoxSize,
          height: coverBoxSize,
          preserveAspectRatio: 'xMidYMid slice',
        });
        imgEl.setAttribute('href', target.coverUrl);
        imgEl.addEventListener('error', () => {
          imgEl.style.display = 'none';
          g.classList.remove('has-cover');
          g.classList.add('no-cover');
        });
        clippedFill.appendChild(imgEl);
      }

      clippedFill.appendChild(createSvgEl('path', {
        class: 'sector-scrim',
        d: canonicalPathD,
      }));
      popGroup.appendChild(clippedFill);

      // Crisp border
      popGroup.appendChild(createSvgEl('path', {
        class: 'sector-border',
        d: canonicalPathD,
      }));

      // Upright counter-rotated icon & label group
      const labelGroup = createSvgEl('g', { class: 'sector-label-group' });
      const iconEl = createSectorIcon(target.kind, contentPt.x, contentPt.y - 10, isCollected);
      labelGroup.appendChild(iconEl);

      const labelEl = createSvgEl('text', {
        class: visibleCount >= 5 ? 'sector-label compact' : 'sector-label',
        x: contentPt.x.toFixed(2),
        y: (contentPt.y + 10).toFixed(2),
      });
      const maxLen = visibleCount <= 2 ? 7 : (visibleCount <= 4 ? 5 : 4);
      const rawName = String(target.shortName || target.name || '歌单').trim();
      labelEl.textContent = rawName.length > maxLen ? `${rawName.slice(0, maxLen - 1)}…` : rawName;
      labelGroup.appendChild(labelEl);

      popGroup.appendChild(labelGroup);
      launchGroup.appendChild(popGroup);
      g.appendChild(launchGroup);

      const entry = {
        index: idx,
        target,
        group: g,
        launchGroup,
        popGroup,
        labelGroup,
        iconEl,
        labelEl,
        labelX: contentPt.x,
        labelY: contentPt.y,
        liveRad: (baseAngle * Math.PI) / 180,
      };
      sectorEntries.push(entry);

      g.addEventListener('pointerenter', () => {
        const cur = entry.target;
        if (cur.disabled || isSubmitting || feedbackTimer || dragActive) return;
        popGroup.style.transform = `translateY(${popOffsetY}px)`;
        const subText = cur.kind === 'like'
          ? (cur.liked ? '点击取消喜欢' : '点击红心喜欢')
          : (cur.inPlaylist
              ? (cur.canRemove === false ? '已在此收藏夹中' : '已收藏 · 点击取消收藏')
              : (cur.trackCount > 0 ? `${cur.trackCount} 首 · 点击加入` : '点击加入此歌单'));
        setHubText(cur.name || cur.shortName, subText, cur.inPlaylist ? 'ok' : '');
      });

      g.addEventListener('pointerleave', () => {
        popGroup.style.transform = '';
        resetHubToIdle();
      });

      g.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() < suppressClickUntil) return;
        const cur = entry.target;
        if (cur.disabled || isSubmitting || feedbackTimer) return;
        if (cur.kind === 'playlist' && cur.inPlaylist && cur.canRemove === false) {
          setHubText('无法移出', '该歌单不支持移出', 'err');
          feedbackTimer = setTimeout(() => {
            feedbackTimer = null;
            resetHubToIdle();
          }, 720);
          return;
        }
        isSubmitting = true;
        g.classList.add('busy');
        const pendingLabel = cur.kind === 'like'
          ? '处理中…'
          : (cur.inPlaylist ? '正在移出…' : '正在加入…');
        setHubText(pendingLabel, cur.name || '');
        clearSubmitSafetyTimer();
        submitSafetyTimer = setTimeout(() => {
          submitSafetyTimer = null;
          if (isSubmitting && !feedbackTimer) {
            isSubmitting = false;
            g.classList.remove('busy');
            setHubText('操作超时', '请稍后重试', 'err');
            feedbackTimer = setTimeout(() => {
              feedbackTimer = null;
              bridge.closeRadialWheel();
            }, 850);
          }
        }, 6000);
        bridge.selectRadialTarget({
          id: cur.id,
          kind: cur.kind,
          name: cur.name,
          inPlaylist: Boolean(cur.inPlaylist),
        });
      });

      dialGroup.appendChild(g);
    });

    updateRotaryPositions();
    resetHubToIdle();
    if (preserveRotation) {
      dialGroup.classList.add('launched');
    } else {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          dialGroup.classList.add('launched');
        });
      });
    }
  }

  // Rotation gestures: mouse wheel, ‹/› buttons, and horizontal pointer drag
  radialRoot.addEventListener('wheel', (e) => {
    if (!wheelMeta.isRotary) return;
    e.preventDefault();
    const dominant = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (dominant === 0) return;
    rotateBy(dominant > 0 ? 1 : -1);
  }, { passive: false });

  if (rotPrevBtn) {
    rotPrevBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rotateBy(-1);
    });
  }

  if (rotNextBtn) {
    rotNextBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      rotateBy(1);
    });
  }

  radialRoot.addEventListener('pointerdown', (e) => {
    if (!wheelMeta.isRotary || e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('.rot-btn')) return;
    dragActive = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartRotation = targetRotation;
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragActive || !wheelMeta.isRotary) return;
    const dx = e.clientX - dragStartX;
    if (!dragMoved && Math.abs(dx) < 8) return;
    dragMoved = true;
    targetRotation = dragStartRotation - dx / 52;
    ensureRotationLoop();
  });

  const endDrag = () => {
    if (!dragActive) return;
    dragActive = false;
    if (dragMoved) {
      dragMoved = false;
      suppressClickUntil = Date.now() + 180;
      targetRotation = Math.round(targetRotation);
      ensureRotationLoop();
    }
  };

  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  function canPatchSectorsInPlace(nextTargets) {
    if (!Array.isArray(nextTargets) || nextTargets.length === 0 || nextTargets.length !== sectorEntries.length) {
      return false;
    }
    for (let i = 0; i < nextTargets.length; i++) {
      if (String(nextTargets[i].id) !== String(sectorEntries[i].target.id)) {
        return false;
      }
    }
    return true;
  }

  function patchSectorsInPlace(nextTargets) {
    for (let i = 0; i < nextTargets.length; i++) {
      const entry = sectorEntries[i];
      const next = nextTargets[i];
      const wasCollected = entry.target.kind === 'playlist' && Boolean(entry.target.inPlaylist);
      const isCollected = next.kind === 'playlist' && Boolean(next.inPlaylist);
      entry.target = next;
      entry.group.classList.toggle('liked', Boolean(next.liked));
      entry.group.classList.toggle('collected', isCollected);
      entry.group.classList.toggle('locked-collected', isCollected && next.canRemove === false);
      entry.group.classList.toggle('disabled', Boolean(next.disabled));
      if (wasCollected !== isCollected && entry.labelGroup && entry.iconEl) {
        const replacementIcon = createSectorIcon(next.kind, entry.labelX, entry.labelY - 10, isCollected);
        entry.labelGroup.replaceChild(replacementIcon, entry.iconEl);
        entry.iconEl = replacementIcon;
      }
    }
  }

  bridge.onRadialData((data) => {
    if (!data || typeof data !== 'object') return;
    if (isSubmitting || feedbackTimer) {
      return;
    }
    const wasVisible = radialRoot.classList.contains('visible') && !radialRoot.classList.contains('closing');
    const prevCount = Array.isArray(currentPayload.targets) ? currentPayload.targets.length : 0;
    currentPayload = {
      ...currentPayload,
      ...data,
    };
    if (data.theme) {
      applyTheme(data.theme);
    }
    const effectiveTargets = resolveEffectiveTargets();
    if (wasVisible && canPatchSectorsInPlace(effectiveTargets)) {
      patchSectorsInPlace(effectiveTargets);
      return;
    }
    const nextCount = Array.isArray(currentPayload.targets) ? currentPayload.targets.length : 0;
    const preserveRot = wasVisible && prevCount > 0 && prevCount === nextCount;

    radialRoot.classList.remove('closing');
    if (!wasVisible) {
      radialRoot.classList.remove('visible');
    }
    renderWheel(preserveRot);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        radialRoot.classList.remove('closing');
        radialRoot.classList.add('visible');
      });
    });
  });

  bridge.onRadialFeedback((feedback) => {
    if (!feedback || typeof feedback !== 'object') return;
    clearSubmitSafetyTimer();
    if (feedbackTimer) {
      clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
    const ok = Boolean(feedback.ok);
    const titleText = ok ? (feedback.removed ? '已移出' : '已保存') : '失败';
    setHubText(titleText, feedback.message || '', ok ? 'ok' : 'err');
    feedbackTimer = setTimeout(() => {
      feedbackTimer = null;
      isSubmitting = false;
      bridge.closeRadialWheel();
    }, ok ? 520 : 950);
  });

  bridge.onRadialClosed(() => {
    clearSubmitSafetyTimer();
    stopRotationLoop();
    if (feedbackTimer) {
      clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
    isSubmitting = false;
    dragActive = false;
    dragMoved = false;
    // Remove per-sector launch stagger so all wedges retract cleanly together
    for (let i = 0; i < sectorEntries.length; i++) {
      sectorEntries[i].launchGroup.style.transitionDelay = '0ms';
    }
    radialRoot.classList.remove('visible');
    radialRoot.classList.add('closing');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      bridge.closeRadialWheel();
    } else if (e.key === 'ArrowLeft') {
      rotateBy(-1);
    } else if (e.key === 'ArrowRight') {
      rotateBy(1);
    }
  });
})();
