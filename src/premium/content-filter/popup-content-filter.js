// === Content filter settings (popup context) ===
//
// Owns chrome.storage.local.xvm_content_filter_v1. isolated.js forwards this
// value to the MAIN-world content filter.

(function () {
  const STORAGE_KEY = 'xvm_content_filter_v1';
  const RULES_KEY = 'xvm_content_filter_rules_remote_v1';
  // Must match isolated.js: the popup previews the same payload the content
  // script runs, and both must serve this fork rather than upstream.
  const REMOTE_RULES_URL = 'https://raw.githubusercontent.com/thelazylancer/twitter-plugin/main/src/premium/content-filter/rules.json';
  const REMOTE_RULES_CURRENT_VERSION = 2;
  let cachedRemoteRules = null;
  let cachedFetchedAt = 0;
  const DEFAULTS = {
    enabled: false,
    level: 'standard',
    customRules: [],
    whitelistHandles: [],
    whitelistDomains: [],
    whitelistFollowing: true,
    blacklistHandles: [],
  };
  const FIELDS = ['name', 'screen_name', 'bio', 'location', 'content', 'url'];
  // `short-symbol` is a builtin sentinel handled by isShortSymbolSpam in
  // filter.js — users can't create it themselves, so it's intentionally
  // omitted from the popup picker.
  const TYPES = ['keyword', 'regex', 'domain'];
  const SEVERITIES = ['low', 'medium', 'high', 'block'];

  function t(key, ...subs) {
    try {
      const v = chrome?.i18n?.getMessage?.(key, subs.length ? subs.map(String) : undefined);
      if (v) return v;
    } catch (_) {}
    return key;
  }

  function storageGet(key, fallback) {
    return new Promise((resolve) => {
      try { chrome.storage.local.get(key, (o) => resolve(o?.[key] ?? fallback)); }
      catch (_) { resolve(fallback); }
    });
  }
  function storageSet(obj) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set(obj, resolve); }
      catch (_) { resolve(); }
    });
  }

  function normalize(raw) {
    const out = {
      ...DEFAULTS,
      customRules: [],
      whitelistHandles: [],
      whitelistDomains: [],
      whitelistFollowing: true,
      blacklistHandles: [],
    };
    if (!raw || typeof raw !== 'object') return out;
    out.enabled = raw.enabled === true;
    out.level = ['light', 'standard', 'strict'].includes(raw.level) ? raw.level : DEFAULTS.level;
    out.customRules = Array.isArray(raw.customRules) ? raw.customRules.map(normalizeRule).filter(Boolean) : [];
    out.whitelistHandles = normalizeList(raw.whitelistHandles);
    out.whitelistDomains = normalizeList(raw.whitelistDomains);
    out.whitelistFollowing = raw.whitelistFollowing !== false;
    out.blacklistHandles = normalizeList(raw.blacklistHandles).map((s) => s.replace(/^@+/, '').trim()).filter(Boolean);
    return out;
  }

  function normalizeList(v) {
    if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[\n,，\s]+/).map((s) => s.trim()).filter(Boolean);
    return [];
  }

  function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object') return null;
    const value = String(rule.value || '').trim();
    if (!value) return null;
    const type = TYPES.includes(rule.type) ? rule.type : 'keyword';
    return {
      id: String(rule.id || `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`),
      type,
      field: FIELDS.includes(rule.field) ? rule.field : (type === 'domain' ? 'url' : 'content'),
      severity: SEVERITIES.includes(rule.severity) ? rule.severity : 'medium',
      value,
      source: 'custom',
    };
  }

  function builtinRules() {
    if (cachedRemoteRules && Array.isArray(cachedRemoteRules.rules)) return cachedRemoteRules;
    return globalThis.__xvmContentFilterBuiltinRules || { levels: { light: [], standard: [], strict: [] }, rules: [] };
  }

  function isCurrentRulesPayload(payload) {
    return payload
      && payload.version === REMOTE_RULES_CURRENT_VERSION
      && payload.levels
      && Array.isArray(payload.rules);
  }

  async function loadRemoteRulesCache() {
    const rec = await storageGet(RULES_KEY, null);
    if (rec && isCurrentRulesPayload(rec.payload)) {
      cachedRemoteRules = rec.payload;
      cachedFetchedAt = rec.fetchedAt || 0;
    } else {
      cachedRemoteRules = null;
      cachedFetchedAt = 0;
    }
  }

  function formatRelativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60_000) return t('cfRulesJustNow');
    if (diff < 3600_000) return t('cfRulesMinutesAgo', String(Math.round(diff / 60_000)));
    if (diff < 86_400_000) return t('cfRulesHoursAgo', String(Math.round(diff / 3600_000)));
    return t('cfRulesDaysAgo', String(Math.round(diff / 86_400_000)));
  }

  function rulesSourceText() {
    if (cachedRemoteRules && cachedFetchedAt) {
      return t('cfRulesSourceRemote', formatRelativeTime(cachedFetchedAt));
    }
    return t('cfRulesSourceBundled');
  }

  async function refreshRemoteRules() {
    const res = await fetch(REMOTE_RULES_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!isCurrentRulesPayload(payload)) {
      throw new Error('invalid_payload');
    }
    const record = { fetchedAt: Date.now(), payload };
    await storageSet({ [RULES_KEY]: record });
    return record;
  }

  function ruleCount(level) {
    const src = builtinRules();
    const ids = new Set(src.levels?.[level] || []);
    return (src.rules || []).filter((r) => ids.has(r.id)).length;
  }

  function buildSection() {
    const section = document.getElementById('content-filter-section');
    if (!section) return null;
    section.innerHTML = `
      <h2 class="cf-title" data-k="cfTitle"></h2>
      <p class="rf-rule-hint" data-k="cfScopeHint"></p>

      <label class="rf-toggle">
        <span data-k="cfEnabled"></span>
        <span class="switch">
          <input type="checkbox" id="cf-enabled" />
          <span class="slider"></span>
        </span>
      </label>

      <div class="cf-levels" role="radiogroup" aria-label="${t('cfLevel')}">
        <button type="button" class="cf-level" data-level="light"></button>
        <button type="button" class="cf-level" data-level="standard"></button>
        <button type="button" class="cf-level" data-level="strict"></button>
      </div>
      <p class="rf-rule-hint" id="cf-rule-count"></p>
      <p class="rf-rule-hint cf-rules-source" id="cf-rules-source"></p>
      <button type="button" id="cf-rules-refresh" class="rf-btn-ghost cf-rules-refresh" data-k="cfRulesRefresh"></button>

      <details class="cf-custom" id="cf-whitelist-details">
        <summary data-k="cfWhitelistTitle"></summary>
        <label class="rf-scope-switch cf-following">
          <input type="checkbox" id="cf-whitelistFollowing" />
          <span data-k="cfWhitelistFollowing"></span>
        </label>
        <label class="rf-row cf-whitelist"><span data-k="cfWhitelistHandles"></span><input type="text" id="cf-whitelistHandles" /></label>
        <label class="rf-row cf-whitelist"><span data-k="cfBlacklistHandles"></span><input type="text" id="cf-blacklistHandles" /></label>
        <label class="rf-row cf-whitelist"><span data-k="cfWhitelistDomains"></span><input type="text" id="cf-whitelistDomains" /></label>
      </details>

      <details class="cf-custom" id="cf-custom-details">
        <summary data-k="cfCustomTitle"></summary>
        <div class="cf-add-grid">
          <select id="cf-type">${TYPES.map((v) => `<option value="${v}">${v}</option>`).join('')}</select>
          <select id="cf-field">${FIELDS.map((v) => `<option value="${v}">${v}</option>`).join('')}</select>
          <select id="cf-severity">${SEVERITIES.map((v) => `<option value="${v}">${v}</option>`).join('')}</select>
          <input id="cf-value" type="text" data-placeholder-k="cfValue" />
        </div>
        <button type="button" id="cf-add" class="rf-btn" data-k="cfAddRule"></button>
        <div id="cf-custom-list" class="cf-custom-list"></div>
      </details>

      <details class="cf-rules" id="cf-rules-details">
        <summary data-k="cfAllRulesTitle"></summary>
        <div id="cf-all-rules" class="cf-rule-list"></div>
      </details>

      <p class="rf-rule-hint" data-k="cfRuleHint"></p>
      <div class="rf-actions">
        <button type="button" id="cf-reset" class="rf-btn-ghost" data-k="rfReset"></button>
      </div>
      <div class="rf-msg" id="cf-msg"></div>
    `;
    section.querySelectorAll('[data-k]').forEach((el) => { el.textContent = t(el.dataset.k); });
    section.querySelectorAll('[data-placeholder-k]').forEach((el) => { el.placeholder = t(el.dataset.placeholderK); });
    section.querySelector('[data-level="light"]').textContent = `${t('cfLevelLight')} · ${ruleCount('light')}`;
    section.querySelector('[data-level="standard"]').textContent = `${t('cfLevelStandard')} · ${ruleCount('standard')}`;
    section.querySelector('[data-level="strict"]').textContent = `${t('cfLevelStrict')} · ${ruleCount('strict')}`;
    return section;
  }

  function applyTo(section, settings) {
    // Never overwrite a field the user is actively typing into. When the
    // value comes from `storage.onChanged` (another tab) we'd otherwise
    // clobber their in-progress keystrokes.
    const focused = section.contains(document.activeElement) ? document.activeElement : null;
    const setVal = (sel, value) => {
      const el = section.querySelector(sel);
      if (el && el !== focused) el.value = value;
    };
    const setChecked = (sel, value) => {
      const el = section.querySelector(sel);
      if (el && el !== focused) el.checked = !!value;
    };
    setChecked('#cf-enabled', settings.enabled);
    section.querySelectorAll('[data-level]').forEach((btn) => {
      btn.setAttribute('aria-pressed', btn.dataset.level === settings.level ? 'true' : 'false');
    });
    section.dataset.level = settings.level;
    section.querySelector('#cf-rule-count').textContent = t('cfRuleCounts', ruleCount(settings.level), settings.customRules.length);
    const srcEl = section.querySelector('#cf-rules-source');
    if (srcEl) srcEl.textContent = rulesSourceText();
    setChecked('#cf-whitelistFollowing', settings.whitelistFollowing !== false);
    setVal('#cf-whitelistHandles', settings.whitelistHandles.join(', '));
    setVal('#cf-blacklistHandles', settings.blacklistHandles.join(', '));
    setVal('#cf-whitelistDomains', settings.whitelistDomains.join(', '));
    renderCustomList(section, settings);
    renderAllRules(section, settings);
  }

  function readFrom(section, current) {
    return normalize({
      enabled: section.querySelector('#cf-enabled').checked,
      level: section.dataset.level || DEFAULTS.level,
      customRules: current.customRules,
      whitelistFollowing: section.querySelector('#cf-whitelistFollowing').checked,
      whitelistHandles: section.querySelector('#cf-whitelistHandles').value,
      blacklistHandles: section.querySelector('#cf-blacklistHandles').value,
      whitelistDomains: section.querySelector('#cf-whitelistDomains').value,
    });
  }

  function renderCustomList(section, settings) {
    const list = section.querySelector('#cf-custom-list');
    list.innerHTML = '';
    if (!settings.customRules.length) {
      list.innerHTML = `<p class="rf-rule-hint">${t('cfCustomEmpty')}</p>`;
      return;
    }
    settings.customRules.forEach((rule, idx) => {
      const row = document.createElement('div');
      row.className = 'cf-custom-row';
      row.innerHTML = `<span>${rule.type}/${rule.field}/${rule.severity}: ${escapeHtml(rule.value)}</span><button type="button" data-del="${idx}" aria-label="${t('cfDeleteRule')}">×</button>`;
      list.appendChild(row);
    });
  }

  function renderAllRules(section, settings) {
    const list = section.querySelector('#cf-all-rules');
    if (!list) return;
    const src = builtinRules();
    const builtins = (src.rules || []).map((rule) => ({ ...rule, source: 'builtin' })).filter((rule) => rule.id && rule.value);
    const customs = settings.customRules.map((rule, idx) => ({ ...rule, source: 'custom', customIndex: idx }));
    const groups = new Map();
    for (const rule of [...builtins, ...customs]) {
      const key = rule.field || 'content';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(rule);
    }
    if (!groups.size) {
      list.innerHTML = `<p class="rf-rule-hint">${t('cfNoRules')}</p>`;
      return;
    }
    list.innerHTML = Array.from(groups.entries()).map(([field, rules]) => `
      <details class="cf-rule-group" open>
        <summary>${escapeHtml(field)} · ${rules.length}</summary>
        <div class="cf-rule-items">
          ${rules.map(renderRuleRow).join('')}
        </div>
      </details>
    `).join('');
  }

  function renderRuleRow(rule) {
    const level = ruleLevels(rule.id).join('/') || '-';
    const readonly = rule.source !== 'custom';
    const label = readonly ? t('cfBuiltinRule') : t('cfCustomRule');
    const action = readonly ? '' : `<button type="button" data-del-rule="${rule.customIndex}" aria-label="${t('cfDeleteRule')}">×</button>`;
    return `<div class="cf-rule-row" data-source="${escapeAttr(rule.source || '')}">
      <div class="cf-rule-main">
        <b>${escapeHtml(rule.value)}</b>
        <span>${escapeHtml(label)} · ${escapeHtml(rule.type)} / ${escapeHtml(rule.field)} / ${escapeHtml(rule.severity)} · ${escapeHtml(level)}</span>
      </div>
      ${action}
    </div>`;
  }

  function ruleLevels(id) {
    const levels = builtinRules().levels || {};
    return ['light', 'standard', 'strict'].filter((level) => (levels[level] || []).includes(id));
  }

  function flash(section, key) {
    const msg = section.querySelector('#cf-msg');
    msg.textContent = t(key);
    msg.dataset.kind = 'ok';
    setTimeout(() => { msg.textContent = ''; delete msg.dataset.kind; }, 1500);
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, '&#96;');
  }

  async function mount() {
    await loadRemoteRulesCache();
    const section = buildSection();
    if (!section) return;
    let settings = normalize(await storageGet(STORAGE_KEY, DEFAULTS));
    applyTo(section, settings);

    // Debounced auto-save: any input/change/click that mutates `settings`
    // schedules a write. 300ms is short enough to feel instant and long
    // enough to coalesce typing into one storage write.
    let saveTimer = null;
    let isApplyingExternal = false;
    function scheduleAutoSave() {
      if (isApplyingExternal) return;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        saveTimer = null;
        settings = readFrom(section, settings);
        await storageSet({ [STORAGE_KEY]: settings });
        flash(section, 'cfAutoSaved');
      }, 300);
    }
    function applyExternal(next) {
      isApplyingExternal = true;
      try { applyTo(section, next); } finally { isApplyingExternal = false; }
    }

    section.querySelectorAll('[data-level]').forEach((btn) => {
      btn.addEventListener('click', () => {
        section.dataset.level = btn.dataset.level;
        settings = readFrom(section, settings);
        applyTo(section, settings);
        scheduleAutoSave();
      });
    });
    section.querySelector('#cf-enabled').addEventListener('change', scheduleAutoSave);
    section.querySelector('#cf-whitelistFollowing').addEventListener('change', scheduleAutoSave);
    ['cf-whitelistHandles', 'cf-blacklistHandles', 'cf-whitelistDomains'].forEach((id) => {
      section.querySelector(`#${id}`).addEventListener('input', scheduleAutoSave);
    });

    section.querySelector('#cf-add').addEventListener('click', () => {
      const rule = normalizeRule({
        type: section.querySelector('#cf-type').value,
        field: section.querySelector('#cf-field').value,
        severity: section.querySelector('#cf-severity').value,
        value: section.querySelector('#cf-value').value,
      });
      if (!rule) return;
      settings = readFrom(section, settings);
      settings.customRules.push(rule);
      section.querySelector('#cf-value').value = '';
      applyTo(section, settings);
      scheduleAutoSave();
    });
    section.querySelector('#cf-custom-list').addEventListener('click', (event) => {
      const idx = event.target?.dataset?.del;
      if (idx == null) return;
      settings = readFrom(section, settings);
      settings.customRules.splice(Number(idx), 1);
      applyTo(section, settings);
      scheduleAutoSave();
    });
    section.querySelector('#cf-all-rules').addEventListener('click', (event) => {
      const idx = event.target?.dataset?.delRule;
      if (idx == null) return;
      settings = readFrom(section, settings);
      settings.customRules.splice(Number(idx), 1);
      applyTo(section, settings);
      scheduleAutoSave();
    });
    section.querySelector('#cf-reset').addEventListener('click', async () => {
      settings = normalize(DEFAULTS);
      await storageSet({ [STORAGE_KEY]: settings });
      applyExternal(settings);
      flash(section, 'rfResetOk');
    });
    section.querySelector('#cf-rules-refresh').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = t('cfRulesRefreshing');
      try {
        await refreshRemoteRules();
        // storage.onChanged will reload cachedRemoteRules and re-render.
        flash(section, 'cfRulesRefreshOk');
      } catch (_) {
        flash(section, 'cfRulesRefreshErr');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });

    try {
      chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'local') return;
        if (STORAGE_KEY in changes) {
          settings = normalize(changes[STORAGE_KEY].newValue);
          applyExternal(settings);
        }
        if (RULES_KEY in changes) {
          await loadRemoteRulesCache();
          section.querySelector('[data-level="light"]').textContent = `${t('cfLevelLight')} · ${ruleCount('light')}`;
          section.querySelector('[data-level="standard"]').textContent = `${t('cfLevelStandard')} · ${ruleCount('standard')}`;
          section.querySelector('[data-level="strict"]').textContent = `${t('cfLevelStrict')} · ${ruleCount('strict')}`;
          applyExternal(settings);
        }
      });
    } catch (_) {}
  }

  document.addEventListener('DOMContentLoaded', mount);
  window.__xvmContentFilterPopup = { STORAGE_KEY, DEFAULTS, mount, normalize };
})();
