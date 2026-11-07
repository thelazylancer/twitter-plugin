// Extracted from content.js (WP-C). The scroll-restore guard runs after
// content.js in the MAIN-world content_scripts bundle. See manifest.json.
// The back-navigation guard marker below is used by
// tests/back-scroll-restore.test.js to slice this file for its vm harness.
// Back-navigation scroll-restore guard.
//
// X's SPA + virtual list often lands Back at the wrong window (Chrome clamps
// programmatic scroll while feed height is still short). We do NOT cover the
// UI with a freeze/snapshot overlay — clones ghost and misalign at the header.
//
// Light restore only:
//   - Save tweetId + viewport offset (+ up to 8 visible anchors) on click.
//   - On browser Back / BFCache: suppress X window.scrollTo/By (and scrollTop)
//     briefly; wait for a plausible feed cell; ONE fine pin (repin only if
//     drift persists). Never clamped coarse while scrollMax < want.y.
//   - Prefer wait-for-anchor over coarse wake; at most one coarse after height
//     quiets if the cell is still missing.
//   - Pin/repin uses a short custom ease (~260ms) for the deep return hop;
//     coarse and tiny corrections stay instant (native smooth fights the VL).
//   - Quiet early-exit; no blank veil; no freeze overlay.
//   - Cancel on real user scroll intent. Sidebar Home is not restored.
(() => {

  // --- article-id resolution seam -------------------------------------------
  // content.js defines getTweetIdFromArticle at classic-script top level, so by
  // the time this lib loads (manifest order: content.js -> this file) the name
  // is already a shared global binding. Resolve it lazily at call time so a
  // stub injected by tests also wins. localIdFromArticle is only a DEGRADED
  // APPROXIMATION used when neither the global nor the stub exists (bare vm /
  // standalone load): the real function consults the content.js-top-level
  // tweetDataStore for multi-link disambiguation, which is unreachable here.
  // Production always hits the real content.js function; the back-scroll test
  // harness injects its own stub. So this fallback affects neither production
  // behavior nor the 30 baseline cases.
  function localIdFromArticle(article) {
    if (!article || typeof article.querySelectorAll !== 'function') return null;
    const ownLinks = (selector) => Array.from(article.querySelectorAll(selector))
      .filter((link) => link.closest('article[data-testid="tweet"]') === article);
    const idFromLink = (link) => link?.getAttribute?.('href')?.match(/\/status\/(\d+)(?:[/?#]|$)/)?.[1] || null;
    const analyticsLink = ownLinks('a[href*="/status/"][href*="/analytics"]')[0];
    const analyticsId = idFromLink(analyticsLink);
    if (analyticsId) return analyticsId;
    const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
      .filter((link) => link.closest('article[data-testid="tweet"]') === article);
    for (const link of links) {
      const id = idFromLink(link);
      // Degraded: no tweetDataStore.has(id) disambiguation; take the first
      // resolvable status link instead of the store-backed one.
      if (id) return id;
    }
    const firstLink = links[0];
    return idFromLink(firstLink);
  }
  function resolveArticleId(art) {
    const injected = (typeof getTweetIdFromArticle === 'function') ? getTweetIdFromArticle
      : (typeof window !== 'undefined' && typeof window.getTweetIdFromArticle === 'function') ? window.getTweetIdFromArticle
      : null;
    return injected ? injected(art) : localIdFromArticle(art);
  }
  // --- end article-id resolution seam ---------------------------------------
  const HIDE_SEL = '[data-xvm-content-filter-hidden], [data-xvm-rate-hidden]';
  const MAX_ANCHORS = 8;
  const POST_GUARD_FEED_MS = 1600; // hard cap only
  const POST_GUARD_HIDE_MS = 2200;
  const QUIET_STABLE_MS = 160; // finish pinning this long after |d|<=24
  const DEFEND_PAD_MS = 400;
  const DEFEND_TAIL_MS = 700; // keep suppressing X after pin loop ends
  const PIN_THRESH = 24;
  const QUIET_THRESH = 96; // same band as REPIN — if we won't move again, finish
  const REPIN_THRESH = 96; // avoid chase from virtualizer height churn
  const REPIN_PERSIST_MS = 90; // drift must persist before re-pin
  // Early coarse while scrollHeight is still rocketing lands in a phantom
  // virtual window. Wait for height to quiet before the single wake.
  const HEIGHT_STABLE_MS = 100;
  const HEIGHT_STABLE_PX = 280;
  const COARSE_FALLBACK_MS = 420; // if height never quiets, wake anyway
  const saved = new Map(); // pageKey -> {y, anchors:[{id,top}], clickTs?}
  let watch = null;
  let recScheduled = false;

  try { history.scrollRestoration = 'manual'; } catch (_) {}

  let defendUntil = 0;
  let allowScroll = false;
  let suppressedScrolls = 0;
  let restoreRun = null;
  const dbgOn = () => !!(typeof window !== 'undefined' && window.__xvmScrollRestoreDebug);
  const dbgGeom = () => {
    const se = document.scrollingElement || document.documentElement;
    const sh = Math.max(
      se?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
    );
    const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
    return {
      scrollY: Math.round(window.scrollY),
      scrollHeight: Math.round(sh),
      scrollMax: Math.max(0, Math.round(sh - vh)),
      vh: Math.round(vh),
    };
  };
  const dbgPush = (type, extra) => {
    if (!dbgOn() || !restoreRun) return;
    const g = dbgGeom();
    const ev = { t: Math.round(performance.now() - restoreRun.t0), type, ...g, ...extra };
    restoreRun.events.push(ev);
    try {
      const log = (window.__xvmScrollRestoreLog = window.__xvmScrollRestoreLog || []);
      log.push({ ...ev, runId: restoreRun.runId });
      if (log.length > 2000) log.splice(0, log.length - 2000);
    } catch (_) {}
  };
  // High-freq (~rAF) height/scroll sampler while a restore is active.
  let hfRaf = 0;
  let hfLastY = null;
  let hfLastDir = 0; // -1 up (Y↓), +1 down (Y↑)
  let hfOsc = [];
  const stopHf = () => {
    if (hfRaf) {
      try { cancelAnimationFrame(hfRaf); } catch (_) {}
      hfRaf = 0;
    }
  };
  const startHf = () => {
    stopHf();
    if (!dbgOn() || !restoreRun) return;
    hfLastY = window.scrollY;
    hfLastDir = 0;
    hfOsc = [];
    restoreRun.hf = restoreRun.hf || [];
    restoreRun.oscillations = restoreRun.oscillations || [];
    const tick = () => {
      if (!restoreRun) { hfRaf = 0; return; }
      const g = dbgGeom();
      const y = g.scrollY;
      const dy = hfLastY == null ? 0 : y - hfLastY;
      const sample = {
        t: Math.round(performance.now() - restoreRun.t0),
        ...g,
        dy,
      };
      const last = restoreRun.hf[restoreRun.hf.length - 1];
      if (!last
          || Math.abs(y - last.scrollY) >= 2
          || Math.abs(g.scrollHeight - last.scrollHeight) >= 8
          || sample.t - last.t >= 48) {
        restoreRun.hf.push(sample);
        if (restoreRun.hf.length > 400) restoreRun.hf.splice(0, restoreRun.hf.length - 400);
      }
      if (Math.abs(dy) >= 48) {
        const dir = dy < 0 ? -1 : 1;
        if (hfLastDir && dir !== hfLastDir) {
          const osc = {
            t: sample.t,
            fromY: Math.round(hfLastY),
            toY: y,
            prevDir: hfLastDir < 0 ? 'up' : 'down',
            nextDir: dir < 0 ? 'up' : 'down',
            scrollMax: g.scrollMax,
            scrollHeight: g.scrollHeight,
          };
          hfOsc.push(osc);
          restoreRun.oscillations.push(osc);
          dbgPush('oscillation', osc);
        }
        hfLastDir = dir;
        hfLastY = y;
      } else if (hfLastY == null) {
        hfLastY = y;
      }
      hfRaf = requestAnimationFrame(tick);
    };
    hfRaf = requestAnimationFrame(tick);
  };
  const natScrollTo = window.scrollTo.bind(window);
  const natScrollBy = window.scrollBy.bind(window);
  const inDefend = () => performance.now() < defendUntil;
  const bumpDefend = (ms) => {
    const until = performance.now() + ms;
    if (until > defendUntil) defendUntil = until;
  };
  const scrollEl = () => document.scrollingElement || document.documentElement;
  function pageScrollHeight() {
    const se = scrollEl();
    return Math.max(
      se?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
    );
  }
  function maxScrollY() {
    const sh = pageScrollHeight();
    const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
    return Math.max(0, sh - vh);
  }
  function canReachY(y) {
    return maxScrollY() >= Math.max(0, Math.round(y)) - 32;
  }
  // Pin/repin: short custom ease (~260ms). Native behavior:"smooth" fights
  // X's virtualizer (cells unload mid-tween). Coarse stays instant. Small
  // deltas snap — smooth only helps the unavoidable deep return hop.
  const EASE_MS = 260;
  const EASE_MIN_DIST = 120; // px; below this, instant is cleaner
  let easeRaf = 0;
  let easeToken = 0;
  let easeTarget = null;
  function cancelEase() {
    if (easeRaf) {
      try { cancelAnimationFrame(easeRaf); } catch (_) {}
      easeRaf = 0;
    }
    easeToken += 1;
    easeTarget = null;
  }
  function forceScrollBehaviorAuto() {
    try {
      const root = document.documentElement;
      if (root && root.style) root.style.scrollBehavior = 'auto';
      if (document.body && document.body.style) document.body.style.scrollBehavior = 'auto';
    } catch (_) {}
  }
  function writeScrollY(y) {
    forceScrollBehaviorAuto();
    const target = Math.max(0, Math.round(y));
    allowScroll = true;
    try {
      natScrollTo(0, target);
      const se = scrollEl();
      if (se && Math.abs((se.scrollTop || 0) - target) > 1) {
        try { se.scrollTop = target; } catch (_) {}
      }
    } finally {
      allowScroll = false;
    }
  }
  function writeScrollYSoft(y) {
    // Intermediate ease frames: prefer scrollTop so we own the tween and
    // do not flood window.scrollTo (tests + X listeners).
    forceScrollBehaviorAuto();
    const target = Math.max(0, Math.round(y));
    allowScroll = true;
    try {
      const se = scrollEl();
      if (se) {
        try { se.scrollTop = target; } catch (_) { natScrollTo(0, target); }
      } else {
        natScrollTo(0, target);
      }
    } finally {
      allowScroll = false;
    }
  }
  function noteControlledMove(kind, target) {
    if (!restoreRun) return;
    restoreRun.jumps += 1;
    if (kind === 'coarse') restoreRun.coarse += 1;
    else if (kind === 'pin' || kind === 'repin') {
      if (restoreRun.firstPinAt == null) restoreRun.firstPinAt = performance.now() - restoreRun.t0;
      if (kind === 'repin') restoreRun.repins += 1;
      else restoreRun.pins += 1;
    }
    restoreRun.lastMoveAt = performance.now() - restoreRun.t0;
    dbgPush(kind || 'scroll', { y: target, scrollY: window.scrollY, max: maxScrollY() });
  }
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function controlledScrollTo(y, kind) {
    const target = Math.max(0, Math.round(y));
    // Refuse clamped coarse: a no-op clamp is still a visible hop to the wrong window.
    if (kind === 'coarse' && !canReachY(target)) {
      dbgPush('coarse_skip_clamp', { y: target, max: maxScrollY(), scrollY: window.scrollY });
      return false;
    }
    const from = window.scrollY;
    const dist = Math.abs(target - from);
    const wantEase = (kind === 'pin' || kind === 'repin') && dist >= EASE_MIN_DIST;

    // Already easing to the same place — coalesce (step() re-calls every frame).
    if (wantEase && easeRaf && easeTarget != null && Math.abs(easeTarget - target) <= 48) {
      return true;
    }

    if (!wantEase) {
      cancelEase();
      writeScrollY(target);
      noteControlledMove(kind, target);
      return true;
    }

    cancelEase();
    easeTarget = target;
    const token = easeToken;
    const t0 = performance.now();
    const startY = from;
    const delta = target - startY;
    noteControlledMove(kind, target);
    bumpDefend(EASE_MS + DEFEND_PAD_MS);
    dbgPush('ease_start', { from: Math.round(startY), to: target, ms: EASE_MS });

    const tick = () => {
      if (token !== easeToken) return;
      const elapsed = performance.now() - t0;
      const t = Math.min(1, elapsed / EASE_MS);
      const yNow = startY + delta * easeOutCubic(t);
      if (t >= 1) {
        easeRaf = 0;
        easeTarget = null;
        writeScrollY(target);
        dbgPush('ease_end', { y: target, scrollY: window.scrollY });
        return;
      }
      writeScrollYSoft(yNow);
      easeRaf = requestAnimationFrame(tick);
    };
    easeRaf = requestAnimationFrame(tick);
    return true;
  }
  window.scrollTo = function (...args) {
    if (inDefend() && !allowScroll) {
      suppressedScrolls += 1;
      if (restoreRun) restoreRun.suppressed += 1;
      dbgPush('suppress_scrollTo');
      return;
    }
    return natScrollTo(...args);
  };
  window.scrollBy = function (...args) {
    if (inDefend() && !allowScroll) {
      suppressedScrolls += 1;
      if (restoreRun) restoreRun.suppressed += 1;
      dbgPush('suppress_scrollBy');
      return;
    }
    return natScrollBy(...args);
  };
  // X sometimes sets scrollingElement.scrollTop directly (bypassing
  // window.scrollTo). Hold the property during defend; our controlled
  // path sets allowScroll first so it still writes.
  (function hookScrollTop() {
    const targets = [];
    try { if (document.documentElement) targets.push(document.documentElement); } catch (_) {}
    try {
      const se = document.scrollingElement;
      if (se && se !== document.documentElement) targets.push(se);
    } catch (_) {}
    for (const el of targets) {
      try {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
          || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'scrollTop');
        if (!desc || !desc.set || el.__xvmScrollTopHooked) continue;
        const rawGet = desc.get.bind(el);
        const rawSet = desc.set.bind(el);
        Object.defineProperty(el, 'scrollTop', {
          configurable: true,
          get() { return rawGet(); },
          set(v) {
            if (inDefend() && !allowScroll) {
              suppressedScrolls += 1;
              if (restoreRun) restoreRun.suppressed += 1;
              dbgPush('suppress_scrollTop');
              return;
            }
            rawSet(v);
          },
        });
        el.__xvmScrollTopHooked = true;
      } catch (_) {}
    }
  })();
  try {
    Object.defineProperty(window, '__xvmScrollRestoreLast', {
      configurable: true,
      get() { return restoreRun ? { ...restoreRun, events: restoreRun.events.slice() } : window.__xvmScrollRestoreFinished || null; },
    });
  } catch (_) {}

  const pageKey = () => {
    const m = window.location.pathname.match(/\/status\/(\d+)/);
    if (m) return m[1];
    let path = window.location.pathname.replace(/\/+$/, '') || '/';
    if (path === '/') path = '/home';
    return path;
  };

  const isFeedKey = (id) => typeof id === 'string' && id.startsWith('/');

  const hadHides = new Set();
  function pageHasHides(id) {
    if (document.querySelector(HIDE_SEL)) {
      if (id) hadHides.add(id);
      return true;
    }
    return id ? hadHides.has(id) : false;
  }

  function shouldArm(id) {
    if (!id) return false;
    if (isFeedKey(id)) return true;
    return pageHasHides(id);
  }

  function isUsableArticle(art) {
    if (!art) return false;
    if (art.matches?.(HIDE_SEL) || art.closest?.(HIDE_SEL)) return false;
    if (art.closest?.('[role="dialog"], [aria-hidden="true"], [hidden], [inert]')) return false;
    const r = art.getBoundingClientRect();
    return r.height > 0 && r.width > 0;
  }

  function feedShellReady(id) {
    if (!isFeedKey(id)) return true;
    const primary = document.querySelector('[data-testid="primaryColumn"]');
    if (!primary) return true;
    if (id === '/home') return !!primary.querySelector('[role="tablist"]');
    return true;
  }

  function expectedDocTop(want, anchorTop) {
    return (want?.y || 0) + (Number.isFinite(anchorTop) ? anchorTop : (want?.anchorTop || 0));
  }

  // Reject detail leftovers / wrong-window cells: their document Y is nowhere
  // near the saved reading position (classic false pin to y≈174).
  function isPlausibleHit(art, want, anchorTop) {
    if (!art || !want) return false;
    const docTop = window.scrollY + art.getBoundingClientRect().top;
    const expected = expectedDocTop(want, anchorTop);
    const slack = Math.max(900, Math.min(2800, Math.abs(want.y) * 0.22 + 500));
    if (Math.abs(docTop - expected) <= slack) return true;
    // Deep save + shallow cell while we still cannot scroll there → leftover.
    if (want.y > (window.innerHeight || 800) && !canReachY(want.y)) {
      if (docTop < (window.innerHeight || 800) * 2) return false;
    }
    return false;
  }

  function collectVisibleAnchors(preferArt) {
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const out = [];
    const seen = new Set();
    const push = (art) => {
      if (!isUsableArticle(art)) return;
      const tid = resolveArticleId(art);
      if (!tid || seen.has(tid)) return;
      seen.add(tid);
      out.push({
        id: tid,
        top: Math.round(art.getBoundingClientRect().top),
      });
    };
    if (preferArt) push(preferArt);
    const fully = [];
    const partial = [];
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (preferArt && art === preferArt) continue;
      if (!isUsableArticle(art)) continue;
      const r = art.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= viewportHeight) continue;
      const tid = resolveArticleId(art);
      if (!tid) continue;
      const entry = { art, top: r.top, tid };
      if (r.top >= 0 && r.bottom <= viewportHeight) fully.push(entry);
      else partial.push(entry);
    }
    fully.sort((a, b) => a.top - b.top);
    partial.sort((a, b) => {
      const score = (t) => (t.top >= 0 ? t.top : viewportHeight + Math.abs(t.top));
      return score(a) - score(b);
    });
    for (const entry of [...fully, ...partial]) {
      if (seen.has(entry.tid)) continue;
      seen.add(entry.tid);
      out.push({ id: entry.tid, top: Math.round(entry.top) });
      if (out.length >= MAX_ANCHORS) break;
    }
    return out.slice(0, MAX_ANCHORS);
  }

  function findAnchorArticle(anchorId, targetTop) {
    if (!anchorId) return null;
    let best = null;
    let bestScore = Infinity;
    for (const art of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (resolveArticleId(art) !== anchorId) continue;
      if (!isUsableArticle(art)) continue;
      const top = art.getBoundingClientRect().top;
      const score = Number.isFinite(targetTop) ? Math.abs(top - targetTop) : 0;
      // Prefer cells whose document position is deeper when multiple copies
      // exist (detail leftover near top vs feed cell).
      const docTop = window.scrollY + top;
      const depthBias = docTop < 400 ? 50 : 0;
      const s = score + depthBias;
      if (s < bestScore) {
        best = art;
        bestScore = s;
      }
    }
    return best;
  }

  function findBestAvailable(want) {
    const list = Array.isArray(want?.anchors) && want.anchors.length
      ? want.anchors
      : (want?.anchorId ? [{ id: want.anchorId, top: want.anchorTop || 0 }] : []);
    // Prefer clicked id (anchors[0]) when plausible; then fallbacks.
    for (const a of list) {
      const art = findAnchorArticle(a.id, a.top);
      if (art && isPlausibleHit(art, want, a.top)) return { art, top: a.top, id: a.id };
    }
    return null;
  }

  document.addEventListener('pointerdown', (e) => {
    if (watch) return;
    const id = pageKey();
    if (!shouldArm(id)) return;
    const art = e.target?.closest?.('article[data-testid="tweet"]');
    if (!art || art.closest('[role="dialog"]')) return;
    if (art.matches(HIDE_SEL) || art.closest(HIDE_SEL)) return;
    const tid = resolveArticleId(art);
    if (!tid) return;
    const anchors = collectVisibleAnchors(art);
    if (!anchors.length) {
      anchors.push({
        id: tid,
        top: Math.round(art.getBoundingClientRect().top),
      });
    }
    saved.set(id, {
      y: Math.round(window.scrollY),
      anchors,
      anchorId: anchors[0].id,
      anchorTop: anchors[0].top,
      clickTs: performance.now(),
    });
  }, true);

  function record() {
    if (recScheduled || watch) return;
    recScheduled = true;
    requestAnimationFrame(() => {
      recScheduled = false;
      if (watch) return;
      const id = pageKey();
      if (!shouldArm(id)) {
        if (id) saved.delete(id);
        return;
      }
      const prev = saved.get(id);
      if (prev && prev.clickTs !== undefined && performance.now() - prev.clickTs < 2000) return;
      const anchors = collectVisibleAnchors(null);
      saved.set(id, {
        y: Math.round(window.scrollY),
        anchors,
        anchorId: anchors[0]?.id || null,
        anchorTop: anchors[0]?.top || 0,
      });
    });
  }
  window.addEventListener('scroll', record, { passive: true });

  function beginRestore(source) {
    const id = pageKey();
    const want = id && saved.get(id);
    if (!want) return;
    const hasHides = pageHasHides(id);
    const needsRepin = hasHides || isFeedKey(id);
    const postGuardMs = hasHides ? POST_GUARD_HIDE_MS : POST_GUARD_FEED_MS;
    if (watch && typeof watch.abort === 'function') {
      try { watch.abort(); } catch (_) {}
    }
    const state = { id, source };
    watch = state;
    const t0 = performance.now();
    if (dbgOn()) {
      restoreRun = {
        runId: Math.round(t0),
        source,
        id,
        t0,
        jumps: 0,
        coarse: 0,
        pins: 0,
        repins: 0,
        suppressed: 0,
        firstPinAt: null,
        lastMoveAt: 0,
        finishedAt: null,
        events: [],
      };
      dbgPush('begin', {
        wantY: want.y,
        max: maxScrollY(),
        canReach: canReachY(want.y),
        anchors: (want.anchors || []).length,
      });
      startHf();
    } else {
      restoreRun = null;
      stopHf();
    }
    bumpDefend(postGuardMs + DEFEND_PAD_MS);
    let lastY = window.scrollY;
    let lastMove = t0;
    let pinned = false;
    let didCoarse = false;
    let stableSince = null;
    let driftSince = null;
    let mo = null;
    const finish = (reason = 'quiet') => {
      if (watch === state) watch = null;
      cancelEase();
      if (mo) {
        try { mo.disconnect(); } catch (_) {}
        mo = null;
      }
      for (const ev of USER_EVENTS) window.removeEventListener(ev, onUserInput);
      // User cancel / hard stop → drop defend. Quiet success → keep
      // suppressing X briefly so its late scrollTo cannot yank us off.
      if (reason === 'user' || reason === 'timeout' || reason === 'hard') {
        defendUntil = 0;
      } else {
        bumpDefend(DEFEND_TAIL_MS);
      }
      if (restoreRun && restoreRun.t0 === t0) {
        restoreRun.finishedAt = performance.now() - t0;
        restoreRun.stableAt = restoreRun.lastMoveAt ?? restoreRun.firstPinAt ?? restoreRun.finishedAt;
        restoreRun.finishReason = reason;
        stopHf();
        const dirs = (restoreRun.oscillations || []).map((o) => `${o.prevDir[0]}>${o.nextDir[0]}`);
        restoreRun.flashPattern = dirs.join('|') || 'none';
        dbgPush('finish', {
          reason,
          jumps: restoreRun.jumps,
          coarse: restoreRun.coarse,
          pins: restoreRun.pins,
          repins: restoreRun.repins,
          suppressed: restoreRun.suppressed,
          firstPinAt: restoreRun.firstPinAt,
          stableAt: restoreRun.stableAt,
          finishedAt: restoreRun.finishedAt,
          defendTailMs: reason === 'user' || reason === 'timeout' || reason === 'hard' ? 0 : DEFEND_TAIL_MS,
          oscillations: (restoreRun.oscillations || []).length,
          flashPattern: restoreRun.flashPattern,
          hfSamples: (restoreRun.hf || []).length,
        });
        try {
          window.__xvmScrollRestoreFinished = {
            ...restoreRun,
            events: restoreRun.events.slice(),
            hf: (restoreRun.hf || []).slice(),
            oscillations: (restoreRun.oscillations || []).slice(),
          };
        } catch (_) {}
        restoreRun = null;
      } else {
        stopHf();
      }
    };
    state.abort = () => finish('hard');
    const USER_EVENTS = ['wheel', 'touchstart', 'mousedown', 'keydown'];
    const SCROLL_KEYS = new Set([
      'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Space',
    ]);
    const onUserInput = (e) => {
      if (e.type === 'wheel' && Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      if (e.type === 'keydown') {
        const key = e.key || e.code;
        if (!SCROLL_KEYS.has(key)) return;
      }
      finish('user');
    };
    for (const ev of USER_EVENTS) window.addEventListener(ev, onUserInput, { passive: true });

    const applyPin = (hit, d, now) => {
      const thresh = pinned ? REPIN_THRESH : PIN_THRESH;
      if (Math.abs(d) > thresh) {
        if (pinned) {
          if (driftSince == null) driftSince = now;
          if (now - driftSince < REPIN_PERSIST_MS) {
            dbgPush('repin_wait', { d, waited: Math.round(now - driftSince) });
            return false;
          }
        }
        controlledScrollTo(window.scrollY + d, pinned ? 'repin' : 'pin');
        lastY = window.scrollY;
        lastMove = now;
        stableSince = null;
        driftSince = null;
        bumpDefend(DEFEND_PAD_MS + 200);
        pinned = true;
        return true;
      }
      driftSince = null;
      if (restoreRun && restoreRun.firstPinAt == null) {
        restoreRun.firstPinAt = now - restoreRun.t0;
        restoreRun.pins += 1;
        dbgPush('pin_noop', { d, id: hit.id });
      }
      if (stableSince == null) stableSince = now;
      pinned = true;
      return true;
    };
    const tryPinNow = () => {
      if (!feedShellReady(id)) return false;
      const hit = findBestAvailable(want);
      if (!hit) return false;
      const d = hit.art.getBoundingClientRect().top - hit.top;
      return applyPin(hit, d, performance.now());
    };

    // Height-stability tracker: avoid coarse into a still-growing virtual list.
    let lastSh = pageScrollHeight();
    let shQuietSince = t0;
    const noteHeight = (now) => {
      const sh = pageScrollHeight();
      if (Math.abs(sh - lastSh) >= HEIGHT_STABLE_PX) {
        lastSh = sh;
        shQuietSince = now;
        dbgPush('height_grow', { sh, max: maxScrollY() });
        return false;
      }
      lastSh = sh;
      return (now - shQuietSince) >= HEIGHT_STABLE_MS;
    };
    const mayCoarse = (now) => {
      if (didCoarse) return false;
      if (!canReachY(want.y)) return false;
      if (Math.abs(window.scrollY - want.y) <= PIN_THRESH) return false;
      const quiet = noteHeight(now);
      const waited = now - t0;
      // Prefer quiet height; fall back so we never stall forever.
      return quiet || waited >= COARSE_FALLBACK_MS;
    };

    // First paint: pin if plausible anchor ready. Never coarse on the
    // first frame — height is almost always mid-growth right after Back.
    if (!tryPinNow()) {
      dbgPush('wait_anchor', { scrollY: window.scrollY, max: maxScrollY(), wantY: want.y, sh: lastSh });
    }

    if (needsRepin && typeof MutationObserver === 'function') {
      try {
        mo = new MutationObserver(() => {
          if (watch !== state) return;
          lastMove = performance.now();
        });
        mo.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [
            'data-xvm-rate-hidden',
            'data-xvm-content-filter-hidden',
            'data-xvm-rate-filter-on',
            'style',
            'class',
          ],
        });
      } catch (_) {
        mo = null;
      }
    }

    const step = () => {
      if (watch !== state) return;
      const now = performance.now();
      const y = window.scrollY;
      if (Math.abs(y - lastY) > 1) {
        lastY = y;
        lastMove = now;
      }
      if (now - t0 > 5000) return finish('timeout');

      bumpDefend(Math.max(0, postGuardMs - (now - t0)) + DEFEND_PAD_MS);

      // Keep height tracker warm every frame (also while shell not ready).
      noteHeight(now);

      if (!feedShellReady(id)) {
        if (mayCoarse(now)) {
          if (controlledScrollTo(want.y, 'coarse')) {
            didCoarse = true;
            lastY = window.scrollY;
            lastMove = now;
            shQuietSince = now;
            lastSh = pageScrollHeight();
          }
        }
        if (now - t0 > 3500) return finish('timeout');
        requestAnimationFrame(step);
        return;
      }

      const hit = findBestAvailable(want);
      if (hit) {
        const d = hit.art.getBoundingClientRect().top - hit.top;
        applyPin(hit, d, now);
        // Quiet early-exit after a good pin. Pending repin_wait delays exit.
        if (pinned && driftSince == null && stableSince != null
            && now - stableSince >= QUIET_STABLE_MS && Math.abs(d) <= QUIET_THRESH) {
          return finish('quiet');
        }
        if (pinned && driftSince == null && now - t0 > postGuardMs && Math.abs(d) <= QUIET_THRESH) {
          return finish('cap');
        }
      } else {
        driftSince = null;
        // Virtualizer height churn often unmounts the cell for a frame after
        // a good pin. Keep stableSince if we are still near the saved Y so
        // quiet-exit can fire.
        const nearWant = Math.abs(y - want.y) <= Math.max(PIN_THRESH * 5, 140);
        if (!(pinned && nearWant)) stableSince = null;
        else if (stableSince == null) stableSince = now;
        if (pinned && nearWant && stableSince != null
            && now - stableSince >= QUIET_STABLE_MS) {
          return finish('quiet_near');
        }
        // Prefer pin when the cell is mounted. Otherwise one coarse wake
        // only after height has quieted (or fallback timeout). Never coarse
        // again after a successful pin.
        if (tryPinNow()) {
          lastY = window.scrollY;
          lastMove = now;
        } else if (!pinned && mayCoarse(now)) {
          if (controlledScrollTo(want.y, 'coarse')) {
            didCoarse = true;
            lastY = window.scrollY;
            lastMove = now;
            shQuietSince = now;
            lastSh = pageScrollHeight();
          }
        }
        if (now - t0 > 3500) return finish('timeout');
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  window.addEventListener('popstate', () => beginRestore('popstate'));
  window.addEventListener('pageshow', (e) => {
    if (e && e.persisted) beginRestore('bfcache');
  });
})();