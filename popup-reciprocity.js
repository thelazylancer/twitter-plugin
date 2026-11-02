// === Reciprocity panel (Marks tab) ===
//
// "Did this person give back what I put in?" The content script observes
// replies, likes, and reposts as they happen on x.com and writes counters to
// chrome.storage.local under xvmReciprocity; this panel only reads and renders
// them. A row compares:
//
//   mine   = replies I sent them + their posts I liked
//   theirs = replies they sent me + my posts they liked + my posts they reposted
//
// The imbalance (mine - theirs) is the sort key, so the people who take the
// most without giving back sit at the top. A one-way filter keeps exactly the
// case the feature was asked for: I engaged, they never did.
(() => {
  const STORAGE_KEY = 'xvmReciprocity';
  const INLINE_KEY = 'reciprocityInlineEnabled';
  const state = {
    ledger: {},
    filter: 'all',
    confirmClear: false,
    confirmTimer: 0,
  };

  function t(key) {
    try {
      return chrome.i18n.getMessage(key) || key;
    } catch (_) {
      return key;
    }
  }

  function count(entry, field) {
    return Math.max(0, Math.floor(Number(entry?.[field]) || 0));
  }

  // Components are kept separately so the tooltip can explain a number that
  // looks surprising ("they invested 4" = two likes and two reposts).
  function totals(entry) {
    const outReply = count(entry, 'outReply');
    const outLike = count(entry, 'outLike');
    const inReply = count(entry, 'inReply');
    const inLike = count(entry, 'inLike');
    const inRepost = count(entry, 'inRepost');
    return {
      outReply,
      outLike,
      inReply,
      inLike,
      inRepost,
      mine: outReply + outLike,
      theirs: inReply + inLike + inRepost,
    };
  }

  function detail(parts) {
    return parts
      .filter(([, n]) => n > 0)
      .map(([label, n]) => `${label} ${n}`)
      .join(' · ');
  }

  function rows() {
    const out = [];
    for (const [handle, entry] of Object.entries(state.ledger || {})) {
      const sum = totals(entry);
      if (!sum.mine && !sum.theirs) continue;
      const oneway = sum.mine > 0 && sum.theirs === 0;
      if (state.filter === 'oneway' && !oneway) continue;
      out.push({ handle, ...sum, oneway });
    }
    // Biggest taker first. Ties go to the person I invested in more, then to a
    // stable alphabetical order so re-opening the popup does not reshuffle.
    return out.sort((a, b) => (
      (b.mine - b.theirs) - (a.mine - a.theirs)
      || b.mine - a.mine
      || a.handle.localeCompare(b.handle)
    ));
  }

  function renderRow(row) {
    const li = document.createElement('li');
    li.className = `recip-row${row.oneway ? ' is-oneway' : ''}`;

    const top = document.createElement('div');
    top.className = 'recip-top';
    const link = document.createElement('a');
    link.className = 'recip-handle';
    link.href = `https://x.com/${encodeURIComponent(row.handle)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `@${row.handle}`;
    const ratio = document.createElement('span');
    ratio.className = 'recip-ratio';
    ratio.textContent = `${row.mine} : ${row.theirs}`;
    if (row.oneway) {
      const tag = document.createElement('span');
      tag.className = 'recip-tag';
      tag.textContent = t('recipFilterOneWay');
      ratio.appendChild(tag);
    }
    top.append(link, ratio);

    const bar = document.createElement('div');
    bar.className = 'recip-bar';
    bar.setAttribute('aria-hidden', 'true');
    const mineBar = document.createElement('span');
    mineBar.className = 'recip-bar-mine';
    mineBar.style.flexGrow = String(row.mine);
    const theirsBar = document.createElement('span');
    theirsBar.className = 'recip-bar-theirs';
    theirsBar.style.flexGrow = String(row.theirs);
    bar.append(mineBar, theirsBar);

    const meta = document.createElement('div');
    meta.className = 'recip-meta';
    const mine = document.createElement('span');
    mine.textContent = `${t('recipMine')} ${row.mine}`;
    mine.title = detail([[t('recipReply'), row.outReply], [t('recipLike'), row.outLike]]);
    const theirs = document.createElement('span');
    theirs.textContent = `${t('recipTheirs')} ${row.theirs}`;
    theirs.title = detail([
      [t('recipReply'), row.inReply],
      [t('recipLike'), row.inLike],
      [t('recipRepost'), row.inRepost],
    ]);
    meta.append(mine, theirs);

    li.append(top, bar, meta);
    return li;
  }

  function renderSummary() {
    const el = document.getElementById('recip-summary-meta');
    if (!el) return;
    let people = 0;
    let oneway = 0;
    for (const entry of Object.values(state.ledger || {})) {
      const sum = totals(entry);
      if (!sum.mine && !sum.theirs) continue;
      people += 1;
      if (sum.mine > 0 && sum.theirs === 0) oneway += 1;
    }
    el.textContent = people
      ? `${people} ${t('recipPeople')}${oneway ? ` · ${oneway} ${t('recipFilterOneWay')}` : ''}`
      : '';
  }

  function render() {
    const list = document.getElementById('recip-list');
    const empty = document.getElementById('recip-empty');
    const emptyText = document.getElementById('recip-empty-text');
    const clear = document.getElementById('recip-clear');
    if (!list || !empty || !emptyText) return;

    const next = rows();
    const hasAny = Object.keys(state.ledger || {}).length > 0;
    list.replaceChildren(...next.map(renderRow));
    list.hidden = next.length === 0;
    empty.hidden = next.length > 0;
    emptyText.textContent = hasAny ? t('recipEmptyFilter') : t('recipEmpty');
    if (clear) {
      clear.hidden = !hasAny;
      if (!hasAny && state.confirmClear) resetClear();
    }
    renderSummary();
  }

  function setFilter(name) {
    state.filter = name === 'oneway' ? 'oneway' : 'all';
    document.querySelectorAll('.recip-filter').forEach((btn) => {
      const active = btn.dataset.filter === state.filter;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    render();
  }

  function resetClear() {
    state.confirmClear = false;
    if (state.confirmTimer) {
      clearTimeout(state.confirmTimer);
      state.confirmTimer = 0;
    }
    const btn = document.getElementById('recip-clear');
    if (btn) {
      btn.classList.remove('is-confirm');
      btn.textContent = t('recipClear');
    }
  }

  function onClear() {
    const btn = document.getElementById('recip-clear');
    if (!btn) return;
    if (!state.confirmClear) {
      state.confirmClear = true;
      btn.classList.add('is-confirm');
      btn.textContent = t('recipClearConfirm');
      state.confirmTimer = setTimeout(resetClear, 3000);
      return;
    }
    resetClear();
    try {
      chrome.storage.local.remove(STORAGE_KEY);
    } catch (_) {}
    state.ledger = {};
    render();
  }

  function load() {
    try {
      chrome.storage.local.get({ [STORAGE_KEY]: null }, (items) => {
        state.ledger = items?.[STORAGE_KEY]?.ledger || {};
        render();
      });
    } catch (_) {
      render();
    }
  }

  function inlineToggleEl() {
    return document.getElementById('recip-inline-toggle');
  }

  function loadInlineSetting() {
    try {
      chrome.storage.sync.get({ [INLINE_KEY]: true }, (items) => {
        const el = inlineToggleEl();
        if (el) el.checked = items?.[INLINE_KEY] !== false;
      });
    } catch (_) {}
  }

  function saveInlineSetting() {
    const el = inlineToggleEl();
    if (!el) return;
    try {
      chrome.storage.sync.set({ [INLINE_KEY]: el.checked });
    } catch (_) {}
  }

  document.querySelectorAll('.recip-filter').forEach((btn) => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });
  document.getElementById('recip-clear')?.addEventListener('click', onClear);
  inlineToggleEl()?.addEventListener('change', saveInlineSetting);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[INLINE_KEY]) {
        const el = inlineToggleEl();
        if (el) el.checked = changes[INLINE_KEY].newValue !== false;
        return;
      }
      if (area !== 'local' || !changes[STORAGE_KEY]) return;
      state.ledger = changes[STORAGE_KEY].newValue?.ledger || {};
      render();
    });
  } catch (_) {}

  loadInlineSetting();
  load();
})();
