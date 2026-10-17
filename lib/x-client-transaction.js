// Use X's own transaction generator. Its obfuscated animation/fingerprint logic
// changes independently of the public algorithm ports. Loading the current
// ondemand.s through X's webpack runtime keeps signatures tied to this page's
// bundle, without eval, hard-coded module IDs, or captured Grok UI requests.
(() => {
  if (window.__xvmXct) return;
  let buildingPromise = null;
  let frameHost = null;
  let parkedFrames = null;
  let preparedFrames = [];

  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  document.querySelectorAll = function (selector, ...args) {
    const found = originalQuerySelectorAll(selector, ...args);
    const next = framesForSelector(selector, found, preparedFrames);
    return next === found ? found : next;
  };
  const FRAME_SELECTOR = '[id^="loading-x-anim-"]';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function getRuntime(chunks) {
    let runtime;
    const entry = [[`xvm-xct-${crypto.randomUUID()}`], {}, (r) => { runtime = r; }];
    chunks.push(entry);
    const index = chunks.indexOf(entry);
    if (index >= 0) chunks.splice(index, 1);
    if (typeof runtime !== 'function' || typeof runtime.e !== 'function') {
      throw new Error('xct: X webpack runtime unavailable; refresh X and retry');
    }
    return runtime;
  }

  // Recreate only the SVG geometry required by the native generator, never
  // scripts, styles, links or event attributes from the fetched HTML.
  function nodeChildren(node) {
    if (node?.childNodes) return Array.from(node.childNodes);
    return node?.children || [];
  }

  function isTextNode(node) {
    return node?.nodeType === 3 || node?.tag === '#text';
  }

  function attrList(node) {
    if (node?.attributes && typeof node.attributes[Symbol.iterator] === 'function' && !node.attrs) {
      return Array.from(node.attributes).map((attr) => [attr.name, attr.value]);
    }
    return Object.entries(node?.attrs || {});
  }

  // Keep the home SVG's childNodes indexes. Native ondemand.s often reads
  // frame.childNodes[1].childNodes, and a rebuilt single <g> makes [1] undefined.
  function copySvgTree(source) {
    // Native code reads frame.childNodes[0].childNodes[1]. A leading text node
    // makes [0] a text node, and [0].childNodes[1] is undefined.
    if (isTextNode(source)) return null;
    const tag = String(source.tagName || source.tag || 'svg').toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'foreignobject') return null;
    const el = document.createElementNS(SVG_NS, tag);
    if (source.id) el.id = source.id;
    for (const [name, value] of attrList(source)) {
      const key = String(name).toLowerCase();
      if (!key || key.startsWith('on') || key === 'href' || key.endsWith(':href')) continue;
      el.setAttribute(name, value ?? '');
    }
    for (const child of nodeChildren(source)) {
      const copy = copySvgTree(child);
      if (copy) el.appendChild(copy);
    }
    return el;
  }

  // ondemand.s queries a deploy-specific class such as ".r-32hy0", then reads
  // matches[key % 4].childNodes. A class mismatch yields undefined.childNodes.
  function isAnimFrame(node) {
    if (!node || typeof node !== 'object') return false;
    if (String(node.id || '').startsWith('loading-x-anim')) return true;
    return String(node.tagName || node.tag || '').toLowerCase() === 'svg';
  }

  function framesForSelector(selector, found, frames) {
    if (!Array.isArray(frames) || frames.length < 4) return found;
    if (typeof selector !== 'string' || !/\.r-[A-Za-z0-9_-]+/.test(selector)) return found;
    const usable = Array.from(found || []).filter(isAnimFrame);
    if (usable.length >= 4) return usable;
    const classes = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]);
    frames.forEach((svg) => classes.forEach((cls) => svg.classList?.add(cls)));
    return frames;
  }

  function installFrameQueryFallback(frames) {
    const orig = document.querySelectorAll;
    document.querySelectorAll = function (selector, ...args) {
      const found = orig.call(this, selector, ...args);
      const next = framesForSelector(selector, found, frames);
      return next === found ? found : next;
    };
    return () => { document.querySelectorAll = orig; };
  }

  function ensureSecondPath(svg) {
    const group = svg.querySelector?.('g') || svg;
    const paths = Array.from(group.querySelectorAll?.('path') || []);
    if (paths.length >= 2) return;
    const path = paths[0] || document.createElementNS(SVG_NS, 'path');
    if (!paths[0]) group.appendChild(path);
    if (!path.getAttribute('d')) path.setAttribute('d', 'M 10,30 C 20,10 30,19 40,16');
    group.appendChild(path.cloneNode(true));
  }

  function makeFrames(homeDoc) {
    const host = document.createElement('div');
    host.setAttribute('data-xvm-xct-frames', '1');
    host.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;');
    const frames = Array.from(homeDoc.querySelectorAll(FRAME_SELECTOR));
    if (frames.length !== 4) throw new Error('xct: expected four X animation frames');
    frames.forEach((source, i) => {
      const svg = copySvgTree(source);
      if (!svg || nodeChildren(svg).length < 1) throw new Error('xct: X animation frame missing');
      svg.id = `loading-x-anim-${i}`;
      ensureSecondPath(svg);
      host.appendChild(svg);
    });
    preparedFrames = Array.from(host.querySelectorAll('svg'));
    return host;
  }

  async function build() {
    const chunks = window.webpackChunk_twitter_responsive_web;
    if (!Array.isArray(chunks)) throw new Error('xct: X bundle not ready; refresh X and retry');
    const runtime = getRuntime(chunks);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let homeHtml;
    try {
      const fetchHome = window.__xvmNet?.originalFetch || window.fetch;
      const res = await fetchHome('https://x.com/', { credentials: 'include', signal: controller.signal });
      if (!res.ok) throw new Error(`xct: X home request failed (${res.status})`);
      homeHtml = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const idMatch = homeHtml.match(/["']?(\d+)["']?\s*:\s*["']ondemand\.s["']/);
    if (!idMatch) throw new Error('xct: ondemand.s chunk not found in X home');
    const chunkId = Number(idMatch[1]);
    // X's loader resolves its own hash (including current 16-character hashes).
    // Never build a CDN URL from a fixed-length hash regex.
    const homeDoc = new DOMParser().parseFromString(homeHtml, 'text/html');
    const verification = (doc) => doc.querySelector('meta[name="twitter-site-verification"]')?.getAttribute('content');
    // A fresh home response has its own verification key. The native module
    // reads the running page's key; only restore the static animation geometry.
    if (!verification(document)) {
      throw new Error('xct: X page context changed; refresh X and retry');
    }
    const host = makeFrames(homeDoc);
    // Status pages often have no loading frames left: X consumes them on its
    // first API call. The native generator reads those frames after an await,
    // so removing our copies before that read throws
    // "Cannot read properties of undefined (reading 'childNodes')".
    const originals = Array.from(document.querySelectorAll(FRAME_SELECTOR));
    parkedFrames = {
      originals,
      ids: originals.map((node) => node.id),
      classes: originals.map((node) => node.getAttribute('class')),
    };
    originals.forEach((node, i) => {
      node.id = `xvm-saved-frame-${i}`;
      node.removeAttribute('class');
    });
    document.body.appendChild(host);
    frameHost = host;
    const restoreQuery = installFrameQueryFallback(Array.from(host.querySelectorAll('svg')));
    await runtime.e(chunkId);
    const chunk = chunks.find((entry) => entry[0]?.includes(chunkId));
    const moduleIds = Object.keys(chunk?.[1] || {});
    if (moduleIds.length !== 1) throw new Error('xct: unsupported X transaction module layout');
    const initialize = runtime(moduleIds[0])?.default;
    if (typeof initialize !== 'function') throw new Error('xct: X transaction initializer missing');
    const generate = initialize();
    if (typeof generate !== 'function') throw new Error('xct: X transaction generator missing');
    try {
      await generate('/2/grok/add_response.json', 'POST');
    } catch (err) {
      releaseFrames();
      throw err;
    } finally {
      restoreQuery();
    }
    return generate;
  }

  function releaseFrames() {
    frameHost?.remove();
    frameHost = null;
    const parked = parkedFrames;
    parkedFrames = null;
    parked?.originals.forEach((node, i) => {
      node.id = parked.ids[i];
      if (parked.classes[i] !== null) node.setAttribute('class', parked.classes[i]);
    });
  }

  function ensureReady() {
    if (!buildingPromise) {
      buildingPromise = build().catch((err) => {
        buildingPromise = null;
        throw err;
      });
    }
    return buildingPromise;
  }

  async function generateTxId(method, path) {
    if (window.__xvmSkipGrok) return '';
    try {
      const generate = await ensureReady();
      return await generate(path, method);
    } catch (_) {
      return '';
    }
  }

  function reset() {
    buildingPromise = null;
    releaseFrames();
  }
  function warmup() {
    if (window.__xvmSkipGrok) return;
    ensureReady().catch(() => {});
  }
  window.__xvmXct = { generateTxId, ensureReady, reset, warmup };
})();
