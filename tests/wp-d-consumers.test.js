// WP-D 自测：消费者一致性 + License community-dev 网络短路（node:vm 真执行）。
//
// 本包独占文件。只读取源码、在 vm 里真执行，不改仓库任何其它文件。
// 覆盖：
//   (1) 单一数据源：4 个消费者 5 处生成区 vm 求值 == src/ai-defaults.data.json；
//   (2) 语言默认语义不合并：popup.js 走 initialLanguageId，bridge.js 走 getBrowserLocaleId()；
//   (3) community 短路核心：isolated.js 的 ACTIVATE / DEACTIVATE / STATUS_REQUEST
//       三条消息都不触发 XVM_LICENSE_PROXY / license fetch，回包 ok:false,error:'community_dev'；
//       callProxy 在 community 下抛 community_dev；popup-pro.js 的 trial IIFE 不写
//       TRIAL_KEY 且 refresh() 仍被调用；popup-pro 的 activate/deactivate/revalidate
//       早返回且不 fetch；
//   (4) store 通道不回归：标志 false 时 ACTIVATE 仍走完整链路 sendMessage + fetch，
//       所有被锁定的字面串仍在；
//   (5) 边界：空 key / 非法 key / 无渠道标志（视为 store）；
//   (6) 回归护栏：被锁定的「不得删除」字面串静态确认。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const read = (rel) => readFileSync(resolve(repo, rel), 'utf8');

const START = '// --- ai-defaults:generated:start ---';
const END = '// --- ai-defaults:generated:end ---';

const data = JSON.parse(read('src/ai-defaults.data.json'));
const popupJs = read('popup.js');
const bridgeJs = read('bridge.js');
const backgroundJs = read('background.js');
const isolatedJs = read('src/premium/license/isolated.js');
const popupProJs = read('src/premium/license/popup-pro.js');

const LICENSE_WORKER = 'https://xvm-license.lengkuxiaomao.workers.dev';

// ───────────────────────────────────────────────────────────────────────────
// 通用工具
// ───────────────────────────────────────────────────────────────────────────

// 取出某文件所有标记区（区间文本，含 const 声明本身）。
function markerRegions(src) {
  const lines = src.split('\n');
  const starts = [];
  const ends = [];
  lines.forEach((l, i) => {
    if (l.trim() === START) starts.push(i);
    if (l.trim() === END) ends.push(i);
  });
  return starts.map((s, i) => lines.slice(s + 1, ends[i]).join('\n'));
}

// 从具名 const 声明抽出初始化表达式（与 refactor-baseline / wp-b 同一解析方式）。
function extractConstExpr(src, name) {
  const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`);
  const m = decl.exec(src);
  expect(m ? m.index : -2, `声明 ${name} 应存在`).toBeGreaterThan(-1);
  let i = m.index + m[0].length;
  while (i < src.length) {
    if (/\s/.test(src[i])) { i++; continue; }
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }
    break;
  }
  const open = src[i];
  expect(open === '{' || open === '[').toBe(true);
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let quote = null;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    const next = src[j + 1];
    if (quote) {
      if (ch === '\\') { j++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', j);
      j = nl < 0 ? src.length : nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', j + 2);
      j = end < 0 ? src.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`无法为 ${name} 配对括号`);
}

function evalConst(src, name) {
  const expr = extractConstExpr(src, name);
  const ctx = {};
  vm.runInNewContext(`const __V = ${expr};\nthis.VALUE = __V;`, ctx);
  return ctx.VALUE;
}

// 跨 vm realm 的原型不同，用 JSON.stringify 做逐字节比较。
const J = JSON.stringify;

// 在 IIFE 闭合前插入一个导出钩子，把私有函数暴露到 vm 的 globalThis 上，
// 以便在 vm 里「真执行」而不是只做 toContain 文本扫描。不改动仓库源码。
function injectHook(src, hookLine) {
  const idx = src.lastIndexOf('})();');
  expect(idx, '找不到 IIFE 闭合 })();').toBeGreaterThan(-1);
  return src.slice(0, idx) + '\n' + hookLine + '\n' + src.slice(idx);
}

// ───────────────────────────────────────────────────────────────────────────
// isolated.js 的 node:vm 执行环境
// ───────────────────────────────────────────────────────────────────────────
function isolatedHarness(flag) {
  const messageListeners = [];
  const posted = [];
  const sent = [];
  const fetched = [];
  const store = {};
  const win = {
    addEventListener(type, fn) { if (type === 'message') messageListeners.push(fn); },
    postMessage(d) { posted.push(d); },
  };
  const sandbox = {
    window: win,
    chrome: {
      storage: {
        local: {
          get: (k, cb) => cb({ [k]: store[k] }),
          set: (o, cb) => { Object.assign(store, o); if (cb) cb(); },
          remove: (k, cb) => { delete store[k]; if (cb) cb(); },
        },
        onChanged: { addListener() {} },
      },
      runtime: {
        sendMessage: (m, cb) => { sent.push(m); if (cb) cb({ ok: false }); },
      },
    },
    fetch: async (u) => { fetched.push(String(u)); return { ok: false, json: async () => ({}) }; },
    crypto: { randomUUID: () => 'uuid-wp-d-test' },
    navigator: { userAgent: 'Chrome/120 Windows' },
    console: { error() {}, log() {} },
    Date, JSON, Math, String, Number, Object, Array, Set, Promise, RegExp, Error,
    setTimeout, clearTimeout, URL, AbortController, TextDecoder,
  };
  vm.createContext(sandbox);

  const channelLine = flag === undefined
    ? ''
    : `globalThis.__xvmIsCommunityDevBuild = ${flag};`;
  const tierLogic = {
    isXvmProduct: () => true,
    trialStatus: () => ({}),
    licenseStatusFrom: () => ({ record: null, source: 'stale' }),
    resolveTierFrom: () => ({ tier: 'free', daysLeft: 0, source: 'none' }),
  };
  const entitlement = {
    verifyEntitlementEnvelope: async () => ({ ok: true, entitlement: { exp: 1 } }),
  };
  sandbox.__TL = tierLogic;
  sandbox.__ENT = entitlement;

  const src = injectHook(
    isolatedJs,
    '  globalThis.__wpdhooks = { callProxy, activate, deactivate, getLicenseStatus, revalidateInBackground };',
  );
  const prelude = [
    channelLine,
    'globalThis.__xvmTierLogic = __TL;',
    'globalThis.__xvmEntitlement = __ENT;',
  ].join('\n');
  vm.runInContext(prelude + '\n' + src, sandbox, { filename: 'isolated.js' });

  async function settle() {
    // 等顶层 bootstrap IIFE 的异步链跑完，再清空捕获数组做断言。
    await new Promise((r) => setTimeout(r, 30));
  }
  function reset() { posted.length = 0; sent.length = 0; fetched.length = 0; }
  function licenseFetchCount() {
    return fetched.filter((u) => u.startsWith(LICENSE_WORKER + '/')).length;
  }
  async function dispatch(type, extra = {}) {
    const ev = { source: win, data: { type, ...extra } };
    await messageListeners[0](ev);
    await new Promise((r) => setTimeout(r, 20));
  }
  return { sandbox, win, messageListeners, posted, sent, fetched, store, settle, reset, licenseFetchCount, dispatch };
}

// ───────────────────────────────────────────────────────────────────────────
// popup-pro.js 的 node:vm 执行环境
// ───────────────────────────────────────────────────────────────────────────
function popupProHarness(flag, { withSection = false } = {}) {
  const store = {};
  const setCalls = [];
  const fetched = [];
  let refreshCalled = 0;
  const created = [];
  const section = withSection
    ? { dataset: {}, innerHTML: '', appendChild() {} }
    : null;

  function fakeEl() {
    return {
      dataset: {}, className: '', style: {}, children: [],
      appendChild() {}, append() {}, querySelector: () => fakeEl(),
      querySelectorAll: () => [], addEventListener() {},
      set innerHTML(v) {}, set textContent(v) {}, set href(v) {},
      set target(v) {}, set rel(v) {}, set type(v) {}, set disabled(v) {},
      set id(v) {},
    };
  }
  const doc = {
    getElementById: (id) => (id === 'xvm-pro-section' ? section : null),
    querySelectorAll: () => [],
    addEventListener() {},
    body: { dataset: {} },
    createElement: () => { const e = fakeEl(); created.push(e); return e; },
    dispatchEvent() {},
  };
  const win = {
    addEventListener() {}, dispatchEvent() {},
    CustomEvent: function CustomEvent() {},
  };
  const sandbox = {
    window: win, document: doc,
    chrome: {
      storage: {
        local: {
          get: (k, cb) => cb({ [k]: store[k] }),
          set: (o, cb) => { setCalls.push(o); Object.assign(store, o); if (cb) cb(); },
          remove: (k, cb) => { delete store[k]; if (cb) cb(); },
        },
        onChanged: { addListener() {} },
      },
      i18n: { getMessage: (k) => k },
    },
    fetch: async (u) => { fetched.push(String(u)); return { json: async () => ({}) }; },
    crypto: { randomUUID: () => 'uuid-wp-d-test' },
    console: { error() {} },
    CustomEvent: function CustomEvent() {},
    Date, JSON, Math, String, Number, Object, Array, Set, Promise, RegExp, Error,
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);

  // src/build-channel.js 同时设置这两个全局；community 构建里两者配套出现。
  // render() 会读 __xvmBuildChannel 来写 body.dataset.buildChannel。
  const channelLine = flag === undefined
    ? ''
    : `globalThis.__xvmIsCommunityDevBuild = ${flag}; globalThis.__xvmBuildChannel = ${flag} ? 'community-dev' : 'store';`;
  sandbox.__TL = {
    isXvmProduct: () => true,
    licenseStatusFrom: () => ({}),
    resolveTierFrom: () => ({ tier: 'free', daysLeft: 0, source: 'none' }),
  };
  sandbox.__ENT = { verifyEntitlementEnvelope: async () => ({ ok: true, entitlement: { exp: 1 } }) };

  // 用 hook 拿到私有函数。refresh() 是否被调用由 DOM 副作用（section.dataset.tier
  // 与 community-dev-badge 元素）来验证：community 下 trial IIFE 会在
  // vm.runInContext 期间同步调用 refresh()（早于本 hook 执行），因此不能用
  // 「包装后计数」的方式，改用 render() 的真实 DOM 产物更可靠。
  const hook = '  globalThis.__wpdhooks = { activate, deactivate, revalidateStoredLicense, callProxy, refresh };';
  const src = injectHook(popupProJs, hook);
  const prelude = [
    channelLine,
    'globalThis.__xvmTierLogic = __TL;',
    'globalThis.__xvmEntitlement = __ENT;',
  ].join('\n');
  vm.runInContext(prelude + '\n' + src, sandbox, { filename: 'popup-pro.js' });

  async function settle() { await new Promise((r) => setTimeout(r, 30)); }
  function trialWrites() { return setCalls.filter((o) => 'xvm_trial_v1' in o).length; }
  function licenseFetchCount() {
    return fetched.filter((u) => u.startsWith(LICENSE_WORKER + '/')).length;
  }
  return {
    sandbox, store, setCalls, fetched, created, section,
    settle, trialWrites, licenseFetchCount,
    hooks: () => sandbox.__wpdhooks,
  };
}

// ===========================================================================
// 1. 单一数据源：4 个消费者 5 处生成区 vm 求值 == 权威 JSON
// ===========================================================================
describe('1 / 消费者生成区 == src/ai-defaults.data.json（真换行）', () => {
  const popupRegions = markerRegions(popupJs);
  const bridgeRegions = markerRegions(bridgeJs);
  const bgRegions = markerRegions(backgroundJs);

  it('生成区数量：popup.js 2 / bridge.js 1 / background.js 1', () => {
    expect(popupRegions).toHaveLength(2);
    expect(bridgeRegions).toHaveLength(1);
    expect(bgRegions).toHaveLength(1);
  });

  it('5 处生成区求值逐项 == 权威 JSON（含 \n 真换行语义）', () => {
    const popupDefs = evalConst(popupJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const popupPresets = evalConst(popupJs, 'AI_PLATFORM_PRESETS');
    const bridgeDefs = evalConst(bridgeJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const bgPresets = evalConst(backgroundJs, 'OPENAI_COMPAT_PLATFORMS');

    // 三种语言的 16 条模板逐字节相等。
    for (const lang of ['zh_CN', 'en', 'ja']) {
      expect(J(popupDefs[lang].promptTemplates), `popup ${lang}`).toBe(J(data.templates[lang]));
      expect(J(bridgeDefs[lang].promptTemplates), `bridge ${lang}`).toBe(J(data.templates[lang]));
    }
    // 8 个 platform 预设逐字节相等。
    expect(J(popupPresets)).toBe(J(data.platforms));
    expect(J(bgPresets)).toBe(J(data.platforms));

    // 生成的 prompt 里 U+000A 是真换行，不是字面反斜杠 + n。
    const allPrompts = [
      ...popupDefs.zh_CN.promptTemplates,
      ...popupDefs.en.promptTemplates,
      ...popupDefs.ja.promptTemplates,
    ].map((t) => t.prompt);
    for (const p of allPrompts) {
      expect(p).toContain('\n');
      expect(p).not.toContain('\\n');
    }
    expect(data.defaultCommentPrompt).toBe(data.templates.zh_CN[0].prompt);
    expect(popupDefs.zh_CN.promptTemplates[0].prompt).toBe(data.defaultCommentPrompt);
  });

  it('生成区字面量在标记内直接 vm 求值也一致（防「只改声明名」）', () => {
    const ctx = {};
    vm.runInNewContext(
      `${popupRegions[0]}\nthis.D = GROK_DEFAULTS_BY_LANGUAGE;`
      + `\n${popupRegions[1]}\nthis.P = AI_PLATFORM_PRESETS;`,
      ctx,
    );
    expect(J(ctx.P)).toBe(J(data.platforms));
    expect(J(ctx.D.zh_CN.promptTemplates)).toBe(J(data.templates.zh_CN));
  });
});

// ===========================================================================
// 2. 语言默认语义不合并
// ===========================================================================
describe('2 / popup.js 与 bridge.js 的语言默认语义保持各自独立', () => {
  it('popup.js 用 initialLanguageId / localStorage 决定默认语言', () => {
    expect(popupJs).toMatch(/const initialLanguagePref = normalizeLanguage\(localStorage\.getItem\(LANGUAGE_KEY\)\)/);
    expect(popupJs).toMatch(/const initialLanguageId = getEffectiveLanguageId\(initialLanguagePref\)/);
    expect(popupJs).toMatch(/function getLocalizedGrokDefaults\(languageId = initialLanguageId\)/);
    expect(popupJs).toMatch(/const LOCALIZED_GROK_DEFAULTS = getLocalizedGrokDefaults\(initialLanguageId\)/);
  });

  it('bridge.js 用 getBrowserLocaleId() 决定默认语言（不读 localStorage 偏好）', () => {
    expect(bridgeJs).toMatch(/function getLocalizedGrokDefaults\(languageId = getBrowserLocaleId\(\)\)/);
    expect(bridgeJs).toMatch(/const LOCALIZED_GROK_DEFAULTS = getLocalizedGrokDefaults\(getBrowserLocaleId\(\)\)/);
    // 两者的默认参数不同，证明没有把两套语义合并成一份。
    expect(popupJs).not.toMatch(/function getLocalizedGrokDefaults\(languageId = getBrowserLocaleId\(\)\)/);
    expect(bridgeJs).not.toMatch(/function getLocalizedGrokDefaults\(languageId = initialLanguageId\)/);
  });

  it('isUnmodifiedBundledGrokTemplateSet 仍用 Object.values(GROK_DEFAULTS_BY_LANGUAGE) 遍历（形状未变）', () => {
    expect(popupJs).toMatch(/for \(const defs of Object\.values\(GROK_DEFAULTS_BY_LANGUAGE\)\)/);
    const defs = evalConst(popupJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    expect(Object.keys(defs).sort()).toEqual(['en', 'ja', 'zh_CN']);
    for (const lang of Object.keys(defs)) {
      expect(Array.isArray(defs[lang].promptTemplates)).toBe(true);
    }
  });
});

// ===========================================================================
// 3. community 短路（核心）— isolated.js 消息 router
// ===========================================================================
describe('3 / community-dev：isolated.js 三条 license 消息路径零网络 + ok:false', () => {
  const GOOD_KEY = 'ABCD1234EFGH5678';

  it('ACTIVATE / DEACTIVATE 早返回；回包 ok:false,error:community_dev（绝不能 ok:true）', async () => {
    const h = isolatedHarness(true);
    await h.settle();
    h.reset();

    await h.dispatch('XVM_LICENSE_ACTIVATE', { key: GOOD_KEY });
    const act = h.posted.find((p) => p.type === 'XVM_LICENSE_ACTIVATE_RESULT');
    expect(act, 'ACTIVATE 必须回 XVM_LICENSE_ACTIVATE_RESULT').toBeTruthy();
    expect(act.ok).toBe(false);
    expect(act.error).toBe('community_dev');

    h.reset();
    await h.dispatch('XVM_LICENSE_DEACTIVATE');
    const deact = h.posted.find((p) => p.type === 'XVM_LICENSE_DEACTIVATE_RESULT');
    expect(deact, 'DEACTIVATE 必须回 XVM_LICENSE_DEACTIVATE_RESULT').toBeTruthy();
    expect(deact.ok).toBe(false);
    expect(deact.error).toBe('community_dev');

    expect(h.sent).toHaveLength(0);
    expect(h.licenseFetchCount()).toBe(0);
  });

  it('STATUS_REQUEST 不发 validate 网络；回 XVM_LICENSE_STATUS 且 ok:false,error:community_dev', async () => {
    const h = isolatedHarness(true);
    await h.settle();
    // 放一条 stale 记录：store 下会触发 getLicenseStatus → revalidateInBackground → callProxy('validate')。
    h.store['xvm_license_v1'] = { key: 'kkkkkkkk', instanceId: 'ii', lastTriedAt: 0 };
    h.reset();

    await h.dispatch('XVM_LICENSE_STATUS_REQUEST');
    const status = h.posted.find((p) => p.type === 'XVM_LICENSE_STATUS');
    expect(status, 'STATUS_REQUEST 必须回 XVM_LICENSE_STATUS').toBeTruthy();
    expect(status.ok).toBe(false);
    expect(status.error).toBe('community_dev');
    expect(status.tier).toBe('pro');
    expect(status.source).toBe('community-dev');
    expect(h.sent).toHaveLength(0);
    expect(h.licenseFetchCount()).toBe(0);
  });

  it('router 顶部读取 __xvmIsCommunityDevBuild === true 作为唯一开关', () => {
    expect(isolatedJs).toMatch(/const isCommunity = globalThis\.__xvmIsCommunityDevBuild === true/);
  });

  it('getLicenseStatus 的 shouldRevalidate 分支内加 community guard（不破坏 :135 精确字面串）', () => {
    // premium-license-slice.test.js:135 锁死 `if (shouldRevalidate(status, stored))`，
    // 所以 guard 必须放在 if 内部，不能拼进条件表达式。
    const body = isolatedJs.slice(
      isolatedJs.indexOf('async function getLicenseStatus()'),
      isolatedJs.indexOf('async function resolveTier()'),
    );
    expect(body).toMatch(/if \(shouldRevalidate\(status, stored\)\)/);
    expect(body).toMatch(/if \(globalThis\.__xvmIsCommunityDevBuild !== true\)/);
    expect(body).toContain('revalidateInBackground(stored).catch(() => {});');
  });

  it('callProxy 顶部在 community 下抛 community_dev，sendMessage/fetch 字面串仍在', async () => {
    const h = isolatedHarness(true);
    await h.settle();
    let err = null;
    try { await h.sandbox.__wpdhooks.callProxy('validate', { key: 'x', instance_id: 'y' }); }
    catch (e) { err = e; }
    expect(err, 'community 下 callProxy 必须抛错').toBeTruthy();
    expect(err.message).toBe('community_dev');
    expect(h.sent).toHaveLength(0);
    expect(h.licenseFetchCount()).toBe(0);
    // 被锁定的字面串一字不动。
    expect(isolatedJs).toContain("chrome.runtime.sendMessage({ type: 'XVM_LICENSE_PROXY', action, body }, resolve)");
    expect(isolatedJs).toContain('fetch(`${LICENSE_PROXY_URL}/${action}`');
  });
});

// ===========================================================================
// 4. community 短路 — popup-pro.js（trial 播种 + 三条直连 fetch）
// ===========================================================================
describe('4 / community-dev：popup-pro.js 不写 trial key、不 fetch，refresh 仍调用', () => {
  it('trial IIFE 不写 TRIAL_KEY，但 refresh() 仍被调用（渲染 DEV 徽标）', async () => {
    const h = popupProHarness(true, { withSection: true });
    await h.settle();
    expect(h.trialWrites()).toBe(0);
    expect(h.store['xvm_trial_v1']).toBeUndefined();
    // refresh() → resolveTier()（community 返回 pro）→ render() 写数据集并
    // 创建 community-dev-badge 元素。两者都是 refresh() 真执行过的证据。
    expect(h.section.dataset.tier, 'render 必须已跑过（refresh 在 guard 外）').toBe('pro');
    expect(h.sandbox.document.body.dataset.buildChannel).toBe('community-dev');
    expect(h.created.some((e) => e.className === 'community-dev-badge'),
      'community 下必须渲染 DEV 徽标').toBe(true);
  });

  it('activate / deactivate / revalidateStoredLicense 早返回 ok:false,community_dev 且不 fetch', async () => {
    const h = popupProHarness(true);
    await h.settle();
    const H = h.hooks();
    const before = h.fetched.length;

    const a = await H.activate('ABCD1234EFGH5678');
    const d = await H.deactivate();
    const rv = await H.revalidateStoredLicense({ key: 'kkkkkkkk', instanceId: 'ii' });

    for (const res of [a, d, rv]) {
      expect(res).toEqual({ ok: false, error: 'community_dev' });
    }
    expect(h.licenseFetchCount()).toBe(0);
    expect(h.fetched.length - before).toBe(0);
  });
});

// ===========================================================================
// 5. store 通道不回归（标志 false）
// ===========================================================================
describe('5 / store 通道：完整激活链路不被删除', () => {
  it('isolated.js ACTIVATE 仍走 activate() → callProxy() → sendMessage + license fetch', async () => {
    const h = isolatedHarness(false);
    await h.settle();
    h.reset();
    await h.dispatch('XVM_LICENSE_ACTIVATE', { key: 'ABCD1234EFGH5678' });
    const sentProxy = h.sent.filter((m) => m && m.type === 'XVM_LICENSE_PROXY');
    expect(sentProxy.length, 'store 下必须发 XVM_LICENSE_PROXY').toBeGreaterThan(0);
    expect(sentProxy[0].action).toBe('activate');
    expect(h.licenseFetchCount(), 'store 下必须 fetch license Worker').toBeGreaterThan(0);
    // 回包是正常业务结果（activation_failed / wrong_product / network 等），不是 community_dev。
    const act = h.posted.find((p) => p.type === 'XVM_LICENSE_ACTIVATE_RESULT');
    expect(act).toBeTruthy();
    expect(act.error).not.toBe('community_dev');
  });

  it('isolated.js STATUS_REQUEST 在 store 下仍会触发 validate 网络（有 stale 记录时）', async () => {
    const h = isolatedHarness(false);
    await h.settle();
    h.store['xvm_license_v1'] = { key: 'kkkkkkkk', instanceId: 'ii', lastTriedAt: 0 };
    h.reset();
    await h.dispatch('XVM_LICENSE_STATUS_REQUEST');
    const validateSent = h.sent.filter((m) => m && m.type === 'XVM_LICENSE_PROXY' && m.action === 'validate');
    expect(validateSent.length, 'store 下 STATUS_REQUEST 的 validate 网络仍存在').toBeGreaterThan(0);
    expect(h.licenseFetchCount()).toBeGreaterThan(0);
  });

  it('isolated.js callProxy 在 store 下不抛 community_dev，正常发出 sendMessage + fetch', async () => {
    const h = isolatedHarness(false);
    await h.settle();
    h.reset();
    let threw = null;
    try { await h.sandbox.__wpdhooks.callProxy('validate', { key: 'x', instance_id: 'y' }); }
    catch (e) { threw = e; }
    expect(threw, 'store 下 callProxy 不应抛 community_dev').toBeNull();
    expect(h.sent.some((m) => m && m.type === 'XVM_LICENSE_PROXY')).toBe(true);
    expect(h.licenseFetchCount()).toBeGreaterThan(0);
  });

  it('popup-pro.js 在 store 下仍写 TRIAL_KEY，activate/deactivate/revalidate 仍会 fetch', async () => {
    const h = popupProHarness(false);
    await h.settle();
    expect(h.trialWrites()).toBe(1);
    const H = h.hooks();
    const before = h.licenseFetchCount();
    await H.activate('ABCD1234EFGH5678');
    await H.revalidateStoredLicense({ key: 'kkkkkkkk', instanceId: 'ii' });
    await H.deactivate();
    expect(h.licenseFetchCount(), 'store 下三条直连 fetch 仍在').toBeGreaterThan(before);
  });

  it('「不得删除」清单逐项仍在（只加 guard，不删声明/字面串/分支）', () => {
    const lockedIsolated = [
      "const LICENSE_PROXY_URL = 'https://xvm-license.lengkuxiaomao.workers.dev'",
      "chrome.runtime.sendMessage({ type: 'XVM_LICENSE_PROXY', action, body }, resolve)",
      'async function callProxy(action, body)',
      'async function activate(rawKey)',
      'async function deactivate()',
      'async function revalidateInBackground(stored)',
      'async function getLicenseStatus()',
      'function shouldRevalidate(info, stored)',
      'if (shouldRevalidate(status, stored))',
      'if (shouldRevalidate(r, stored))',
      "t === 'XVM_LICENSE_ACTIVATE'",
      "t === 'XVM_LICENSE_DEACTIVATE'",
      "t === 'XVM_LICENSE_STATUS_REQUEST'",
      "type: 'XVM_LICENSE_ACTIVATE_RESULT'",
      "type: 'XVM_LICENSE_DEACTIVATE_RESULT'",
      "type: 'XVM_LICENSE_STATUS'",
      'XVM_TIER_REQUEST', 'XVM_TIER_UPDATE',
      'ensureTrialStarted()',
    ];
    for (const s of lockedIsolated) {
      expect(isolatedJs, `isolated.js 仍含: ${s}`).toContain(s);
    }
    const lockedPopup = [
      "const LICENSE_PROXY_URL = 'https://xvm-license.lengkuxiaomao.workers.dev'",
      "callProxy('validate', { key: stored.key, instance_id: stored.instanceId })",
      "callProxy('activate', { key, instance_name: `Popup — ${deviceId.slice(0, 8)}` })",
      '`${LICENSE_PROXY_URL}/deactivate`',
      'function shouldRevalidate(info, stored)',
      'REVALIDATE_RETRY_MS',
      'isCommunityDev',
    ];
    for (const s of lockedPopup) {
      expect(popupProJs, `popup-pro.js 仍含: ${s}`).toContain(s);
    }
    const lockedBg = [
      "const LICENSE_PROXY_URL = 'https://xvm-license.lengkuxiaomao.workers.dev'",
      "const LICENSE_PROXY_ACTIONS = new Set(['activate', 'validate', 'deactivate'])",
      "message.type === 'XVM_LICENSE_PROXY'",
      'callLicenseProxy(message.action, message.body)',
    ];
    for (const s of lockedBg) {
      expect(backgroundJs, `background.js 仍含: ${s}`).toContain(s);
    }
    // 7 个 XVM_LICENSE_* 字面串（message-contract.mjs 快照）仍在。
    for (const t of [
      'XVM_LICENSE_ACTIVATE', 'XVM_LICENSE_ACTIVATE_RESULT',
      'XVM_LICENSE_DEACTIVATE', 'XVM_LICENSE_DEACTIVATE_RESULT',
      'XVM_LICENSE_PROXY', 'XVM_LICENSE_STATUS', 'XVM_LICENSE_STATUS_REQUEST',
    ]) {
      expect(isolatedJs + backgroundJs, `消息类型 ${t} 仍在`).toContain(t);
    }
    // background.js 未新增任何 __xvm* 赋值（verify.mjs 第 6 项）。
    expect(backgroundJs).not.toMatch(/globalThis\.__xvm\w+\s*=/);
  });
});

// ===========================================================================
// 6. 边界用例
// ===========================================================================
describe('6 / 边界：空 key / 非法 key / 无渠道标志（视为 store）', () => {
  it('边界 1（community + 空 key）：仍早返回 community_dev，不进 KEY_RE 校验，零网络', async () => {
    const h = isolatedHarness(true);
    await h.settle();
    h.reset();
    await h.dispatch('XVM_LICENSE_ACTIVATE', { key: '' });
    const act = h.posted.find((p) => p.type === 'XVM_LICENSE_ACTIVATE_RESULT');
    expect(act).toEqual({ type: 'XVM_LICENSE_ACTIVATE_RESULT', ok: false, error: 'community_dev' });
    expect(h.sent).toHaveLength(0);
    expect(h.licenseFetchCount()).toBe(0);
  });

  it('边界 2（community + 非法格式 key）：仍早返回 community_dev，零网络', async () => {
    const h = isolatedHarness(true);
    await h.settle();
    h.reset();
    await h.dispatch('XVM_LICENSE_ACTIVATE', { key: 'bad key!!' });
    const act = h.posted.find((p) => p.type === 'XVM_LICENSE_ACTIVATE_RESULT');
    expect(act.ok).toBe(false);
    expect(act.error).toBe('community_dev');
    expect(h.sent).toHaveLength(0);
    expect(h.licenseFetchCount()).toBe(0);
  });

  it('边界 3（无渠道标志）：视为 store，ACTIVATE 走完整链路、trial 正常播种', async () => {
    const iso = isolatedHarness(undefined);
    await iso.settle();
    iso.reset();
    await iso.dispatch('XVM_LICENSE_ACTIVATE', { key: 'ABCD1234EFGH5678' });
    expect(iso.sent.some((m) => m && m.type === 'XVM_LICENSE_PROXY')).toBe(true);
    expect(iso.licenseFetchCount()).toBeGreaterThan(0);

    const pop = popupProHarness(undefined);
    await pop.settle();
    expect(pop.trialWrites(), '无标志应视为 store、照常播种').toBe(1);
  });

  it('边界 4（标志显式 false）：ACTIVATE 走完整链路；null / 0 / 字符串都不是 community', async () => {
    for (const flag of ['false', 'null', '0', "'community-dev'"]) {
      const h = isolatedHarness(flag);
      await h.settle();
      h.reset();
      await h.dispatch('XVM_LICENSE_ACTIVATE', { key: 'ABCD1234EFGH5678' });
      expect(h.sent.some((m) => m && m.type === 'XVM_LICENSE_PROXY'),
        `flag=${flag} 不应触发 community 短路`).toBe(true);
      expect(h.licenseFetchCount()).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// 7. 无条件标志时 store 构建语义：resolveTier 既有短路仍在
// ===========================================================================
describe('7 / 既有 community guard 未被破坏（回归护栏）', () => {
  it('isolated.js resolveTier 与 ensureTrialStarted 的既有 guard 仍在', () => {
    expect(isolatedJs).toMatch(/async function resolveTier\(\) \{\s*if \(globalThis\.__xvmIsCommunityDevBuild === true\)/);
    expect(isolatedJs).toContain("if (globalThis.__xvmIsCommunityDevBuild !== true) await ensureTrialStarted();");
  });

  it('popup-pro.js 既有 isCommunityDev 常量 / resolveTier 短路 / 不渲染激活 CTA 仍在', () => {
    expect(popupProJs).toContain('const isCommunityDev = globalThis.__xvmIsCommunityDevBuild === true;');
    expect(popupProJs).toMatch(/async function resolveTier\(\{ revalidate = true \} = \{\}\) \{\s*if \(isCommunityDev\)/);
    expect(popupProJs).toContain("if (tier !== 'pro' && !isCommunityDev) {");
  });

  it('community 下 isolated.js 的 ensureTrialStarted 不写 TRIAL_KEY（既有 guard 真执行）', async () => {
    const h = isolatedHarness(true);
    await h.settle();
    expect(h.store['xvm_trial_v1']).toBeUndefined();
    // store 下则写入。
    const s = isolatedHarness(false);
    await s.settle();
    expect(s.store['xvm_trial_v1']).toBeTruthy();
  });
});
