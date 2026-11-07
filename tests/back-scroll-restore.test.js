// Back-navigation scroll-restore guard (content.js tail IIFE).
//
// Live-verified failure: on a conversation page with XVM-hidden replies,
// X's back-navigation restore loop compounds its relative scrollBy deltas
// (2 hidden cells: saved y≈1900 → settles ≈4534; 15 hidden cells: X issues
// the same +1171 delta 17× and lands ~500px off with the clicked reply
// above the viewport). The same failure hits home/list/profile → tweet →
// back when rate-filter / content-filter hides re-collapse on remount —
// AND on unfiltered deep home scrolls where X's virtual list remounts the
// wrong window (ad-prune does not arm via hides, but native restore is
// still insufficient). Feeds always arm on tweet click; conversations
// only when XVM hides are/were present. The guard records the true
// reading position per pageKey — most precisely at pointerdown on the
// tweet being opened, plus up to 8 visible fallbacks — and corrects,
// anchor-first. Only Back (popstate / BFCache pageshow) restores; feeds
// keep a short silent post-pin guard for late media layout (no blank
// veil, no viewport freeze overlay — UX first). During restore,
// window.scrollTo/scrollBy from X are suppressed (x-no-scroll seam); we
// pin via controlledScrollTo (short custom ease for large pin/repin) after
// waiting for a plausible anchor (at most one coarse wake if height can
// reach want.y). These tests run the
// extracted guard against a scripted fake DOM/clock.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const content = readFileSync(resolve(repo, 'lib/scroll-restore-guard.js'), 'utf8');
const MARKER = '// Back-navigation scroll-restore guard.';
const guardSrc = content.slice(content.indexOf(MARKER));

const HIDE_SEL = '[data-xvm-content-filter-hidden], [data-xvm-rate-hidden]';

function makeArticle(h, { docTop, id, hiddenAttrs = false }) {
  const art = {
    id,
    docTop,
    hiddenAttrs,
    matches: (sel) => {
      if (sel === HIDE_SEL) return false;
      return false;
    },
    closest: (sel) => {
      if (sel === 'article[data-testid="tweet"]') return art;
      if (sel === '[role="dialog"]') return null;
      if (sel === HIDE_SEL) return null;
      if (sel === '[role="dialog"], [aria-hidden="true"], [hidden], [inert]') {
        return art.hiddenAttrs ? {} : null;
      }
      return null;
    },
    getBoundingClientRect: () => ({
      top: art.docTop - h.scrollY,
      bottom: art.docTop - h.scrollY + art.height,
      height: art.height,
      width: art.width,
    }),
    height: 100,
    width: 400,
  };
  return art;
}

function makeHarness({ hiddenPresent = true, homeShellReady = true } = {}) {
  const winListeners = new Map();
  const docListeners = new Map();
  let rafQ = [];
  const observers = [];
  const h = {
    clock: 0,
    scrollY: 0,
    scrollToCalls: [],
    hiddenPresent,
    homeShellReady,
    articles: [],
    scrollRestoration: 'auto',
    // Tall page by default so canReachY(want.y) allows coarse when needed.
    scrollHeight: 50000,
  };
  const listen = (map) => (ev, fn) => {
    if (!map.has(ev)) map.set(ev, []);
    map.get(ev).push(fn);
  };
  const unlisten = (map) => (ev, fn) => {
    const l = map.get(ev) || [];
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  };
  h.pathname = '/someone/status/111';
  const win = {
    location: { get pathname() { return h.pathname; } },
    get scrollY() { return h.scrollY; },
    scrollTo(x, y) { h.scrollToCalls.push(Math.round(y)); h.scrollY = y; },
    scrollBy(x, y) { h.scrollToCalls.push(Math.round(h.scrollY + y)); h.scrollY = h.scrollY + y; },
    addEventListener: listen(winListeners),
    removeEventListener: unlisten(winListeners),
    innerHeight: 800,
    innerWidth: 1200,
  };
  h.styleEls = new Map();
  const primaryColumn = {
    querySelector: (sel) => (sel === '[role="tablist"]' && h.homeShellReady ? {} : null),
    querySelectorAll: (sel) => (sel === 'img' ? [] : []),
    getBoundingClientRect: () => ({ top: 53, left: 200, right: 800, bottom: 800, width: 600, height: 747 }),
    style: {
      cssText: '',
      props: {},
      setProperty(k, v) { this.props[k] = v; },
      removeProperty(k) { delete this.props[k]; },
    },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    cloneNode: () => {
      const clone = {
        style: { cssText: '' },
        remove() {},
      };
      clone.querySelectorAll = () => {
        const list = [];
        list.forEach = Array.prototype.forEach;
        return list;
      };
      h.lastFreezeClone = clone;
      return clone;
    },
  };
  h.freezeMounted = [];
  h.primaryColumn = primaryColumn;
  const doc = {
    querySelector: (sel) => {
      if (sel === HIDE_SEL) return h.hiddenPresent ? {} : null;
      if (sel === '[data-testid="primaryColumn"] [role="tablist"]') {
        return h.homeShellReady ? {} : null;
      }
      if (sel === '[data-testid="primaryColumn"]') return primaryColumn;
      if (sel === '[data-testid="primaryColumn"][data-xvm-freeze-hidden]') {
        return primaryColumn.attrs?.['data-xvm-freeze-hidden'] ? primaryColumn : null;
      }
      if (sel === '#xvm-feed-freeze' || sel === '[data-xvm-feed-freeze]') {
        return h.styleEls.get('xvm-feed-freeze') || null;
      }
      return null;
    },
    querySelectorAll: (sel) => (sel === 'article[data-testid="tweet"]' ? h.articles : []),
    addEventListener: listen(docListeners),
    removeEventListener: unlisten(docListeners),
    getElementById: (id) => h.styleEls.get(id) || null,
    createElement: () => {
      const el = {
        id: '',
        textContent: '',
        style: { cssText: '', setProperty() {}, removeProperty() {} },
        attrs: {},
        children: [],
        setAttribute(k, v) { el.attrs[k] = v; },
        getAttribute(k) { return el.attrs[k]; },
        appendChild(c) { el.children.push(c); return c; },
        remove() { h.styleEls.delete(el.id); h.freezeMounted = h.freezeMounted.filter((x) => x !== el); },
      };
      return el;
    },
    documentElement: {
      appendChild: (el) => {
        h.styleEls.set(el.id, el);
        if (el && el.id === 'xvm-feed-freeze') h.freezeMounted.push(el);
        return el;
      },
      clientHeight: 800,
      clientWidth: 1200,
      get scrollHeight() { return h.scrollHeight; },
      get scrollTop() { return h.scrollY; },
      set scrollTop(v) { h.scrollY = v; },
    },
    body: {
      get scrollHeight() { return h.scrollHeight; },
    },
    get scrollingElement() {
      return {
        get scrollTop() { return h.scrollY; },
        set scrollTop(v) { h.scrollY = v; },
        get scrollHeight() { return h.scrollHeight; },
      };
    },
  };
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() {
      const i = observers.indexOf(this);
      if (i >= 0) observers.splice(i, 1);
    }
  }
  const historyObj = {
    get scrollRestoration() { return h.scrollRestoration; },
    set scrollRestoration(v) { h.scrollRestoration = v; },
  };
  const ctx = {
    window: win,
    document: doc,
    history: historyObj,
    performance: { now: () => h.clock },
    requestAnimationFrame: (cb) => { rafQ.push(cb); return rafQ.length; },
    cancelAnimationFrame: () => { /* token-guarded ease; clearing all would kill step() */ },
    getTweetIdFromArticle: (art) => art.id || null,
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }),
    setTimeout: (fn) => { h.pendingTimeouts.push(fn); return h.pendingTimeouts.length; },
    clearTimeout: () => {},
    MutationObserver: FakeMutationObserver,
    Math,
    Map,
    Set,
    Infinity,
    Number,
    Array,
  };
  h.pendingTimeouts = [];
  vm.createContext(ctx);
  vm.runInContext(guardSrc, ctx);
  h.fire = (ev, detail = {}) => {
    for (const fn of [...(winListeners.get(ev) || [])]) fn({ type: ev, ...detail });
  };
  h.firePointerDown = (art) => {
    for (const fn of [...(docListeners.get('pointerdown') || [])]) {
      fn({ target: { closest: (sel) => (sel === 'article[data-testid="tweet"]' ? art : null) } });
    }
  };
  h.fireMutations = () => {
    for (const ob of [...observers]) ob.cb([]);
  };
  // One frame ≈ 16ms: advance the clock, then run everything queued.
  h.pumpFrames = (n) => {
    for (let i = 0; i < n; i++) {
      h.clock += 16;
      const q = rafQ;
      rafQ = [];
      for (const cb of q) cb();
    }
  };
  h.win = win;
  return h;
}

function recordAt(h, y) {
  h.scrollY = y;
  h.fire('scroll');
  h.pumpFrames(1); // record() commits on the next animation frame
}

describe('back-navigation scroll-restore guard', () => {
  it('sets history.scrollRestoration to manual', () => {
    const h = makeHarness();
    expect(h.scrollRestoration).toBe('manual');
  });

  it('corrects X\'s compounded restore back to the recorded anchor position', () => {
    const h = makeHarness();
    h.articles = [makeArticle(h, { docTop: 1916, id: 'A222' })];
    recordAt(h, 1900); // reading position: anchor A222 at viewport top 16

    // X's broken restore lands ~2600px past the reading position and stays.
    h.scrollY = 4534;
    h.fire('popstate');
    h.pumpFrames(60); // allow pin + short post-guard

    // Anchor delta: top −2618 vs saved 16 → scrollTo(4534 − 2634) = 1900.
    expect(h.scrollToCalls).toContain(1900);
    expect(h.scrollY).toBe(1900);
  });

  it('prefers the tweet captured at pointerdown over scroll samples', () => {
    const h = makeHarness();
    const clicked = makeArticle(h, { docTop: 1424, id: 'B333' });
    h.articles = [makeArticle(h, { docTop: 1916, id: 'A222' }), clicked];
    h.scrollY = 1224;
    h.firePointerDown(clicked); // user clicks B333 at viewport top 200
    // X's pre-navigation scrollIntoView churn fires scroll events that
    // would otherwise overwrite the click capture with junk geometry.
    recordAt(h, 534);

    h.scrollY = 1731; // X settles ~500px off (live 15-hidden-cell trace)
    h.fire('popstate');
    h.pumpFrames(60);

    // B333 back at viewport top 200 → scrollTo… = 1224.
    expect(h.scrollY).toBe(1224);
  });

  it('fixes small errors the raw-offset check would tolerate', () => {
    const h = makeHarness();
    h.articles = [makeArticle(h, { docTop: 1916, id: 'A222' })];
    recordAt(h, 1900);

    h.scrollY = 1990; // only 90px off in scrollY, but wrong content on screen
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollY).toBe(1900);
  });

  it('leaves a pixel-accurate restore alone', () => {
    const h = makeHarness();
    h.articles = [makeArticle(h, { docTop: 1916, id: 'A222' })];
    recordAt(h, 1900);

    h.scrollY = 1912; // anchor delta 12px — within tolerance
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollToCalls).toEqual([]);
  });

  it('falls back to the raw saved offset when the anchor is collapsed', () => {
    const h = makeHarness();
    const art = makeArticle(h, { docTop: 1916, id: 'A222' });
    h.articles = [art];
    recordAt(h, 1900);

    art.height = 0; // anchor got filtered/collapsed after recording
    h.scrollY = 4534;
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollToCalls).toContain(1900); // scrollTo(want.y)
  });

  it('records nothing on conversation pages without XVM-hidden cells', () => {
    const h = makeHarness({ hiddenPresent: false });
    const art = makeArticle(h, { docTop: 1916, id: 'A222' });
    h.articles = [art];
    h.scrollY = 1900;
    h.firePointerDown(art);
    recordAt(h, 1900);

    h.scrollY = 4534;
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollToCalls).toEqual([]); // guard never interferes
  });

  it('a user scroll gesture cancels the pending correction', () => {
    const h = makeHarness();
    const art = makeArticle(h, { docTop: 1916, id: 'A222' });
    h.articles = [art];
    recordAt(h, 1900);

    h.scrollY = 4534;
    h.fire('popstate');
    // Ease pin in flight — cancel before it finishes / re-pins.
    h.pumpFrames(2);
    expect(h.scrollY).not.toBe(4534); // already tweening toward anchor
    h.fire('wheel', { deltaX: 0, deltaY: 120 });
    const yAfterCancel = h.scrollY;
    const callsAfterCancel = h.scrollToCalls.length;
    art.docTop = 3200; // would need a large re-pin if watch were still live
    h.fireMutations();
    h.pumpFrames(60);

    expect(h.scrollToCalls.length).toBe(callsAfterCancel);
    expect(h.scrollY).toBe(yAfterCancel);
  });

  it('inertial swipe-back wheel events (deltaX-dominant) do not cancel it', () => {
    const h = makeHarness();
    h.articles = [makeArticle(h, { docTop: 1916, id: 'A222' })];
    recordAt(h, 1900);

    h.scrollY = 4534;
    h.fire('popstate');
    h.pumpFrames(5);
    h.fire('wheel', { deltaX: -48, deltaY: 3 }); // two-finger back gesture tail
    h.pumpFrames(60);

    expect(h.scrollY).toBe(1900);
  });

  it('non-scroll keydown does not cancel; ArrowDown does', () => {
    const h = makeHarness();
    h.articles = [makeArticle(h, { docTop: 1916, id: 'A222' })];
    recordAt(h, 1900);

    h.scrollY = 4534;
    h.fire('popstate');
    h.pumpFrames(5);
    h.fire('keydown', { key: 'a' }); // typing — ignore
    h.pumpFrames(40);
    expect(h.scrollY).toBe(1900);

    // Fresh restore; scroll key cancels after the immediate coarse wake.
    h.scrollY = 4534;
    h.fire('popstate');
    expect(h.scrollToCalls).toContain(1900);
    const callsAfterCoarse = h.scrollToCalls.length;
    h.pumpFrames(2);
    h.fire('keydown', { key: 'ArrowDown' });
    const art = h.articles[0];
    art.docTop = 3200;
    h.fireMutations();
    h.pumpFrames(60);
    expect(h.scrollToCalls.length).toBe(callsAfterCoarse); // cancelled — no fine re-pin
  });

  it('does not blank the feed with a restore veil or freeze overlay', () => {
    const h = makeHarness();
    h.articles = [makeArticle(h, { docTop: 1916, id: 'A222' })];
    recordAt(h, 1900);

    h.scrollY = 4534;
    h.fire('popstate');
    expect(h.styleEls.get('xvm-restore-veil')).toBeFalsy();
    expect(h.styleEls.has('xvm-feed-freeze')).toBe(false);

    h.pumpFrames(60); // settle → silent pin, feed stays visible
    expect(h.scrollY).toBe(1900);
    expect(h.styleEls.get('xvm-restore-veil')).toBeFalsy();
    expect(h.styleEls.has('xvm-feed-freeze')).toBe(false);
  });

  it('keeps working after the virtualizer unmounts every hidden cell', () => {
    const h = makeHarness();
    const art = makeArticle(h, { docTop: 1916, id: 'A222' });
    h.articles = [art];
    recordAt(h, 500); // markers mounted here — status remembered in hadHides

    h.hiddenPresent = false; // reading far away: markers virtualized out
    h.scrollY = 1224;
    h.firePointerDown(art); // click capture must still record…
    recordAt(h, 1900); // …and scroll samples must not erase it… (clickTs shield)
    h.pumpFrames(130); // …but after the shield lapses they may refresh it

    recordAt(h, 1900);
    h.scrollY = 4534;
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollY).toBe(1900); // corrected despite zero mounted markers
  });

  it('restores home timeline position after tweet → back when rate-filter hides are present', () => {
    const h = makeHarness();
    h.pathname = '/home';
    const clicked = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [
      makeArticle(h, { docTop: 1000, id: 'H111' }),
      clicked,
      makeArticle(h, { docTop: 1800, id: 'H999' }),
    ];
    h.scrollY = 1224;
    h.firePointerDown(clicked); // click H777 at viewport top 200

    // Simulate leaving for the status page (URL changes; save must survive
    // under the /home key, not the status id).
    h.pathname = '/someone/status/H777';
    h.scrollY = 0;
    // Returning via back: popstate fires with /home already restored.
    h.pathname = '/home';
    h.scrollY = 3100; // X + rate-filter remount landed far from the click
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollY).toBe(1224);
  });

  it('normalizes "/" to the same key as "/home"', () => {
    const h = makeHarness();
    h.pathname = '/';
    const clicked = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [clicked];
    h.scrollY = 1224;
    h.firePointerDown(clicked);

    h.pathname = '/home'; // X often canonicalizes to /home on return
    h.scrollY = 3100;
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollY).toBe(1224);
  });

  it('arms on home even without XVM hides and restores the clicked tweet', () => {
    // Deep home → status → back still jumps with filters OFF (X virtual
    // list remount). Feeds always keep a click-anchor; no hide markers
    // required.
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art); // click H777 at viewport top 200

    h.pathname = '/someone/status/H777';
    h.scrollY = 0;
    h.pathname = '/home';
    h.scrollY = 3100; // X landed far from the click
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollY).toBe(1224);
    expect(Math.round(art.getBoundingClientRect().top)).toBe(200);
  });

  it('unfiltered home re-pins late layout during quiet window (then early-exits)', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art);

    h.scrollY = 3100;
    h.fire('popstate');
    h.pumpFrames(20); // ease pin lands (~260ms)
    expect(h.scrollY).toBe(1224);

    // Media layout inside the quiet window still re-pins (also eased).
    art.docTop = 1100;
    h.fireMutations();
    h.pumpFrames(25);
    expect(h.scrollY).toBe(900);
    expect(Math.round(art.getBoundingClientRect().top)).toBe(200);
  });

  it('re-pins when layout shifts after the first correction (late rate-filter remount)', () => {
    const h = makeHarness();
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art); // saved anchorTop = 200

    h.scrollY = 3100;
    h.fire('popstate');
    h.pumpFrames(20); // ease pin lands
    expect(h.scrollY).toBe(1224);

    // Rate-filter collapses cells above: anchor slides without a scroll event.
    art.docTop = 1100;
    h.fireMutations();
    h.pumpFrames(25);

    expect(h.scrollY).toBe(900);
    expect(Math.round(art.getBoundingClientRect().top)).toBe(200);
  });

  it('waits for a late-mounted anchor instead of finishing on raw scrollY proximity', () => {
    const h = makeHarness();
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = []; // virtualized out on return
    h.scrollY = 1224;
    h.firePointerDown(art);

    // X lands near the saved offset but showing the wrong region — must
    // not finish on |y - want.y| proximity alone.
    h.scrollY = 1300;
    h.fire('popstate');
    h.pumpFrames(40);
    expect(h.scrollToCalls).toContain(1224); // coarse jump to want.y
    expect(h.scrollY).toBe(1224);

    // Anchor finally mounts after rate-filter remount.
    art.docTop = 2000; // top = 2000-1224 = 776; want 200 → delta 576
    h.articles = [art];
    h.fireMutations();
    h.pumpFrames(40);

    expect(h.scrollY).toBe(1800); // 1224 + (776-200)
    expect(Math.round(art.getBoundingClientRect().top)).toBe(200);
  });

  it('falls back to a secondary visible anchor when the clicked tweet remounts late', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const clicked = makeArticle(h, { docTop: 1424, id: 'H777' });
    const nearby = makeArticle(h, { docTop: 1600, id: 'H888' });
    h.articles = [clicked, nearby];
    h.scrollY = 1224;
    h.firePointerDown(clicked); // anchors: H777@200, H888@376

    // Clicked tweet still virtualized out; nearby is mounted.
    h.articles = [nearby];
    nearby.docTop = 1600;
    h.scrollY = 3100;
    h.fire('popstate');
    h.pumpFrames(60);

    // Pin H888 back to saved top 376 → scrollY = 1600 - 376 = 1224.
    expect(h.scrollY).toBe(1224);
    expect(Math.round(nearby.getBoundingClientRect().top)).toBe(376);
  });

  it('skips aria-hidden leftover detail copies of the same tweet id', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const real = makeArticle(h, { docTop: 1424, id: 'H777' });
    const leftover = makeArticle(h, { docTop: 50, id: 'H777', hiddenAttrs: true });
    h.articles = [real];
    h.scrollY = 1224;
    h.firePointerDown(real);

    // On return both nodes exist; leftover is aria-hidden (detail shell).
    h.articles = [leftover, real];
    h.scrollY = 3100;
    h.fire('popstate');
    h.pumpFrames(60);

    expect(h.scrollY).toBe(1224);
    expect(Math.round(real.getBoundingClientRect().top)).toBe(200);
  });



  it('defers coarse until scrollHeight stops surging (avoids phantom-window flash)', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    // Start short — cannot reach — then surge like live Back (1k→14k→26k).
    h.scrollHeight = 2000;
    const art = makeArticle(h, { docTop: 8424, id: 'DEEP1' });
    h.articles = [];
    h.scrollY = 8224;
    h.firePointerDown(art); // want.y ≈ 8224

    h.scrollY = 10;
    h.fire('popstate');

    // Height becomes reachable but is still surging: must NOT coarse yet.
    h.scrollHeight = 14000;
    h.pumpFrames(3); // ~48ms < HEIGHT_STABLE_MS
    expect(h.scrollToCalls).not.toContain(8224);
    expect(h.scrollY).toBe(10);

    // Keep surging.
    h.scrollHeight = 20000;
    h.pumpFrames(3);
    expect(h.scrollToCalls).not.toContain(8224);

    // Plateau: after ~100ms quiet, one coarse wake into the stable window.
    h.pumpFrames(10); // ~160ms quiet at 20000
    expect(h.scrollToCalls).toContain(8224);
    expect(h.scrollY).toBe(8224);

    // Real cell mounts → fine pin (noop or small).
    art.docTop = 8424;
    h.articles = [art];
    h.fireMutations();
    h.pumpFrames(20);
    expect(Math.round(art.getBoundingClientRect().top)).toBe(200);
  });

  it('skips coarse when scrollMax cannot reach saved Y (no clamped hop)', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    h.scrollHeight = 1200; // maxScrollY = 1200-800 = 400 ≪ want.y
    const art = makeArticle(h, { docTop: 8424, id: 'DEEP1' });
    h.articles = [art];
    h.scrollY = 8224;
    h.firePointerDown(art); // want.y=8224, top=200

    h.articles = []; // virtualized out
    h.scrollY = 300;
    h.fire('popstate');
    h.pumpFrames(10);
    // Must NOT coarse-clamp to a wrong window.
    expect(h.scrollToCalls).not.toContain(8224);
    expect(h.scrollY).toBe(300);

    // Height grows + real cell mounts → one fine pin.
    h.scrollHeight = 20000;
    art.docTop = 8424;
    h.articles = [art];
    h.fireMutations();
    h.pumpFrames(30);
    expect(Math.round(art.getBoundingClientRect().top)).toBe(200);
    expect(h.scrollY).toBe(8224);
  });

  it('rejects near-top implausible match while saved position is deep', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    h.scrollHeight = 1500; // cannot reach deep want yet
    const real = makeArticle(h, { docTop: 8424, id: 'DEEP2' });
    // Visible "leftover" copy near top with SAME id but not aria-hidden yet.
    const fake = makeArticle(h, { docTop: 350, id: 'DEEP2' });
    h.articles = [real];
    h.scrollY = 8224;
    h.firePointerDown(real);

    h.articles = [fake];
    h.scrollY = 174;
    h.fire('popstate');
    h.pumpFrames(15);
    // Must NOT pin to the near-top false match.
    expect(h.scrollY).toBe(174);

    h.scrollHeight = 20000;
    real.docTop = 8424;
    h.articles = [real];
    h.fireMutations();
    h.pumpFrames(30);
    expect(h.scrollY).toBe(8224);
    expect(Math.round(real.getBoundingClientRect().top)).toBe(200);
  });

  it('waits for Home tablist before pinning (avoids detail leftover)', () => {
    const h = makeHarness({ hiddenPresent: false, homeShellReady: false });
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art);

    h.scrollY = 3100;
    h.fire('popstate');
    h.pumpFrames(40);
    // Coarse jump only while shell missing — may reach want.y but must not
    // finish+stop before tablist; article at wrong place until shell ready.
    expect(h.scrollToCalls).toContain(1224);

    // Tablist appears; now pin to anchor offset.
    art.docTop = 2000; // still wrong region until pin
    h.homeShellReady = true;
    h.fireMutations();
    h.pumpFrames(40);
    expect(h.scrollY).toBe(1800); // 2000 - 200
    expect(Math.round(art.getBoundingClientRect().top)).toBe(200);
  });

  it('restores on BFCache pageshow(persisted) as well as popstate', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art);

    h.scrollY = 3100;
    h.fire('pageshow', { persisted: true });
    h.pumpFrames(60);
    expect(h.scrollY).toBe(1224);
  });


  it('suppresses X window.scrollTo during the restore defend window', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art);

    h.scrollY = 3100;
    h.fire('popstate');
    // Ease pin to 1224, then confirm X cannot yank during defend.
    h.pumpFrames(20);
    expect(h.scrollY).toBe(1224);
    const callsAfterPin = h.scrollToCalls.length;

    // X's broken restore tries to yank us away — must be ignored while defending.
    h.win.scrollTo(0, 9999);
    h.win.scrollBy(0, 500);
    expect(h.scrollY).toBe(1224);
    expect(h.scrollToCalls.length).toBe(callsAfterPin);

    h.pumpFrames(20);
    expect(h.scrollY).toBe(1224);
  });

  it('pins once when anchor is mounted — no multi-hop settle chain', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art);

    h.scrollY = 3100;
    h.fire('popstate');
    // Large pin starts a short custom ease (intermediates via scrollTop).
    expect(h.scrollToCalls).toEqual([]);
    expect(h.scrollY).toBe(3100);

    h.pumpFrames(20); // ~320ms > EASE_MS — final snap via window.scrollTo
    expect(h.scrollToCalls).toEqual([1224]);
    expect(h.scrollY).toBe(1224);

    h.pumpFrames(30);
    // Post-guard micro-adjusts only if layout shifts; none here → no extra hops.
    expect(h.scrollToCalls).toEqual([1224]);
  });

  it('does not restore on pageshow when not from BFCache', () => {

    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const art = makeArticle(h, { docTop: 1424, id: 'H777' });
    h.articles = [art];
    h.scrollY = 1224;
    h.firePointerDown(art);

    h.scrollY = 3100;
    h.fire('pageshow', { persisted: false });
    h.pumpFrames(60);
    expect(h.scrollToCalls).toEqual([]);
    expect(h.scrollY).toBe(3100);
  });

  it('does not mount a viewport freeze overlay on Back', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const clicked = makeArticle(h, { docTop: 12200, id: 'F999' });
    h.articles = [clicked];
    h.scrollY = 12000;
    h.firePointerDown(clicked);

    h.scrollY = 200; // X remount near top
    h.fire('popstate');
    expect(h.styleEls.has('xvm-feed-freeze')).toBe(false);
    expect(h.freezeMounted.length).toBe(0);
    expect(h.styleEls.get('xvm-restore-veil')).toBeFalsy();

    // Mount the real anchor and let pin settle — one fine pin, no cover UI.
    h.articles = [makeArticle(h, { docTop: 12200, id: 'F999' })];
    h.pumpFrames(40);

    expect(h.scrollY).toBe(12000);
    expect(h.styleEls.has('xvm-feed-freeze')).toBe(false);
  });

  it('cancels restore on user wheel without any freeze overlay', () => {
    const h = makeHarness({ hiddenPresent: false });
    h.pathname = '/home';
    const clicked = makeArticle(h, { docTop: 5100, id: 'G111' });
    h.articles = [clicked];
    h.scrollY = 5000;
    h.firePointerDown(clicked);

    h.scrollY = 100;
    h.fire('popstate');
    expect(h.styleEls.has('xvm-feed-freeze')).toBe(false);

    h.fire('wheel', { deltaY: 40, deltaX: 0 });
    expect(h.styleEls.has('xvm-feed-freeze')).toBe(false);
    const callsAfterCancel = h.scrollToCalls.length;
    h.articles = [makeArticle(h, { docTop: 5100, id: 'G111' })];
    h.pumpFrames(40);
    expect(h.scrollToCalls.length).toBe(callsAfterCancel);
  });

});
