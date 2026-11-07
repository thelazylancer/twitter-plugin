// ============================================================================
// WP-E 跨模块验收测试（测试工程师产出，最终执行）。
//
// 目的：在 WP-A/B/C/D 全部落盘后，从「跨模块契约」角度验收整体重构，
// 而不是重复各研发包的自测：消息类型零丢失、manifine/popup 加载顺序、
// 单一数据源、文档与代码一致、community 短路、scroll-restore 拆分、
// 状态有界化、origin 校验、bootstrap version、撤销项未被误改、新 lib EOF 纯净。
//
// 约束（team-protocol 铁律）：
//   * 只读取源码并用 node:vm 真执行 / 静态断言，不改任何仓库文件。
//   * 无网络、无 jsdom；仅 node:fs / node:vm / node:child_process / vitest。
//   * 命令一律 env -i HOME="$HOME" PATH="$PATH" node ./node_modules/vitest/vitest.mjs run ...
// ============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const read = (rel) => readFileSync(resolve(repo, rel), 'utf8');

const contentJs = read('content.js');
const backgroundJs = read('background.js');
const popupJs = read('popup.js');
const bridgeJs = read('bridge.js');
const popupHtml = read('popup.html');
const manifest = JSON.parse(read('manifest.json'));
const buildDistMjs = read('scripts/build-dist.mjs');

// ---------------------------------------------------------------------------
// 通用 vm 辅助：复刻 tests/refactor-baseline.test.js 的 extractConstExpr，
// 从具名 const 声明抽出初始化表达式并在 vm 里求值成真实对象。
// ---------------------------------------------------------------------------
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

function evalConst(src, name, prelude = '') {
  const expr = extractConstExpr(src, name);
  const ctx = {};
  vm.runInNewContext(`${prelude}\nconst __V = ${expr};\nthis.VALUE = __V;`, ctx);
  return ctx.VALUE;
}

const GEN_START = '// --- ai-defaults:generated:start ---';
const GEN_END = '// --- ai-defaults:generated:end ---';

// 枚举所有生成区，返回包含目标 const 声明的那一块（popup.js 有 2 处）。
function generatedBlock(src, name) {
  const declRe = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`);
  let cursor = 0;
  for (;;) {
    const s = src.indexOf(GEN_START, cursor);
    if (s < 0) return null;
    const e = src.indexOf(GEN_END, s);
    expect(e, '每个生成区 start 都应配对 end').toBeGreaterThan(-1);
    const block = src.slice(s + GEN_START.length, e);
    if (declRe.test(block)) return block;
    cursor = e + GEN_END.length;
  }
}

function evalGenerated(src, name, prelude = '') {
  const block = generatedBlock(src, name);
  expect(block, `某处生成区应含 ${name} 声明`).toBeTruthy();
  return evalConst(block, name, prelude);
}

// ===========================================================================
// 1. 消息类型零丢失（只增不减，不改「数量相等」）
// ===========================================================================
describe('1 / 消息类型零丢失', () => {
  // 77 个基线 XVM_* 类型（来自 /tmp/xvm-baseline/message-types.json 快照）。
  const BASELINE = [
    'XVM_AI_GENERATE', 'XVM_AI_GENERATE_PROGRESS', 'XVM_AI_GENERATE_RESULT',
    'XVM_AI_GET_PRESETS', 'XVM_AI_TEST_CONNECTION',
    'XVM_BOOKMARK_FOLDER_DIRTY', 'XVM_BOOKMARK_FOLDER_MUTATION',
    'XVM_BOOKMARK_TIMELINE_CACHE_ERROR', 'XVM_BOOKMARK_TIMELINE_CACHE_HYDRATE',
    'XVM_BOOKMARK_TIMELINE_CACHE_RESET', 'XVM_BOOKMARK_TIMELINE_CACHE_START',
    'XVM_BOOKMARK_TIMELINE_CACHE_UPDATE', 'XVM_BOOKMARK_TIMELINE_INJECT_SAVE',
    'XVM_BOOKMARK_TIMELINE_QID_CAPTURED', 'XVM_BOOKMARK_TIMELINE_REFRESH',
    'XVM_BOOKMARK_TIMELINE_SEEN', 'XVM_BOOKMARK_TIMELINE_TXID_REQUEST',
    'XVM_BOOKMARK_TIMELINE_TXID_RESPONSE', 'XVM_CB_STATE_LOAD',
    'XVM_CB_STATE_REQUEST', 'XVM_CB_STATE_SAVE', 'XVM_COMMENT_BOARD_DISABLE',
    'XVM_CONTENT_FILTER_RULES_REFRESH', 'XVM_CONTENT_FILTER_RULES_REFRESH_DONE',
    'XVM_CONTENT_FILTER_RULES_UPDATE', 'XVM_CONTENT_FILTER_SETTINGS_UPDATE',
    'XVM_FOLDERS_UPDATE', 'XVM_FOLLOWING_CLEAR', 'XVM_FOLLOWING_LOAD',
    'XVM_FOLLOWING_REQUEST', 'XVM_FOLLOWING_SAVE', 'XVM_GROK_SELECT_TEMPLATE',
    'XVM_GROK_SETTINGS_LOAD', 'XVM_GROK_SETTINGS_REQUEST',
    'XVM_INTERACTIONS_LOAD', 'XVM_INTERACTIONS_REQUEST', 'XVM_INTERACTIONS_SAVE',
    'XVM_LB_HEIGHT_LOAD', 'XVM_LB_HEIGHT_REQUEST', 'XVM_LB_HEIGHT_SAVE',
    'XVM_LB_POS_LOAD', 'XVM_LB_POS_REQUEST', 'XVM_LB_POS_SAVE',
    'XVM_LB_SIZE_LOAD', 'XVM_LB_SIZE_REQUEST', 'XVM_LB_SIZE_SAVE',
    'XVM_LEADERBOARD_DISABLE', 'XVM_LEADERBOARD_SETTINGS_SAVE',
    'XVM_LICENSE_ACTIVATE', 'XVM_LICENSE_ACTIVATE_RESULT',
    'XVM_LICENSE_DEACTIVATE', 'XVM_LICENSE_DEACTIVATE_RESULT',
    'XVM_LICENSE_PROXY', 'XVM_LICENSE_STATUS', 'XVM_LICENSE_STATUS_REQUEST',
    'XVM_RATE_FILTER_ACTIVE_SCOPE', 'XVM_RATE_FILTER_REQUEST',
    'XVM_RATE_FILTER_SET_ENABLED', 'XVM_RATE_FILTER_SET_SCOPE',
    'XVM_RATE_LIMIT', 'XVM_RATE_SETTINGS_UPDATE',
    'XVM_RECIPROCITY_LOAD', 'XVM_RECIPROCITY_REQUEST', 'XVM_RECIPROCITY_SAVE',
    'XVM_RELEASE_NOTES_DISMISS', 'XVM_RELEASE_NOTES_SHOW',
    'XVM_RELEASE_NOTES_SHOW_MANUAL', 'XVM_REQUEST_FOLDER_REFRESH',
    'XVM_REQUEST_SETTINGS', 'XVM_SC_TEMPLATES_LOAD', 'XVM_SC_TEMPLATES_REQUEST',
    'XVM_SC_TEMPLATE_CAPTURE', 'XVM_SETTINGS_UPDATE', 'XVM_THEME_REQUEST',
    'XVM_THEME_UPDATE', 'XVM_TIER_REQUEST', 'XVM_TIER_UPDATE',
  ];

  // 复刻 message-contract.mjs 的文件枚举（含 lib/*.js 与 license/filter 模块）。
  function collectCurrentTypes() {
    const files = [
      'content.js', 'bridge.js', 'background.js', 'popup.js',
      'popup-dashboard.js', 'popup-reciprocity.js', 'starchart.js', 'bookmark-menu.js',
      ...readdirSync(resolve(repo, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`),
      ...[
        'src/premium/license/isolated.js', 'src/premium/license/gate.js',
        'src/premium/license/popup-pro.js',
        'src/premium/content-filter/filter.js', 'src/premium/rate-filter/filter.js',
      ],
    ];
    const types = new Set();
    for (const f of files) {
      const s = read(f);
      for (const m of s.matchAll(/['"](XVM_[A-Z0-9_]+)['"]/g)) types.add(m[1]);
    }
    return types;
  }

  it('基线恰好 77 个 XVM_* 类型', () => {
    expect(BASELINE).toHaveLength(77);
    expect(new Set(BASELINE).size).toBe(77);
  });

  it('77 个基线 XVM_* 类型在当前源码中仍全部存在（只增不减）', () => {
    const now = collectCurrentTypes();
    const removed = BASELINE.filter((t) => !now.has(t));
    expect(removed, `被移除的类型: ${removed.join(', ')}`).toEqual([]);
    // 明确允许新增：当前集合大小可以 >= 77，不做「数量相等」断言。
    expect(now.size).toBeGreaterThanOrEqual(BASELINE.length);
  });
});

// ===========================================================================
// 2. manifest / popup 加载顺序
// ===========================================================================
describe('2 / manifest 与 popup 加载顺序', () => {
  const main = manifest.content_scripts.find((cs) => cs.world === 'MAIN');
  const iso = manifest.content_scripts.find((cs) => cs.world !== 'MAIN');
  const idx = (arr, f) => arr.indexOf(f);

  it('两个 world 的 js[0] 都是 src/build-channel.js', () => {
    expect(main.js[0]).toBe('src/build-channel.js');
    expect(iso.js[0]).toBe('src/build-channel.js');
    expect(manifest.content_scripts.every((cs) => cs.js[0] === 'src/build-channel.js')).toBe(true);
  });

  it('MAIN world 既有相对顺序契约未被插入项破坏', () => {
    const j = main.js;
    expect(idx(j, 'lib/x-net-hook.js')).toBeLessThan(idx(j, 'lib/timeline-ad-prune.js'));
    expect(idx(j, 'lib/timeline-ad-prune.js')).toBeLessThan(idx(j, 'content.js'));
    expect(idx(j, 'src/premium/license/gate.js')).toBeLessThan(idx(j, 'src/premium/content-filter/rules.js'));
    expect(idx(j, 'src/premium/content-filter/rules.js')).toBeLessThan(idx(j, 'src/premium/content-filter/filter.js'));
    expect(idx(j, 'src/premium/content-filter/filter.js')).toBeLessThan(idx(j, 'src/premium/rate-filter/filter.js'));
    expect(idx(j, 'src/premium/rate-filter/filter.js')).toBeLessThan(idx(j, 'content.js'));
    expect(idx(j, 'src/premium/content-filter/filter.js')).toBeLessThan(idx(j, 'content.js'));
  });

  it('WP-C 新增 lib 的相对顺序：bounded-store < content.js < scroll-restore-guard < starchart.js', () => {
    const seq = main.js.filter((f) => [
      'lib/bounded-store.js', 'content.js', 'lib/scroll-restore-guard.js', 'starchart.js',
    ].includes(f));
    expect(seq).toEqual([
      'lib/bounded-store.js', 'content.js', 'lib/scroll-restore-guard.js', 'starchart.js',
    ]);
  });

  it('popup.html 的 <script src> 是精确 10 项且顺序一致', () => {
    const scripts = [...popupHtml.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
    expect(scripts).toEqual([
      'src/build-channel.js',
      'src/premium/license/tier-logic.js',
      'src/premium/license/entitlement.js',
      'src/premium/license/popup-pro.js',
      'src/premium/rate-filter/popup-rate-filter.js',
      'src/premium/content-filter/rules.js',
      'src/premium/content-filter/popup-content-filter.js',
      'popup.js',
      'popup-dashboard.js',
      'popup-reciprocity.js',
    ]);
  });

  it('background 未声明 module（classic script 约束），两个 content_scripts 也无 module', () => {
    expect(!manifest.background.type || manifest.background.type !== 'module').toBe(true);
    for (const cs of manifest.content_scripts) {
      expect(!cs.type || cs.type !== 'module').toBe(true);
    }
  });
});

// ===========================================================================
// 3. 单一数据源：权威 JSON / 5 处生成区 / 5 处内联常量
// ===========================================================================
describe('3 / 单一数据源一致性', () => {
  const data = JSON.parse(read('src/ai-defaults.data.json'));

  it('src/ai-defaults.data.json 结构完整（zh_CN 6 / en 5 / ja 5 / 8 platform，含 local 预设）', () => {
    expect(Object.keys(data.templates.zh_CN)).toHaveLength(6);
    expect(Object.keys(data.templates.en)).toHaveLength(5);
    expect(Object.keys(data.templates.ja)).toHaveLength(5);
    expect(Object.keys(data.platforms)).toHaveLength(8);
    expect(data.platforms.lmstudio.local).toBe(true);
    expect(data.platforms.ollamaOpenAI.local).toBe(true);
  });

  it('5 处生成区 vm 求值结果 == 权威源', () => {
    const contentGen = generatedBlock(contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES');
    const dgpMatch = contentGen.match(/const DEFAULT_GROK_COMMENT_PROMPT\s*=\s*('(?:[^'\\]|\\.)*')/);
    expect(dgpMatch).toBeTruthy();
    const dgpPrelude = `const DEFAULT_GROK_COMMENT_PROMPT = ${dgpMatch[1]};`;

    const fromContent = evalGenerated(contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES', dgpPrelude);
    const fromPopupDefs = evalGenerated(popupJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const fromBridgeDefs = evalGenerated(bridgeJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const fromPopupPresets = evalGenerated(popupJs, 'AI_PLATFORM_PRESETS');
    const fromBgPresets = evalGenerated(backgroundJs, 'OPENAI_COMPAT_PLATFORMS');

    expect(fromContent).toEqual(data.templates.zh_CN);
    for (const defs of [fromPopupDefs, fromBridgeDefs]) {
      expect(defs.zh_CN.promptTemplates).toEqual(data.templates.zh_CN);
      expect(defs.en.promptTemplates).toEqual(data.templates.en);
      expect(defs.ja.promptTemplates).toEqual(data.templates.ja);
    }
    expect(fromPopupPresets).toEqual(data.platforms);
    expect(fromBgPresets).toEqual(data.platforms);
  });

  it('5 处内联常量求值结果彼此相等（模板 3 处 / 预设 2 处）', () => {
    const cGen = generatedBlock(contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES');
    const dgp = cGen.match(/const DEFAULT_GROK_COMMENT_PROMPT\s*=\s*('(?:[^'\\]|\\.)*')/)[1];
    const prelude = `const DEFAULT_GROK_COMMENT_PROMPT = ${dgp};`;
    const cTpl = evalGenerated(contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES', prelude);
    const pDefs = evalGenerated(popupJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const bDefs = evalGenerated(bridgeJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const pPre = evalGenerated(popupJs, 'AI_PLATFORM_PRESETS');
    const bgPre = evalGenerated(backgroundJs, 'OPENAI_COMPAT_PLATFORMS');

    expect(cTpl).toEqual(pDefs.zh_CN.promptTemplates);
    expect(cTpl).toEqual(bDefs.zh_CN.promptTemplates);
    expect(pDefs).toEqual(bDefs);
    expect(pPre).toEqual(bgPre);
  });

  it('\\n 是运行时真换行 U+000A，而非字面反斜杠+n（防静默回归）', () => {
    const dgpLiteral = generatedBlock(contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES')
      .match(/const DEFAULT_GROK_COMMENT_PROMPT\s*=\s*('(?:[^'\\]|\\.)*')/)[1];
    const runtime = vm.runInNewContext(dgpLiteral, {});
    const realNL = (runtime.match(/\n/g) || []).length;
    const literalSlashN = (runtime.match(/\\n/g) || []).length;
    expect(realNL).toBeGreaterThan(0);
    expect(literalSlashN, '不得出现字面反斜杠+n 两字符序列').toBe(0);
    // 权威源本身也必须是真换行。
    expect(data.templates.zh_CN[0].prompt).toContain('\n');
    expect(data.templates.zh_CN[0].prompt).not.toContain('\\n');
  });
});

// ===========================================================================
// 4. 文档与代码一致
// ===========================================================================
describe('4 / 文档与代码一致', () => {
  const readmeMd = read('README.md');
  const skillMd = read('.claude/skills/release/SKILL.md');
  const changelogMd = read('CHANGELOG.md');

  it('README 不再含「≥600 字走文章模板组」/「文章模板分开存储」误导陈述', () => {
    expect(readmeMd).not.toMatch(/≥?\s*600\s*字.{0,20}文章模板/);
    expect(readmeMd).not.toContain('文章模板**分开存储');
    expect(readmeMd).not.toContain('分开存储');
  });

  it('README :265 推荐 build:community，sync:rules 指向 bootstrap-rules.json', () => {
    expect(readmeMd).toContain('npm run build:community');
    expect(readmeMd).toContain('日常开发请用 `build:community`');
    expect(readmeMd).toContain('bootstrap-rules.json');
  });

  it('.claude/skills/release/SKILL.md 不含 Compress-Archive / 商店上传，git push 只在否定语境', () => {
    expect(skillMd).not.toContain('Compress-Archive');
    // 「git push」只允许出现在「不要 / Do not」等否定语境的行里。
    const pushLines = skillMd.split('\n').filter((l) => l.includes('git push'));
    expect(pushLines.length).toBeGreaterThan(0);
    for (const l of pushLines) {
      expect(/不要|Do not|不执行|no .*push/i.test(l), `git push 出现在非否定语境: ${l}`).toBe(true);
    }
  });

  it('CHANGELOG.md 含 [Unreleased] fork 段', () => {
    expect(changelogMd).toContain('## [Unreleased]');
  });

  it('package-zip.mjs 的上游商店/Edge 误导性文案已清理，功能分支保留', () => {
    const zip = read('scripts/package-zip.mjs');
    // 与新 skill / release.yml 的「不上架、无 License」一致的现状说明（注释跨行，用正则）。
    expect(zip).toMatch(/Chrome Web Store or Edge listing and no License Worker/);
    // 上游残留的肯定式上架指引不应再出现（会误导为本 fork 仍需上架）。
    expect(zip).not.toContain('manual upload');
    expect(zip).not.toContain('上架 Edge 后');
    expect(zip).not.toContain('ALLOWED_ORIGIN');
    expect(zip).not.toContain('Edge listing gets its own');
    // 只清理文案：三个脚本参数与全部函数体必须原样保留。
    for (const fn of ['readChannel', 'readTarget', 'zipName', 'checkManifest', 'checkEdgeBranding', 'main']) {
      expect(zip, `${fn} 函数体仍在`).toMatch(new RegExp(`function ${fn}\\(`));
    }
    expect(zip).toContain("channel === 'community-dev'");
    expect(zip).toContain("target === 'edge' ? 'edge-addons' : 'chrome-web-store'");
  });

  it('scripts/build-dist.mjs 的 readChannel 缺省仍是 store（现状快照）', () => {
    const fn = buildDistMjs.slice(buildDistMjs.indexOf('function readChannel'));
    const head = fn.slice(0, fn.indexOf('}') + 1);
    expect(head).toContain("'store'");
    expect(head).toMatch(/idx >= 0 \? argv\[idx \+ 1\] : 'store'/);
  });
});

// ===========================================================================
// 5. community 不写 trial key + license 精确早返回语义（ok:false, community_dev）
// ===========================================================================
describe('5 / community 短路与 store 通道未回归', () => {
  const isolated = read('src/premium/license/isolated.js');
  const popupPro = read('src/premium/license/popup-pro.js');

  it('popup-pro.js trial 播种被 isCommunityDev guard 包住，refresh() 留在 guard 外', () => {
    // 播种 IIFE 区块：guard 包住 storageGet/storageSet，refresh() 在外面。
    const seedStart = popupPro.indexOf('(async () => {');
    expect(seedStart).toBeGreaterThan(-1);
    const seedBlock = popupPro.slice(seedStart, popupPro.indexOf('})();', seedStart) + 4);
    expect(seedBlock).toContain('if (!isCommunityDev)');
    expect(seedBlock).toContain('TRIAL_KEY');
    expect(seedBlock).toContain('storageSet');
    // refresh() 必须在 guard 块之后（用位置关系断言，不依赖脆弱字符串顺序）。
    const guardAt = seedBlock.indexOf('if (!isCommunityDev)');
    const refreshAt = seedBlock.lastIndexOf('refresh();');
    expect(guardAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(guardAt);
    // 且 refresh() 不在 if 的花括号内（通过缩进/结构：guard 块以 } 闭合后再出现）。
    const afterGuard = seedBlock.slice(guardAt);
    const guardClose = afterGuard.indexOf('\n    }');
    expect(afterGuard.indexOf('refresh();')).toBeGreaterThan(guardClose);
  });

  it('isolated.js 的 callProxy 顶部有 community 早返回（抛 community_dev）', () => {
    const fn = isolated.slice(isolated.indexOf('async function callProxy'));
    const head = fn.slice(0, fn.indexOf('if (LICENSE_PROXY_URL') + 40);
    expect(head).toContain('globalThis.__xvmIsCommunityDevBuild === true');
    expect(head).toContain("throw new Error('community_dev')");
    // 早返回必须位于任何 sendMessage / fetch 之前。
    expect(head.indexOf('community_dev')).toBeLessThan(head.indexOf('LICENSE_PROXY_URL'));
  });

  it('isolated.js 的 ACTIVATE / DEACTIVATE / STATUS_REQUEST 三条消息路径在 community 下早返回 ok:false, community_dev', () => {
    // router 内的早返回：三条分支都必须回 ok:false / error:'community_dev'，
    // 而不是 ok:true（后者会让 UI 误判激活成功）。
    const routerAt = isolated.indexOf("t === 'XVM_LICENSE_STATUS_REQUEST'");
    expect(routerAt).toBeGreaterThan(-1);
    const router = isolated.slice(routerAt, isolated.indexOf('XVM_CONTENT_FILTER_RULES_REFRESH', routerAt));

    // ACTIVATE 分支的 community 早返回（在调用 activate() 之前）。
    const actSeg = router.slice(router.indexOf("t === 'XVM_LICENSE_ACTIVATE'"));
    const actHead = actSeg.slice(0, actSeg.indexOf('const res = await activate'));
    expect(actHead).toContain('XVM_LICENSE_ACTIVATE_RESULT');
    expect(actHead).toContain('ok: false, error: \'community_dev\'');
    // DEACTIVATE 分支同理。
    const deSeg = router.slice(router.indexOf("t === 'XVM_LICENSE_DEACTIVATE'"));
    const deHead = deSeg.slice(0, deSeg.indexOf('const res = await deactivate'));
    expect(deHead).toContain("XVM_LICENSE_DEACTIVATE_RESULT', ok: false, error: 'community_dev'");
    // STATUS_REQUEST 分支的 community 回包。
    const statusHead = router.slice(0, router.indexOf("t === 'XVM_LICENSE_ACTIVATE'"));
    expect(statusHead).toContain('ok: false');
    expect(statusHead).toContain("error: 'community_dev'");
    // 明确不是 ok:true 的错误语义。
    expect(isolated).not.toMatch(/XVM_LICENSE_(ACTIVATE|DEACTIVATE)_RESULT', ok: true, error: 'community_dev'/);
    // getLicenseStatus 的 revalidate 被 community guard 包住。
    expect(isolated).toContain('if (globalThis.__xvmIsCommunityDevBuild !== true) {');
    expect(isolated).toContain('revalidateInBackground');
  });

  it('popup-pro.js 的 activate / deactivate / revalidateStoredLicense 均有 community 早返回 ok:false', () => {
    for (const name of ['activate', 'deactivate', 'revalidateStoredLicense']) {
      const at = popupPro.indexOf(`async function ${name}`) >= 0
        ? popupPro.indexOf(`async function ${name}`)
        : popupPro.indexOf(`function ${name}`);
      expect(at, `应存在函数 ${name}`).toBeGreaterThan(-1);
      const head = popupPro.slice(at, at + 260);
      expect(head, `${name} 应有 community 早返回`).toContain('if (isCommunityDev)');
      expect(head, `${name} 早返回应回 ok:false`).toContain("ok: false, error: 'community_dev'");
    }
  });

  it('store 通道基础设施未被删除（正向锁定字面串与函数体）', () => {
    // isolated.js
    for (const lit of [
      'LICENSE_PROXY_URL', "type: 'XVM_LICENSE_PROXY'", 'callProxy(',
      'async function activate', 'async function deactivate', 'revalidateInBackground',
    ]) {
      expect(isolated, `isolated.js 应仍含 ${lit}`).toContain(lit);
    }
    // popup-pro.js
    for (const lit of [
      'LICENSE_PROXY_URL', "callProxy('validate'", 'shouldRevalidate', 'REVALIDATE_RETRY_MS',
    ]) {
      expect(popupPro, `popup-pro.js 应仍含 ${lit}`).toContain(lit);
    }
    // background.js 的 SW handler 字面串保持不动（删除式修法会红）。
    expect(backgroundJs).toContain('XVM_LICENSE_PROXY');
  });

  it('background.js 未新增任何 globalThis/window/root.__xvm* 赋值（verify 第 6 项护栏）', () => {
    const assignments = [...backgroundJs.matchAll(/(?:window|globalThis|root)\.(__xvm[A-Za-z0-9_]+|__XVM[A-Za-z0-9_]+)\s*=(?![=>])/g)];
    expect(assignments.map((m) => m[1])).toEqual([]);
  });

  it('resolveTier / ensureTrialStarted 既有 community guard 仍在', () => {
    // isolated.js :285 resolveTier 短路 + :464(附近) bootstrap guard。
    expect(isolated).toContain("source: 'community-dev'");
    expect(isolated).toContain('__xvmIsCommunityDevBuild !== true) await ensureTrialStarted()');
    // popup-pro.js resolveTier 短路。
    expect(popupPro).toContain("return { tier: 'pro', daysLeft: 0, source: 'community-dev', record: null }");
  });
});

// ===========================================================================
// 6. scroll-restore 拆分
// ===========================================================================
describe('6 / scroll-restore 拆分', () => {
  const guardLib = read('lib/scroll-restore-guard.js');
  const MARKER = '// Back-navigation scroll-restore guard.';

  it('新 lib 含标记且被 manifest 注册在 content.js 之后、starchart.js 之前', () => {
    expect(guardLib).toContain(MARKER);
    const main = manifest.content_scripts.find((cs) => cs.world === 'MAIN');
    expect(main.js.indexOf('lib/scroll-restore-guard.js')).toBeGreaterThan(main.js.indexOf('content.js'));
    expect(main.js.indexOf('lib/scroll-restore-guard.js')).toBeLessThan(main.js.indexOf('starchart.js'));
  });

  it('tests/back-scroll-restore.test.js 读取目标已指向新 lib（30/30 全绿即契约成立）', () => {
    const t = read('tests/back-scroll-restore.test.js');
    expect(t).toContain('lib/scroll-restore-guard.js');
    // 该测试自身用 EOF 切片加载 lib，若迁移正确则它已单独全绿；这里只锁读取路径。
  });

  it('content.js 不再含 scroll-restore IIFE 主体，但保留 getTweetIdFromArticle 与 Periodic re-render 切片边界', () => {
    expect(contentJs).not.toContain(MARKER);
    expect(contentJs).toContain('function getTweetIdFromArticle(');
    expect(contentJs).toContain('\n// Periodic re-render');
  });
});

// ===========================================================================
// 7. 状态有界化
// ===========================================================================
describe('7 / 状态有界化', () => {
  const bounded = read('lib/bounded-store.js');

  it('lib/bounded-store.js 提供 FIFO 上限与 60s 清扫，并暴露唯一 __xvmBoundedStore', () => {
    expect(bounded).toContain('DEFAULT_MAX');
    expect(bounded).toMatch(/DEFAULT_MAX\s*=\s*5000/);
    expect(bounded).toContain('sweep');
    expect(bounded).toContain('setInterval(sweep');
    expect(bounded).toContain('root.__xvmBoundedStore =');
    // 无 import/export（classic script）。
    expect(bounded).not.toMatch(/^\s*(?:import|export)\s/m);
  });

  it('content.js 最末行有 bounded-store 清扫调用，且 4 个状态容器都被接管', () => {
    expect(/__xvmBoundedStore\.sweep\(\)/.test(contentJs.slice(-500))).toBe(true);
    for (const c of ['tweetDataStore', 'promotedTweetIds', 'leaderboardItemMeta', 'commentBoardItemMeta']) {
      expect(contentJs, `content.js 应仍有容器 ${c}`).toContain(c);
    }
    expect(contentJs).toContain('__xvmBoundedStore');
  });
});

// ===========================================================================
// 8. origin 校验
// ===========================================================================
describe('8 / origin 校验', () => {
  it('content.js :245 主 message handler 同时含 source 与 origin 双校验', () => {
    const at = contentJs.indexOf("window.addEventListener('message'");
    const seg = contentJs.slice(at, at + 400);
    expect(seg).toContain('event.source !== window');
    expect(seg).toContain('event.origin !== window.location.origin');
  });

  it('content.js :601 附近 aiPendingRequests 三重校验结构未被破坏', () => {
    const at = contentJs.indexOf('XVM_AI_GENERATE_PROGRESS');
    // 从标记往回找最近的 addEventListener('message'。
    const back = contentJs.lastIndexOf("window.addEventListener('message'", at);
    expect(back).toBeGreaterThan(-1);
    const seg = contentJs.slice(back, at + 200);
    expect(seg).toContain('event.source !== window');
    expect(seg).toContain('event.origin !== window.location.origin');
    expect(seg).toContain('aiPendingRequests.get(event.data.requestId)');
  });
});

// ===========================================================================
// 9. bootstrap version 2
// ===========================================================================
describe('9 / bootstrap version 2', () => {
  it('bootstrap-rules.json version === 2，rules.js 含全部 bootstrap rule id', () => {
    const bootstrap = JSON.parse(read('src/premium/content-filter/bootstrap-rules.json'));
    expect(bootstrap.version).toBe(2);
    const ids = (bootstrap.rules || []).map((r) => r.id);
    expect(ids.length).toBeGreaterThan(0);
    const rulesJs = read('src/premium/content-filter/rules.js');
    expect(rulesJs).toContain('__xvmContentFilterBuiltinRules');
    for (const id of ids) {
      expect(rulesJs, `rules.js 应含 bootstrap rule id ${id}`).toContain(id);
    }
  });
});

// ===========================================================================
// 10. ad-prune / prompt-normalize 撤销项未被误改
// ===========================================================================
describe('10 / 撤销项未被误改', () => {
  it('content.js :3 仍有 window.__xvmDisableAdPrune = true，:728 的订阅与 patch 仍在', () => {
    expect(contentJs).toContain('window.__xvmDisableAdPrune = true;');
    expect(contentJs).toContain('onResponsePatch(TIMELINE_AD_PRUNE_RE');
    expect(contentJs).toContain('patchTimelineResponse');
  });

  it('prompt-normalize 标记仍在 content.js，且区块是完整函数体、不读 window', () => {
    const START = '// --- prompt-normalize:start ---';
    const END = '// --- prompt-normalize:end ---';
    const s = contentJs.indexOf(START);
    const e = contentJs.indexOf(END);
    expect(s).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(-1);
    const block = contentJs.slice(s + START.length, e);
    // 三处测试用裸 vm 切块执行（window 未定义），故区块内不得引用 window。
    expect(block).not.toMatch(/\bwindow\b/);
    // 区块内是完整函数体（含 normalizeGrokPromptText / renderGrokContext）。
    expect(block).toContain('normalizeGrokPromptText');
    expect(block).toContain('renderGrokContext');
    // 真在裸 vm 里执行一遍，证明不依赖 window。
    const ctx = {};
    expect(() => vm.runInNewContext(`${block}\nthis.HAS = typeof normalizeGrokPromptText === 'function' && typeof renderGrokContext === 'function';`, ctx)).not.toThrow();
    expect(ctx.HAS).toBe(true);
  });
});

// ===========================================================================
// 11. scroll-restore 新 lib EOF 纯净性
// ===========================================================================
describe('11 / 新 lib EOF 纯净性', () => {
  const guardLib = read('lib/scroll-restore-guard.js');
  const MARKER = '// Back-navigation scroll-restore guard.';

  it('从标记到 EOF 只有标记行 + 一个 IIFE（无第二个顶层语句、无 sweepAll）', () => {
    const after = guardLib.slice(guardLib.indexOf(MARKER));
    const codeLines = after.split('\n').filter((l) => l.trim() && !/^\s*(?:\/\/|\*|\/\*)/.test(l));
    expect(codeLines.length, `EOF 切片代码行数: ${codeLines.length}`).toBeGreaterThanOrEqual(2);
    expect(codeLines[0].trim().startsWith('(() =>')).toBe(true);
    expect(codeLines[codeLines.length - 1].trim().startsWith('})();')).toBe(true);
    // 顶层只有 IIFE 开合两个语句（中间是函数体，非顶层）。
    expect(after).not.toContain('__xvmBoundedStore');
    expect(after).not.toContain('sweepAll');
    expect(after).not.toContain('// Periodic re-render');
    expect(after).not.toMatch(/^\s*(?:import|export)\s/m);
    // 标记只出现一次。
    expect((guardLib.match(/\/\/ Back-navigation scroll-restore guard\./g) || []).length).toBe(1);
  });

  it('tests/back-scroll-restore.test.js 用无结束边界的 EOF 切片读新 lib', () => {
    const t = read('tests/back-scroll-restore.test.js');
    // 该测试依赖 EOF 切片（slice(indexOf(MARKER))，无结束边界），
    // 所以新 lib 的标记之后必须绝对纯净（由上一项断言保证）。
    expect(t).toContain('lib/scroll-restore-guard.js');
    expect(t).toContain('indexOf(MARKER)');
    // 30/30 全绿由该测试自身证明；这里只锁「读取路径 + 无结束边界切片」契约，
    // 不重复实现它那套 vm stub（node:vm 真执行已在 back-scroll-restore.test.js 内）。
    const sliceCall = t.match(/slice\([^)]*indexOf\(MARKER\)[^)]*\)/);
    expect(sliceCall, '应存在 slice(indexOf(MARKER)) 的 EOF 切片').toBeTruthy();
  });
});
