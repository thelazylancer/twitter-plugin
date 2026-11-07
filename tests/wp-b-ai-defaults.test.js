// WP-B 自测：AI 默认值 / Provider 预设的单一数据源基建。
//
// 设计（总指挥官裁决）：src/ai-defaults.data.json 是唯一权威数据；
// scripts/sync-ai-defaults.mjs 在构建期把同一份数据内联写入 4 个消费者文件的
// `// --- ai-defaults:generated:start/end ---` 标记区。因为 4 个消费者分属
// 不同 realm（扩展页面 / ISOLATED world / MAIN world / service worker），且
// popup.html 的 <script> 列表被测试精确锁定、background.js 在裸 vm 里执行，
// 所以不能用运行时全局对象，也不能新增 <script>。
//
// 本测试只读 + 在临时目录里跑生成器（不改仓库文件），用 node:vm 真执行生成区
// 的字面量，锁住「数据 == 消费者 == 改动前基线」三级一致性。

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const read = (rel) => readFileSync(resolve(repo, rel), 'utf8');

// 重构前的固定基线提交。绝不能用 HEAD：一旦本重构被提交，HEAD 就会包含本次
// 改动，所有「与改动前对比」的断言会拿改后源码当基线，导致误报（例如 manifest
// 增量契约把 2 个新 lib 重复插入期望数组）。锁死到父提交可保证提交前后都稳定。
const BASELINE_REF = 'c65a035';

const START = '// --- ai-defaults:generated:start ---';
const END = '// --- ai-defaults:generated:end ---';

const data = JSON.parse(read('src/ai-defaults.data.json'));
const contentJs = read('content.js');
const popupJs = read('popup.js');
const bridgeJs = read('bridge.js');
const backgroundJs = read('background.js');
const popupHtml = read('popup.html');
const manifest = JSON.parse(read('manifest.json'));
const packageJson = JSON.parse(read('package.json'));
const genScript = read('scripts/sync-ai-defaults.mjs');

// 从具名 const 声明抽出初始化表达式（复刻 tests/refactor-baseline.test.js:95
// 的 extractConstExpr，保证和基线护栏用同一种解析方式）。
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

// 取出 content.js 的单引号字符串常量（只读文本，不改源码）。
function dgpLiteral(src) {
  const m = src.match(/const DEFAULT_GROK_COMMENT_PROMPT\s*=\s*('(?:[^'\\]|\\.)*')/);
  expect(m, 'DEFAULT_GROK_COMMENT_PROMPT 必须是单引号字符串').toBeTruthy();
  return m[1];
}

function evalDgp(src) {
  const ctx = {};
  vm.runInNewContext(`this.V = ${dgpLiteral(src)};`, ctx);
  return ctx.V;
}

// 取出某文件所有标记区（start 行号 / end 行号 / 区间文本）。
function markerRegions(src, filename) {
  const lines = src.split('\n');
  const starts = [];
  const ends = [];
  lines.forEach((l, i) => {
    if (l.trim() === START) starts.push(i);
    if (l.trim() === END) ends.push(i);
  });
  expect(starts.length, `${filename} 的 start 标记数`).toBeGreaterThan(0);
  expect(ends.length, `${filename} 的 end 标记数`).toBe(starts.length);
  return starts.map((s, idx) => {
    const e = ends[idx];
    expect(e, `${filename} 第 ${idx + 1} 个 end 必须在 start 之后`).toBeGreaterThan(s);
    return {
      startLine: s + 1,
      endLine: e + 1,
      body: lines.slice(s + 1, e).join('\n'),
    };
  });
}

// 校验生成区是「纯 JS 对象字面量」：单引号值、裸键、不含 JSON 双引号键、
// 不含全局引用 / import / export / importScripts。
function assertPureLiteral(body, label) {
  expect(body, `${label} 不得引用 __xvm 全局`).not.toMatch(/__xvm/i);
  expect(body, `${label} 不得含 import/export`).not.toMatch(/^\s*(?:import|export)\b/m);
  expect(body, `${label} 不得含 importScripts`).not.toContain('importScripts');
  expect(body, `${label} 不得含 JSON 双引号键`).not.toMatch(/"(?:id|name|prompt|label|baseUrl|model|local|promptTemplates|zh_CN|en|ja)"\s*:/);
  expect(body, `${label} 必须保留 const 声明`).toMatch(/const\s+[A-Z_]+\s*=/);
}

// ===========================================================================
// 1. 权威数据结构
// ===========================================================================
describe('1 / src/ai-defaults.data.json 结构', () => {
  it('3 语种条数 zh_CN=6 / en=5 / ja=5，字段为 id/name/prompt', () => {
    expect(Object.keys(data.templates).sort()).toEqual(['en', 'ja', 'zh_CN']);
    expect(data.templates.zh_CN).toHaveLength(6);
    expect(data.templates.en).toHaveLength(5);
    expect(data.templates.ja).toHaveLength(5);
    for (const list of Object.values(data.templates)) {
      for (const t of list) {
        expect(Object.keys(t).sort()).toEqual(['id', 'name', 'prompt']);
        expect(typeof t.id).toBe('string');
        expect(typeof t.name).toBe('string');
        expect(typeof t.prompt).toBe('string');
      }
    }
  });

  it('8 个 platform，键顺序固定，local:true 只在 lmstudio / ollamaOpenAI', () => {
    const keys = Object.keys(data.platforms);
    expect(keys).toEqual([
      'openai', 'deepseek', 'openrouter', 'kimi', 'qwen', 'siliconflow', 'lmstudio', 'ollamaOpenAI',
    ]);
    expect(keys).toHaveLength(8);
    for (const [k, v] of Object.entries(data.platforms)) {
      expect(Object.keys(v).sort()).toEqual(
        k === 'lmstudio' || k === 'ollamaOpenAI'
          ? ['baseUrl', 'label', 'local', 'model']
          : ['baseUrl', 'label', 'model'],
      );
      expect(v.label).toBeTruthy();
      expect(v.baseUrl).toMatch(/^https?:\/\//);
      expect(v.model).toBeTruthy();
      expect(v.local).toBe(k === 'lmstudio' || k === 'ollamaOpenAI' ? true : undefined);
    }
  });

  it('defaultCommentPrompt === templates.zh_CN[0].prompt，且含真换行 U+000A', () => {
    expect(data.defaultCommentPrompt).toBe(data.templates.zh_CN[0].prompt);
    expect(data.defaultCommentPrompt).toContain('\n');           // 真换行
    expect(data.defaultCommentPrompt).not.toContain('\\n');       // 不是字面反斜杠+n
  });
});

// ===========================================================================
// 2. 标记区存在性 + 纯字面量
// ===========================================================================
describe('2 / 4 个消费者文件的生成标记区', () => {
  const regions = {
    'content.js': markerRegions(contentJs, 'content.js'),
    'popup.js': markerRegions(popupJs, 'popup.js'),
    'bridge.js': markerRegions(bridgeJs, 'bridge.js'),
    'background.js': markerRegions(backgroundJs, 'background.js'),
  };

  it('content.js / bridge.js / background.js 各 1 个标记区，popup.js 有 2 个', () => {
    expect(regions['content.js']).toHaveLength(1);
    expect(regions['bridge.js']).toHaveLength(1);
    expect(regions['background.js']).toHaveLength(1);
    expect(regions['popup.js']).toHaveLength(2);
  });

  it('每个标记区都是纯 JS 字面量（单引号 / 裸键 / 无全局 / 无 ESM）', () => {
    for (const [file, rs] of Object.entries(regions)) {
      rs.forEach((r, i) => {
        assertPureLiteral(r.body, `${file}#${i + 1}`);
      });
    }
  });

  it('生成器源码声明了 4 个目标文件与 start/end 标记常量', () => {
    for (const f of ['content.js', 'popup.js', 'bridge.js', 'background.js']) {
      expect(genScript).toContain(`'${f}'`);
    }
    expect(genScript).toContain(START);
    expect(genScript).toContain(END);
  });
});

// ===========================================================================
// 3. 最高优先级：生成区 vm 求值 == 权威 JSON == 改动前基线（逐字节）
// ===========================================================================
describe('3 / 数据 == 消费者 == 改动前基线（真换行语义）', () => {
  const contentPrelude = `const DEFAULT_GROK_COMMENT_PROMPT = ${dgpLiteral(contentJs)};`;
  const now = {
    contentDgp: evalDgp(contentJs),
    contentTpl: evalConst(contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES', contentPrelude),
    popupDefs: evalConst(popupJs, 'GROK_DEFAULTS_BY_LANGUAGE'),
    popupPresets: evalConst(popupJs, 'AI_PLATFORM_PRESETS'),
    bridgeDefs: evalConst(bridgeJs, 'GROK_DEFAULTS_BY_LANGUAGE'),
    bgPresets: evalConst(backgroundJs, 'OPENAI_COMPAT_PLATFORMS'),
  };

  // 用 git show <BASELINE_REF>:<file> 取改动前源码，求值作为「基线原值」。
  function gitShow(rel) {
    return execFileSync('git', ['show', `${BASELINE_REF}:${rel}`], { cwd: repo, encoding: 'utf8' });
  }
  const headContent = gitShow('content.js');
  const headPopup = gitShow('popup.js');
  const headBridge = gitShow('bridge.js');
  const headBg = gitShow('background.js');
  const headPrelude = `const DEFAULT_GROK_COMMENT_PROMPT = ${dgpLiteral(headContent)};`;
  const base = {
    contentDgp: evalDgp(headContent),
    contentTpl: evalConst(headContent, 'DEFAULT_GROK_PROMPT_TEMPLATES', headPrelude),
    popupDefs: evalConst(headPopup, 'GROK_DEFAULTS_BY_LANGUAGE'),
    popupPresets: evalConst(headPopup, 'AI_PLATFORM_PRESETS'),
    bridgeDefs: evalConst(headBridge, 'GROK_DEFAULTS_BY_LANGUAGE'),
    bgPresets: evalConst(headBg, 'OPENAI_COMPAT_PLATFORMS'),
  };

  // 跨 vm realm 的对象原型不同，用 JSON.stringify 做逐字节比较。
  const J = JSON.stringify;

  it('5 处消费者求值结果与改动前基线提交 c65a035 逐字节相等', () => {
    for (const k of Object.keys(base)) {
      expect(J(now[k]), `${k} 与改动前不一致`).toBe(J(base[k]));
    }
  });

  it('5 处消费者求值结果与权威 JSON 逐字节相等', () => {
    expect(J(now.contentTpl)).toBe(J(data.templates.zh_CN));
    expect(J(now.popupDefs.zh_CN.promptTemplates)).toBe(J(data.templates.zh_CN));
    expect(J(now.popupDefs.en.promptTemplates)).toBe(J(data.templates.en));
    expect(J(now.popupDefs.ja.promptTemplates)).toBe(J(data.templates.ja));
    expect(J(now.bridgeDefs.zh_CN.promptTemplates)).toBe(J(data.templates.zh_CN));
    expect(J(now.popupPresets)).toBe(J(data.platforms));
    expect(J(now.bgPresets)).toBe(J(data.platforms));
    expect(now.contentDgp).toBe(data.defaultCommentPrompt);
  });

  it('关键回归：生成的 prompt 含真 U+000A、不含字面反斜杠+n 文本', () => {
    const allPrompts = [
      ...Object.values(data.templates).flatMap((list) => list.map((t) => t.prompt)),
    ];
    for (const p of allPrompts) {
      expect(p).toContain('\n');
      expect(p).not.toContain('\\n');
    }
    // 逐项与生成区求值结果比对（含中文/日文/curly quotes）。
    const genZh = now.contentTpl;
    for (let i = 0; i < genZh.length; i++) {
      expect(genZh[i].prompt).toBe(base.contentTpl[i].prompt);
    }
    expect(now.popupDefs.en.promptTemplates.find((t) => t.id === 'point-by-point').prompt)
      .toContain('“great insights”');
  });

  it('content.js 首项继续引用 DEFAULT_GROK_COMMENT_PROMPT 标识符', () => {
    const region = markerRegions(contentJs, 'content.js')[0].body;
    expect(region).toContain('prompt: DEFAULT_GROK_COMMENT_PROMPT');
  });
});

// ===========================================================================
// 4. 现有测试锁定的文本形态（单引号 / 裸键 / 关键字面串）
// ===========================================================================
describe('4 / 现有文本扫描断言的形态护栏', () => {
  it('popup.js / bridge.js 含被 popup-dashboard.test.js:488-499 锁定的字面串', () => {
    for (const src of [popupJs, bridgeJs]) {
      expect(src).toContain("id: 'short-cn', name: '中文短评'");
      expect(src).toContain("id: 'tieba-laoge', name: '贴吧老哥'");
      expect(src).toContain('用贴吧老哥的语气为该推文生成3条评论。');
      expect(src).toContain('整体阴阳怪气，但不带脏字、不人身攻击');
      expect(src).toContain('每条评论控制在 30 字以内，简短精悍');
      expect(src).toContain('{推文内容}\\n\\n{关注状态}\\n\\n');
      expect(src).toContain('关注状态只用来判断该用什么分寸，不要把它写进回复里');
    }
  });

  it('DEFAULT_GROK_COMMENT_PROMPT 是单引号字符串（基线 D 组正则）', () => {
    expect(contentJs).toMatch(/const DEFAULT_GROK_COMMENT_PROMPT\s*=\s*('(?:[^'\\]|\\.)*')/);
  });

  it('8 个 platform 名仍是裸键且出现在 popup.js 与 background.js', () => {
    for (const key of Object.keys(data.platforms)) {
      expect(popupJs).toContain(key);
      expect(backgroundJs).toContain(key);
      expect(popupJs).toMatch(new RegExp(`\\b${key}:\\s*\\{`));
      expect(backgroundJs).toMatch(new RegExp(`\\b${key}:\\s*\\{`));
    }
  });
});

// ===========================================================================
// 5. background.js 在裸 vm 里仍可执行（复刻 ai-background-parser.test.js）
// ===========================================================================
describe('5 / background.js 裸 vm 可执行性', () => {
  it('context 仅 chrome/fetch/URL/AbortController/TextDecoder/timers/console 时可整文件执行', () => {
    const context = {
      chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: {
          sync: { get: async () => ({}) },
          local: { get: async () => ({}) },
        },
      },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      URL,
      AbortController,
      TextDecoder,
      setTimeout,
      clearTimeout,
      console,
    };
    vm.createContext(context);
    expect(() => vm.runInContext(backgroundJs, context)).not.toThrow();
    expect(typeof context.renderPrompt).toBe('function');
    expect(typeof context.extractComments).toBe('function');
  });
});

// ===========================================================================
// 6. 生成器幂等（在 /tmp 副本上跑两次，绝不改仓库文件）
// ===========================================================================
describe('6 / 生成器幂等', () => {
  it('在临时副本上连跑两次，4 个目标文件字节不变', () => {
    const tmp = mkdtempSync('/tmp/wp-b-idempotent-');
    try {
      // 复制生成器需要的全部输入：脚本、数据、4 个目标文件。
      cpSync(resolve(repo, 'scripts/sync-ai-defaults.mjs'), join(tmp, 'scripts/sync-ai-defaults.mjs'));
      cpSync(resolve(repo, 'src/ai-defaults.data.json'), join(tmp, 'src/ai-defaults.data.json'));
      for (const f of ['content.js', 'popup.js', 'bridge.js', 'background.js']) {
        cpSync(resolve(repo, f), join(tmp, f));
      }
      const run = () => execFileSync(process.execPath, ['scripts/sync-ai-defaults.mjs'], {
        cwd: tmp, encoding: 'utf8',
      }).trim();
      const first = run();
      const snapshot = Object.fromEntries(
        ['content.js', 'popup.js', 'bridge.js', 'background.js'].map((f) => [
          f, readFileSync(join(tmp, f)),
        ]),
      );
      const second = run();
      expect(first).toBe('[sync-ai-defaults] regenerated 4 files');
      expect(second).toBe('[sync-ai-defaults] regenerated 4 files');
      for (const [f, buf] of Object.entries(snapshot)) {
        expect(Buffer.compare(buf, readFileSync(join(tmp, f))), `${f} 第二次运行字节变化`).toBe(0);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('生成区求值结果 == 权威数据（临时副本产物也一致）', () => {
    // 已在第 3 组对仓库文件验证；此处额外确认生成器输出可独立 vm 求值。
    const body = markerRegions(backgroundJs, 'background.js')[0].body;
    const ctx = {};
    vm.runInNewContext(`${body}\nthis.VALUE = OPENAI_COMPAT_PLATFORMS;`, ctx);
    expect(JSON.stringify(ctx.VALUE)).toBe(JSON.stringify(data.platforms));
  });
});

// ===========================================================================
// 7. package.json scripts / manifest / popup.html 未被越界改动
// ===========================================================================
describe('7 / 构建配置与未越界契约', () => {
  const distScripts = [
    'build:dist', 'build:store', 'build:community',
    'package:store', 'package:community', 'package:edge',
  ];

  it('6 个产 dist 的 scripts 都链入 sync-ai-defaults.mjs', () => {
    for (const s of distScripts) {
      expect(packageJson.scripts[s], `${s} 含生成器`).toContain('node scripts/sync-ai-defaults.mjs');
      // 生成器必须排在 build-dist.mjs 之前
      expect(packageJson.scripts[s].indexOf('sync-ai-defaults.mjs'))
        .toBeLessThan(packageJson.scripts[s].indexOf('build-dist.mjs'));
    }
  });

  it('新增独立命令 sync:ai-defaults', () => {
    expect(packageJson.scripts['sync:ai-defaults']).toBe('node scripts/sync-ai-defaults.mjs');
  });

  it('保留原有 --channel store / --channel community-dev 字面串', () => {
    expect(packageJson.scripts['build:dist']).toContain('--channel store');
    expect(packageJson.scripts['build:store']).toContain('--channel store');
    expect(packageJson.scripts['build:community']).toContain('--channel community-dev');
    expect(packageJson.scripts['package:store']).toContain('--channel store');
    expect(packageJson.scripts['package:community']).toContain('--channel community-dev');
    expect(packageJson.scripts['package:edge']).toContain('--channel store');
  });

  it('package.json 除 scripts 外其它字段未变（与基线提交 c65a035 比对）', () => {
    const head = JSON.parse(execFileSync('git', ['show', `${BASELINE_REF}:package.json`], { cwd: repo, encoding: 'utf8' }));
    for (const k of Object.keys(head)) {
      if (k === 'scripts') continue;
      expect(packageJson[k], `字段 ${k} 不应改动`).toEqual(head[k]);
    }
  });

  it('popup.html 的 <script src> 仍是精确 10 项', () => {
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

  // 精确增量契约（总指挥官 2026-11-07 裁决）：WP-C 在 MAIN world js 数组按
  // 相对顺序新增了 2 个 lib，manifest 其余字段必须与基线提交 c65a035 逐字/逐项
  // 一致。不弱化为「只检查新 lib 存在」，也不回退 manifest（那会让新 lib 不被加载）。
  it('manifest 仅 MAIN world js 数组按裁决新增 2 个 lib，其余与基线提交 c65a035 一致', () => {
    const head = JSON.parse(
      execFileSync('git', ['show', `${BASELINE_REF}:manifest.json`], { cwd: repo, encoding: 'utf8' }),
    );
    const cur = JSON.parse(read('manifest.json'));

    // 按 world 定位两个 content_script（不依赖数组下标假设）。
    const mainIdx = cur.content_scripts.findIndex((cs) => cs.world === 'MAIN');
    const isoIdx = cur.content_scripts.findIndex((cs) => cs.world !== 'MAIN');
    const hMainIdx = head.content_scripts.findIndex((cs) => cs.world === 'MAIN');
    const hIsoIdx = head.content_scripts.findIndex((cs) => cs.world !== 'MAIN');
    expect(mainIdx, '当前 manifest 应有 MAIN world').toBeGreaterThan(-1);
    expect(isoIdx, '当前 manifest 应有 ISOLATED world').toBeGreaterThan(-1);
    expect(hMainIdx).toBe(mainIdx);
    expect(hIsoIdx).toBe(isoIdx);

    const hMainJs = head.content_scripts[hMainIdx].js;
    const cMainJs = cur.content_scripts[mainIdx].js;
    const contentAt = hMainJs.indexOf('content.js');
    expect(contentAt, '基线提交 MAIN js 应含 content.js').toBeGreaterThan(-1);
    // 锚定「基线确实是改动前」：固定提交里不应有本次新增的两个 lib。否则说明
    // BASELINE_REF 指错了提交，整个增量契约会退化成同义反复。
    expect(hMainJs, `${BASELINE_REF} 不应含本次新增的 lib`).not.toContain('lib/bounded-store.js');
    expect(hMainJs, `${BASELINE_REF} 不应含本次新增的 lib`).not.toContain('lib/scroll-restore-guard.js');

    // 2) MAIN world js == 基线提交 + 恰好两个新条目，其余条目相对顺序不变：
    //    bounded-store 在 content.js 之前；scroll-restore-guard 在 content.js
    //    之后、starchart.js 之前。逐项 toEqual 保证无第三条增删或重排。
    const expectedMainJs = [
      ...hMainJs.slice(0, contentAt),
      'lib/bounded-store.js',
      'content.js',
      'lib/scroll-restore-guard.js',
      ...hMainJs.slice(contentAt + 1),
    ];
    expect(cMainJs).toEqual(expectedMainJs);
    // 显式锚定四处相对顺序（含 js[0]）。
    expect(cMainJs[0]).toBe('src/build-channel.js');
    expect(cMainJs.filter((f) => [
      'lib/bounded-store.js', 'content.js', 'lib/scroll-restore-guard.js', 'starchart.js',
    ].includes(f))).toEqual([
      'lib/bounded-store.js', 'content.js', 'lib/scroll-restore-guard.js', 'starchart.js',
    ]);

    // 3) ISOLATED world 的 js 数组与基线提交 c65a035 逐字相等。
    expect(cur.content_scripts[isoIdx].js).toEqual(head.content_scripts[hIsoIdx].js);

    // 4) 除 content_scripts[MAIN].js 之外的所有字段与基线提交 c65a035 深度相等
    //    （version / background / action / host_permissions / icons / CSS 数组 /
    //     world / matches / run_at …），守住 WP-B「本包不改 manifest」的护栏意图。
    const stripMainJs = (m) => {
      const x = JSON.parse(JSON.stringify(m));
      const mi = x.content_scripts.findIndex((cs) => cs.world === 'MAIN');
      x.content_scripts[mi].js = [];
      return x;
    };
    expect(stripMainJs(cur)).toEqual(stripMainJs(head));

    // 5) 两个 world 的 js[0] 仍是 build-channel.js。
    expect(cur.content_scripts.every((cs) => cs.js[0] === 'src/build-channel.js')).toBe(true);
  });

  it('不存在 lib/ai-defaults.js（本方案不产出运行时全局）', () => {
    expect(existsSync(resolve(repo, 'lib/ai-defaults.js'))).toBe(false);
  });
});

// ===========================================================================
// 8. 边界用例（至少 2 个）
// ===========================================================================
describe('8 / 边界用例', () => {
  it('边界 1：生成器在缺标记的文件上必须报错退出，不静默插入', () => {
    const tmp = mkdtempSync('/tmp/wp-b-missing-');
    try {
      mkdirSync(join(tmp, 'scripts'), { recursive: true });
      mkdirSync(join(tmp, 'src'), { recursive: true });
      cpSync(resolve(repo, 'scripts/sync-ai-defaults.mjs'), join(tmp, 'scripts/sync-ai-defaults.mjs'));
      cpSync(resolve(repo, 'src/ai-defaults.data.json'), join(tmp, 'src/ai-defaults.data.json'));
      for (const f of ['content.js', 'popup.js', 'bridge.js', 'background.js']) {
        // 剥掉所有标记行，模拟「标记缺失」
        const src = read(resolve(repo, f)).split('\n')
          .filter((l) => l.trim() !== START && l.trim() !== END)
          .join('\n');
        writeFileSync(join(tmp, f), src);
      }
      let threw = false;
      let stderr = '';
      try {
        execFileSync(process.execPath, ['scripts/sync-ai-defaults.mjs'], {
          cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        threw = true;
        stderr = String(e.stderr || '');
      }
      expect(threw, '缺标记时生成器必须抛错').toBe(true);
      expect(stderr).toContain('missing // --- ai-defaults:generated:start ---');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('边界 2：非法 JSON（缺字段 / 非 JSON）时生成器报错退出', () => {
    const tmp = mkdtempSync('/tmp/wp-b-badjson-');
    try {
      mkdirSync(join(tmp, 'scripts'), { recursive: true });
      mkdirSync(join(tmp, 'src'), { recursive: true });
      cpSync(resolve(repo, 'scripts/sync-ai-defaults.mjs'), join(tmp, 'scripts/sync-ai-defaults.mjs'));
      for (const f of ['content.js', 'popup.js', 'bridge.js', 'background.js']) {
        cpSync(resolve(repo, f), join(tmp, f));
      }
      const badCases = [
        '{ not json',                                     // 非 JSON
        JSON.stringify({ templates: {}, platforms: {} }), // 缺 defaultCommentPrompt / zh_CN[0]
        JSON.stringify({ ...data, defaultCommentPrompt: 'MISMATCH' }), // 与 zh_CN[0] 不一致
      ];
      for (const bad of badCases) {
        writeFileSync(join(tmp, 'src/ai-defaults.data.json'), bad);
        let threw = false;
        try {
          execFileSync(process.execPath, ['scripts/sync-ai-defaults.mjs'], {
            cwd: tmp, encoding: 'utf8', stdio: 'pipe',
          });
        } catch (_) { threw = true; }
        expect(threw, `非法数据应报错: ${bad.slice(0, 40)}`).toBe(true);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('边界 3：JS 字面量序列化器正确转义特殊字符（反斜杠/单引号/控制字符/U+2028）', () => {
    // 直接把生成器的 quoteString 抠出来在 vm 里执行（不修改仓库数据）。
    const fnSrc = genScript.slice(
      genScript.indexOf('function quoteString('),
      genScript.indexOf('const IDENT'),
    );
    const ctx = {};
    vm.runInNewContext(`${fnSrc}\nthis.q = quoteString;`, ctx);
    const cases = [
      ['a\\b', "'a\\\\b'"],
      ["it's", "'it\\'s'"],
      ['line1\nline2', "'line1\\nline2'"],
      ['x\ty', "'x\\ty'"],
      [' ', "'\\u2028'"],
      ['a\u0007b', "'a\\u0007b'"],
      ['中文“curly”', "'中文“curly”'"],
    ];
    for (const [input, expected] of cases) {
      expect(ctx.q(input)).toBe(expected);
    }
  });
});
