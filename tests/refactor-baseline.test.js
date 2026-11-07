// ============================================================================
// 重构行为基线快照 (refactor behavior baseline) — 记录 2026-11-07 重构前的现状。
//
// 目的：现有 ~595 项测试大量是「源码文本断言」(toContain)，只能挡住字符串变化，
// 挡不住行为漂移。本文件用 node:vm 真正执行关键纯函数，把 输入 → 输出 固定下来，
// 作为后续「移动 / 抽取函数、合并重复常量、拆分 content.js」等所有研发改动的回归护栏。
//
// 规则：
//   * 这里的断言记录的是「现状」，不一定是「理想值」。重构后必须逐项保持。
//   * 若某项行为是有意变更，必须同步更新本文件对应的期望值，并在 PR 里说明理由。
//   * 只允许修改本文件；不得改动被测源码以迁就快照。
//   * 断言用具体值 (toEqual / toBe / toMatchObject)，不用 toContain 扫源码字符串。
//   * 抽取 vm 代码块 / 常量时若找不到标记，用 expect(...).toBeGreaterThan(-1)
//     明确失败，绝不静默跳过。
// ============================================================================
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// 通用 vm 辅助
// ---------------------------------------------------------------------------

// 从一个具名 function 声明做花括号配对，抽出完整函数体源码（不依赖行号）。
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  expect(start, `function ${name}( 应存在于源码中`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  expect(open).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`无法为 ${name} 配对花括号`);
}

// 加载 lib/*.js（IIFE 把 api 挂到 window / globalThis 上）。
function loadLib(rel, extra = {}) {
  const ctx = {
    window: {},
    globalThis: {},
    Date,
    JSON,
    TextEncoder,
    TextDecoder,
    decodeURIComponent,
    structuredClone,
    console,
    ...extra,
  };
  vm.runInNewContext(read(rel), ctx, { filename: rel });
  return ctx;
}

// 把整个 background.js 塞进裸 vm（service worker 风格，参考 ai-background-parser.test.js）。
function loadBackgroundDebug() {
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
  vm.runInContext(backgroundJs, context, { filename: 'background.js' });
  return context;
}

// 从一个 const/let 声明里抽出初始化表达式（从第一个 { 或 [ 开始做配对，
// 跳过字符串 / 模板串 / 注释里的括号），然后在 vm 里求值成真正的对象。
function extractConstExpr(src, name) {
  const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`);
  const m = decl.exec(src);
  expect(m ? m.index : -2, `声明 ${name} 应存在于源码中`).toBeGreaterThan(-1);
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

// ===========================================================================
// A. content.js 的提示词链（重构高风险区）
// ===========================================================================
describe('A / content.js prompt-normalize 区块', () => {
  // 整块 slice：normalizeGrokPromptText / renderGrokContext 依赖区块内的 GROK_* 常量。
  const startMark = '// --- prompt-normalize:start ---';
  const endMark = '// --- prompt-normalize:end ---';
  const startIdx = contentJs.indexOf(startMark);
  const endIdx = contentJs.indexOf(endMark);
  expect(startIdx, 'prompt-normalize:start 标记应存在').toBeGreaterThan(-1);
  expect(endIdx, 'prompt-normalize:end 标记应存在').toBeGreaterThan(-1);
  const block = contentJs.slice(startIdx + startMark.length, endIdx);
  const ctx = {};
  vm.runInNewContext(
    `${block}\nthis.norm = normalizeGrokPromptText; this.render = renderGrokContext;`,
    ctx,
  );
  const { norm, render } = ctx;
  expect(typeof norm).toBe('function');
  expect(typeof render).toBe('function');

  const ZH_HINT = '每条评论只包含可直接发布的评论正文，用代码块包裹。';
  const JA_HINT = '各返信は、そのまま投稿できる本文だけをコードブロックで囲んで出力してください。';
  const EN_HINT = 'Output only ready-to-post reply text, each inside its own code block.';

  // ---- normalizeGrokPromptText -------------------------------------------
  it('缺 {推文内容} 且元数据槽位时前置 {推文内容} 并追加中文代码块提示', () => {
    expect(norm('{关注状态}\n\n写三条评论'))
      .toBe(`{推文内容}\n\n{关注状态}\n\n写三条评论\n\n${ZH_HINT}`);
  });

  it('含正文槽位 {主贴}/{当前评论} 时不重复前置 {推文内容}', () => {
    const out = norm('{主贴}\n\n{当前评论}\n\n要求：简短。');
    expect(out).toBe(`{主贴}\n\n{当前评论}\n\n要求：简短。\n\n${ZH_HINT}`);
    expect(out.startsWith('{推文内容}')).toBe(false);
  });

  it('缺代码块指令时按 zh / ja / en 追加对应语言提示', () => {
    expect(norm('为这条推文写三条评论。'))
      .toBe(`{推文内容}\n\n为这条推文写三条评论。\n\n${ZH_HINT}`);
    expect(norm('この投稿に3件返信してください。'))
      .toBe(`{推文内容}\n\nこの投稿に3件返信してください。\n\n${JA_HINT}`);
    expect(norm('Write three replies to this post.'))
      .toBe(`{推文内容}\n\nWrite three replies to this post.\n\n${EN_HINT}`);
  });

  it('挑语言时先剥离中文槽位 token，英文提示词带 {作者} 仍得到 en 提示', () => {
    expect(norm('{作者}\n\nWrite three replies to this post.'))
      .toBe(`{推文内容}\n\n{作者}\n\nWrite three replies to this post.\n\n${EN_HINT}`);
  });

  it('已有代码块指令 / 空串 / null / 数字输入时不重复追加提示', () => {
    expect(norm('用代码块包裹，写三条')).toBe('{推文内容}\n\n用代码块包裹，写三条');
    expect(norm('')).toBe('');
    expect(norm(null)).toBe('');
    expect(norm(123)).toBe(`{推文内容}\n\n123\n\n${EN_HINT}`); // 纯数字判为 en
  });

  // ---- renderGrokContext --------------------------------------------------
  it('把每个命名槽位替换成给到的 parts 值', () => {
    expect(render('{作者} 说：{当前评论}\n\n{关注状态}\n\n{数据}', {
      作者: '@ann',
      当前评论: '@ann：Nice',
      关注状态: '互相关注',
      数据: '浏览1.2k',
    })).toBe('@ann 说：@ann：Nice\n\n互相关注\n\n浏览1.2k');
  });

  it('空槽删除所在行，不留空标签也不留多余空行', () => {
    expect(render('{主贴}\n\n{当前评论}\n\n{关注状态}\n\n要求：简短。', {
      主贴: 'A',
      当前评论: 'B',
      关注状态: '',
    })).toBe('A\n\nB\n\n要求：简短。');
  });

  it('替换值里含 {当前评论} 不被二次展开', () => {
    expect(render('{推文内容}\n\n要求：简短。', {
      推文内容: '我的推文里就写了 {当前评论} 这四个字',
      当前评论: 'SHOULD NOT APPEAR',
    })).toBe('我的推文里就写了 {当前评论} 这四个字\n\n要求：简短。');
  });

  it('连续空行压缩为单个 \\n\\n，且整体 trim', () => {
    expect(render('{主贴}\n\n\n\n{当前评论}\n\n\n\n\n{数据}', {
      主贴: 'a', 当前评论: '', 数据: 'c',
    })).toBe('a\n\nc');
    expect(render('  {作者}  ', { 作者: '  x  ' })).toBe('x');
  });

  it('缺省 parts / 无值时所有槽位展开为空串', () => {
    expect(render('{推文内容}')).toBe('');
    expect(render('plain text without slots', {})).toBe('plain text without slots');
  });
});

describe('A / content.js formatVelocity + computeScore', () => {
  const formatVelocitySrc = extractFunction(contentJs, 'formatVelocity');
  const computeScoreSrc = extractFunction(contentJs, 'computeScore');

  // computeScore 依赖模块级 velocityThresholds 与 Date.now()；固定二者以便断言数值。
  const FIXED_NOW = 1700000000000;
  class FixedDate extends Date {
    static now() { return FIXED_NOW; }
  }
  const ctx = {
    velocityThresholds: { trending: 1000, viral: 10000 },
    Date: FixedDate,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(`${formatVelocitySrc}\n${computeScoreSrc}`, ctx);
  const { formatVelocity, computeScore } = ctx;
  expect(typeof formatVelocity).toBe('function');
  expect(typeof computeScore).toBe('function');

  const HOUR_MS = 3600000;
  const base = {
    createdAt: new Date(FIXED_NOW - HOUR_MS).toISOString(), // 恰好 1 小时前
    views: 100000,
    likes: 1000,
    retweets: 500,
    replies: 200,
    bookmarks: 300,
  };

  it('formatVelocity 对 0 / 负数 / 边界 / 超大 / 非法值返回固定字符串', () => {
    expect(formatVelocity(0)).toBe('0');
    expect(formatVelocity(-5)).toBe('-5');
    expect(formatVelocity(999)).toBe('999');
    expect(formatVelocity(1000)).toBe('1.0k');
    expect(formatVelocity(1500)).toBe('1.5k');
    expect(formatVelocity(999999)).toBe('1000.0k');
    expect(formatVelocity(1000000)).toBe('1.0M');
    expect(formatVelocity(1234567)).toBe('1.2M');
    expect(formatVelocity(NaN)).toBe('NaN');
    expect(formatVelocity(undefined)).toBe('NaN');
  });

  it('computeScore 返回 {velocity, score, isHot} 结构并对正常数据给出确定数值', () => {
    expect(computeScore(base)).toEqual({ velocity: 100000, score: 79, isHot: true });
  });

  it('computeScore 对零 / 负浏览、零互动、超大值给出固定分数', () => {
    expect(computeScore({ ...base, views: 0 })).toEqual({ velocity: 0, score: 35, isHot: false });
    expect(computeScore({ ...base, views: -100 })).toEqual({ velocity: -100, score: 35, isHot: false });
    expect(computeScore({ ...base, likes: 0, retweets: 0, replies: 0, bookmarks: 0 }))
      .toEqual({ velocity: 100000, score: 40, isHot: true });
    expect(computeScore({ ...base, views: 1e6, likes: 1e6, retweets: 1e6, replies: 1e6, bookmarks: 1e6 }))
      .toEqual({ velocity: 1000000, score: 100, isHot: true });
    expect(computeScore({ ...base, views: 1e12, likes: 1e9, retweets: 1e9, replies: 1e9, bookmarks: 1e9 }))
      .toEqual({ velocity: 1000000000000, score: 76, isHot: true });
  });

  it('computeScore 对缺失字段 / 未来时间 / 非法 createdAt 的现状（NaN 传播）', () => {
    // 记录现状：缺字段或非法 createdAt 时 velocity/score 为 NaN（不是 0/null），isHot 为 false。
    // vitest 的 toEqual 用 Object.is 比较，NaN === NaN 成立，可精确锁住这一行为。
    expect(computeScore({})).toEqual({ velocity: NaN, score: NaN, isHot: false });
    expect(computeScore({ ...base, createdAt: 'nope' }))
      .toEqual({ velocity: NaN, score: NaN, isHot: false });
    // 未来 createdAt 被夹到最小 0.1 小时，velocity = views / 0.1。
    expect(computeScore({ ...base, createdAt: new Date(FIXED_NOW + 2 * HOUR_MS).toISOString() }))
      .toEqual({ velocity: 1000000, score: 79, isHot: true });
  });
});

// ===========================================================================
// B. background.js 的 AI 解析链（service worker，裸 vm 整文件执行）
// ===========================================================================
describe('B / background.js AI 解析链', () => {
  const bg = loadBackgroundDebug();
  for (const name of [
    'renderPrompt', 'extractComments', 'replyLanguageOf', 'normalizeConfig',
    'getPlatformPreset', 'normalizeReplyCount', 'normalizeHttpBaseUrl',
    'assertAllowedOllamaBaseUrl',
  ]) {
    expect(typeof bg[name], `${name} 应挂在 vm context 上`).toBe('function');
  }

  const ZH_OUT = '每条回复必须使用中文，不要改用英文。最多返回 3 条。每条只输出可直接发布的正文，用代码块包裹。';
  const JA_OUT = '各返信は日本語のみで書くこと。英語にしない。最大 5 件。各返信は投稿できる本文だけをコードブロックで囲む。';
  const EN_OUT = 'Write every reply in English only. Do not switch to Chinese. Return at most 7 replies. Output only ready-to-post text, each inside its own code block.';

  // ---- renderPrompt --------------------------------------------------------
  it('renderPrompt 把 {推文内容} 替换为推文正文（替换所有出现）', () => {
    expect(bg.renderPrompt('THE TWEET', '{推文内容}', 3, { replyLanguage: 'en' }))
      .toBe(`THE TWEET\n\n${EN_OUT.replace('7', '3')}`);
    expect(bg.renderPrompt('X', 'A {推文内容} B {推文内容} C', 3, { replyLanguage: 'zh' }))
      .toBe(`A X B X C\n\n${ZH_OUT}`);
  });

  it('renderPrompt 无占位符时把推文正文前置追加', () => {
    expect(bg.renderPrompt('THE TWEET', '写三条评论', 3, { replyLanguage: 'zh' }))
      .toBe(`THE TWEET\n\n写三条评论\n\n${ZH_OUT}`);
  });

  it('renderPrompt preRendered:true 时不二次插入推文块，保留模板里的 {推文内容}', () => {
    const out = bg.renderPrompt('THE WHOLE BLOCK', '{推文内容}\n\n要求：简短。', 3, {
      replyLanguage: 'zh', preRendered: true,
    });
    expect(out).toBe(`{推文内容}\n\n要求：简短。\n\n${ZH_OUT}`);
    expect(out.includes('THE WHOLE BLOCK')).toBe(false);
  });

  it('renderPrompt 空模板走内置英文默认句', () => {
    expect(bg.renderPrompt('THE TWEET', '', 2, { replyLanguage: 'en' }))
      .toBe('THE TWEET\n\nGenerate 2 natural replies. Output only ready-to-post reply text, each inside its own code block.\n\nWrite every reply in English only. Do not switch to Chinese. Return at most 2 replies. Output only ready-to-post text, each inside its own code block.');
  });

  it('renderPrompt outputHint 按 zh / ja / en 追加对应提示', () => {
    expect(bg.renderPrompt('中文推文', '{推文内容}', 3, { replyLanguage: 'zh' }))
      .toBe(`中文推文\n\n${ZH_OUT}`);
    expect(bg.renderPrompt('日本語', '{推文内容}', 5, { replyLanguage: 'ja' }))
      .toBe(`日本語\n\n${JA_OUT}`);
    expect(bg.renderPrompt('English text', '{推文内容}', 7, { replyLanguage: 'en' }))
      .toBe(`English text\n\n${EN_OUT}`);
  });

  it('renderPrompt(post 模式) 由推文正文判语种，中文标注不影响判日文', () => {
    const out = bg.renderPrompt('日本語のテキスト\n\n【关注状态】你和@ann是互相关注', '{推文内容}', 3, { replyLanguage: 'post' });
    expect(out).toBe('日本語のテキスト\n\n【关注状态】你和@ann是互相关注\n\n各返信は日本語のみで書くこと。英語にしない。最大 3 件。各返信は投稿できる本文だけをコードブロックで囲む。');
  });

  it('renderPrompt 对推文正文做 NFC / 控制字符 / 孤立代理项清洗', () => {
    expect(bg.renderPrompt('﻿Café \n\t正文\uD800', '{推文内容}', 1, { replyLanguage: 'zh' }))
      .toBe(`Café\n\t正文�\n\n每条回复必须使用中文，不要改用英文。最多返回 1 条。每条只输出可直接发布的正文，用代码块包裹。`);
  });

  // ---- extractComments -----------------------------------------------------
  it('extractComments 多代码块逐块返回正文', () => {
    expect(bg.extractComments('```\nfirst reply\n```\n```\nsecond reply\n```\n```\nthird reply\n```', 10))
      .toEqual(['first reply', 'second reply', 'third reply']);
  });

  it('extractComments 单代码块按行拆出 ≥3 条候选', () => {
    expect(bg.extractComments('```\n这个兔子看着就很好聊\n她是不是也愣了一下\n你俩座位连一起，缘分啊\n```', 10))
      .toEqual(['这个兔子看着就很好聊', '她是不是也愣了一下', '你俩座位连一起，缘分啊']);
  });

  it('extractComments 编号列表 / 破折号列表', () => {
    expect(bg.extractComments('1. first one\n2. second one\n3. third one', 10))
      .toEqual(['first one', 'second one', 'third one']);
    expect(bg.extractComments('- alpha item\n- beta item\n- gamma item', 10))
      .toEqual(['alpha item', 'beta item', 'gamma item']);
  });

  it('extractComments 纯文本 / 空串 / 空白 / 过短行', () => {
    expect(bg.extractComments('Just a single line of text', 10)).toEqual([]);
    expect(bg.extractComments('line one here\nline two here', 10))
      .toEqual(['line one here', 'line two here']);
    expect(bg.extractComments('', 10)).toEqual([]);
    expect(bg.extractComments('   \n  ', 10)).toEqual([]);
    expect(bg.extractComments('```\nx\ny\nz\n```', 10)).toEqual(['x\ny\nz']);
  });

  it('extractComments 去重并按 limit 截断', () => {
    expect(bg.extractComments('```\nsame reply\n```\n```\nsame reply\n```\n```\nother reply\n```', 10))
      .toEqual(['same reply', 'other reply']);
    expect(bg.extractComments('```\nfirst reply\n```\n```\nsecond reply\n```\n```\nthird reply\n```', 2))
      .toEqual(['first reply', 'second reply']);
    expect(bg.extractComments('```\naaa\n```\n```\nbbb\n```\n```\nccc\n```\n```\nddd\n```'))
      .toEqual(['aaa', 'bbb', 'ccc']); // 默认 limit = 3
  });

  // ---- replyLanguageOf -----------------------------------------------------
  it('replyLanguageOf 中文标注不影响语种判定，日文假名优先', () => {
    expect(bg.replyLanguageOf('日本語のテキスト\n\n【关注状态】你和@ann是互相关注')).toBe('ja');
    expect(bg.replyLanguageOf('これは日本語の投稿です')).toBe('ja');
    expect(bg.replyLanguageOf('这是一条中文推文内容')).toBe('zh');
    expect(bg.replyLanguageOf('This is an English post right here')).toBe('en');
  });

  it('replyLanguageOf 剔除链接 / @ / # 后再判语种', () => {
    expect(bg.replyLanguageOf('Ship it https://example.com/a/very/long/english/path')).toBe('en');
    expect(bg.replyLanguageOf('@someone #tag 这是一条中文推文')).toBe('zh');
    expect(bg.replyLanguageOf('你好')).toBe('zh');
    expect(bg.replyLanguageOf('')).toBe('en');
    expect(bg.replyLanguageOf('【关注状态】你和@ann是互相关注')).toBe('en');
    expect(bg.replyLanguageOf('Hello world this is a long english sentence 你好')).toBe('en');
  });

  // ---- normalizeReplyCount / getPlatformPreset ----------------------------
  it('normalizeReplyCount 夹到 [1,20]，非法值回退 3', () => {
    expect(bg.normalizeReplyCount(0)).toBe(1);
    expect(bg.normalizeReplyCount(1)).toBe(1);
    expect(bg.normalizeReplyCount(3)).toBe(3);
    expect(bg.normalizeReplyCount(20)).toBe(20);
    expect(bg.normalizeReplyCount(21)).toBe(20);
    expect(bg.normalizeReplyCount(-5)).toBe(1);
    expect(bg.normalizeReplyCount('7')).toBe(7);
    expect(bg.normalizeReplyCount('10x')).toBe(10);
    expect(bg.normalizeReplyCount(3.9)).toBe(3);
    expect(bg.normalizeReplyCount('abc')).toBe(3);
    expect(bg.normalizeReplyCount(null)).toBe(3);
    expect(bg.normalizeReplyCount(undefined)).toBe(3);
    expect(bg.normalizeReplyCount({})).toBe(3);
  });

  it('getPlatformPreset 命中返回预设，未知 / 空平台回退 openai', () => {
    expect(bg.getPlatformPreset('openai'))
      .toMatchObject({ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    expect(bg.getPlatformPreset('deepseek'))
      .toMatchObject({ label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
    expect(bg.getPlatformPreset('ollamaOpenAI'))
      .toMatchObject({ label: 'Ollama (OpenAI compatible)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', local: true });
    const fallback = { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
    expect(bg.getPlatformPreset('nope')).toEqual(fallback);
    expect(bg.getPlatformPreset('')).toEqual(fallback);
    expect(bg.getPlatformPreset(undefined)).toEqual(fallback);
  });

  // ---- normalizeConfig ----------------------------------------------------
  const DEFAULT_CONFIG = {
    provider: 'openai-compatible',
    platform: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    replyCount: 3,
    language: 'auto',
    apiKey: '',
  };

  it('normalizeConfig 缺失 / 空输入时给出完整默认结构', () => {
    expect(bg.normalizeConfig()).toEqual(DEFAULT_CONFIG);
    expect(bg.normalizeConfig({}, {})).toEqual(DEFAULT_CONFIG);
  });

  it('normalizeConfig 按平台套用预设，非法平台回退 openai', () => {
    expect(bg.normalizeConfig({ aiOpenAIPlatform: 'deepseek' }, {})).toMatchObject({
      platform: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
    });
    expect(bg.normalizeConfig({ aiOpenAIPlatform: 'nope' }, {})).toEqual(DEFAULT_CONFIG);
  });

  it('normalizeConfig 覆盖值 / 去尾斜杠 / 夹 replyCount / 校验 language / provider', () => {
    expect(bg.normalizeConfig({
      aiOpenAIPlatform: 'deepseek',
      aiBaseUrl: 'https://custom.example.com/v1/',
      aiModel: 'my-model',
      aiReplyCount: 50,
      aiLanguage: 'ja',
      aiProvider: 'ollama',
    }, { xvmAiApiKey: ' sk-123 ' })).toEqual({
      provider: 'ollama',
      platform: 'deepseek',
      baseUrl: 'https://custom.example.com/v1',
      model: 'my-model',
      replyCount: 20,
      language: 'ja',
      apiKey: 'sk-123',
    });
    expect(bg.normalizeConfig({ aiLanguage: 'fr' }, {}).language).toBe('auto');
    expect(bg.normalizeConfig({ aiProvider: 'bogus' }, {}).provider).toBe('openai-compatible');
    expect(bg.normalizeConfig({ aiProvider: 'ollama' }, {}).provider).toBe('ollama');
    expect(bg.normalizeConfig({}, { xvmAiApiKey: '  sk-key  ' }).apiKey).toBe('sk-key');
    expect(bg.normalizeConfig({ aiBaseUrl: 'https://x.com/v1///' }, {}).baseUrl).toBe('https://x.com/v1');
  });

  // ---- normalizeHttpBaseUrl / assertAllowedOllamaBaseUrl ------------------
  it('normalizeHttpBaseUrl 去尾斜杠并拒绝非法协议 / 地址 / 缺主机名', () => {
    expect(bg.normalizeHttpBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(bg.normalizeHttpBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(bg.normalizeHttpBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(bg.normalizeHttpBaseUrl('', 'https://fallback.example.com/v1/')).toBe('https://fallback.example.com/v1');
    expect(() => bg.normalizeHttpBaseUrl('ftp://x.com')).toThrow('Base URL 只支持 http 或 https');
    expect(() => bg.normalizeHttpBaseUrl('not a url')).toThrow('Base URL 不是合法地址');
    expect(() => bg.normalizeHttpBaseUrl('')).toThrow('Base URL 不是合法地址');
    expect(() => bg.normalizeHttpBaseUrl(undefined)).toThrow('Base URL 不是合法地址');
    expect(() => bg.normalizeHttpBaseUrl('/relative')).toThrow('Base URL 不是合法地址');
  });

  it('assertAllowedOllamaBaseUrl 缺省回退 localhost:11434 并去掉末尾 /v1', () => {
    expect(bg.assertAllowedOllamaBaseUrl('http://localhost:11434')).toBe('http://localhost:11434');
    expect(bg.assertAllowedOllamaBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(bg.assertAllowedOllamaBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(bg.assertAllowedOllamaBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434');
    expect(bg.assertAllowedOllamaBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com');
    expect(bg.assertAllowedOllamaBaseUrl('')).toBe('http://localhost:11434');
    expect(bg.assertAllowedOllamaBaseUrl(undefined)).toBe('http://localhost:11434');
    expect(() => bg.assertAllowedOllamaBaseUrl('ftp://x.com')).toThrow('Base URL 只支持 http 或 https');
  });
});

// ===========================================================================
// C. lib/*.js 纯函数（抽取重构的参照实现，必须锁死行为）
// ===========================================================================
describe('C / lib/freshness.js', () => {
  const api = loadLib('lib/freshness.js').window.__xvmFreshness;
  expect(api, '__xvmFreshness 应存在').toBeTruthy();

  it('tier 按 hot/fresh/warm 分钟边界分档，拒绝 NaN / 未来时间', () => {
    expect(api.tier(5 * 60000, 5, 10, 30)).toBe('hot');
    expect(api.tier(5 * 60000 + 1, 5, 10, 30)).toBe('fresh');
    expect(api.tier(10 * 60000, 5, 10, 30)).toBe('fresh');
    expect(api.tier(10 * 60000 + 1, 5, 10, 30)).toBe('warm');
    expect(api.tier(30 * 60000, 5, 10, 30)).toBe('warm');
    expect(api.tier(30 * 60000 + 1, 5, 10, 30)).toBe('');
    expect(api.tier(NaN, 5, 10, 30)).toBe('');
    expect(api.tier(-1, 5, 10, 30)).toBe('');
    expect(api.tier(0, 5, 10, 30)).toBe('hot');
  });

  it('tier 用 fallback 补齐并夹住非法分钟参数', () => {
    expect(api.tier(5 * 60000, 0, 0, 0)).toBe('hot');
    expect(api.tier(60 * 60000, 5, 10, 30)).toBe('');
  });

  it('normalizeMinutes 只保留 [1,1440] 的整数，否则回退', () => {
    expect(api.normalizeMinutes(5, 99)).toBe(5);
    expect(api.normalizeMinutes(0, 7)).toBe(7);
    expect(api.normalizeMinutes(-3, 7)).toBe(7);
    expect(api.normalizeMinutes(NaN, 7)).toBe(7);
    expect(api.normalizeMinutes(99999, 7)).toBe(1440);
    expect(api.normalizeMinutes('12', 7)).toBe(12);
    expect(api.normalizeMinutes(undefined, 7)).toBe(7);
    expect(api.normalizeMinutes(null, 7)).toBe(7);
  });

  it('normalizeColor 只接受 6 位十六进制并小写化', () => {
    expect(api.normalizeColor('#F7B928', '#1d9bf0')).toBe('#f7b928');
    expect(api.normalizeColor(' #ABCDEF ', '#x')).toBe('#abcdef');
    expect(api.normalizeColor('#fff', '#1d9bf0')).toBe('#1d9bf0');
    expect(api.normalizeColor('red', '#1d9bf0')).toBe('#1d9bf0');
    expect(api.normalizeColor('', '#1d9bf0')).toBe('#1d9bf0');
    expect(api.normalizeColor(null, '#000000')).toBe('#000000');
    expect(api.normalizeColor('#12345678', '#x')).toBe('#x');
    expect(api.normalizeColor('#GGGGGG', '#x')).toBe('#x');
  });

  it('wash 把颜色转 rgba(...)，非法色回退默认蓝', () => {
    expect(api.wash('#F7B928')).toBe('rgba(247, 185, 40, 0.12)');
    expect(api.wash('#F7B928', 0.5)).toBe('rgba(247, 185, 40, 0.5)');
    expect(api.wash('red')).toBe('rgba(29, 155, 240, 0.12)');
    expect(api.wash(null)).toBe('rgba(29, 155, 240, 0.12)');
    expect(api.wash(undefined, 0.9)).toBe('rgba(29, 155, 240, 0.9)');
  });
});

describe('C / lib/unfollowed.js', () => {
  const api = loadLib('lib/unfollowed.js').window.__xvmUnfollowed;
  expect(api, '__xvmUnfollowed 应存在').toBeTruthy();

  it('formatCount 千分位 / 万 / 负值 / 非法值', () => {
    expect(api.formatCount(0)).toBe('0');
    expect(api.formatCount(1)).toBe('1');
    expect(api.formatCount(999)).toBe('999');
    expect(api.formatCount(1000)).toBe('1,000');
    expect(api.formatCount(9999)).toBe('9,999');
    expect(api.formatCount(10000)).toBe('1万');
    expect(api.formatCount(12000)).toBe('1.2万');
    expect(api.formatCount(84000)).toBe('8.4万');
    expect(api.formatCount(999999)).toBe('100万');
    expect(api.formatCount(1000000)).toBe('100万');
    expect(api.formatCount(-5)).toBe('');
    expect(api.formatCount(NaN)).toBe('');
    expect(api.formatCount('abc')).toBe('');
    expect(api.formatCount(null)).toBe('0');
    expect(api.formatCount(undefined)).toBe('');
    expect(api.formatCount('84000')).toBe('8.4万');
  });

  it('unlikelyFollowBack 要求 followers>=1000 且 >=10 倍关注数，字符串不参与', () => {
    expect(api.unlikelyFollowBack(999, 10)).toBe(false);
    expect(api.unlikelyFollowBack(5000, 600)).toBe(false);
    expect(api.unlikelyFollowBack(84000, 120)).toBe(true);
    expect(api.unlikelyFollowBack(1000, 100)).toBe(true);
    expect(api.unlikelyFollowBack(1000, 101)).toBe(false);
    expect(api.unlikelyFollowBack(NaN, 10)).toBe(false);
    expect(api.unlikelyFollowBack(84000, NaN)).toBe(false);
    expect(api.unlikelyFollowBack('84000', 120)).toBe(false);
  });

  it('isBlueMember 三态：relation 优先，domBlue 次之，否则 null', () => {
    expect(api.isBlueMember({ blueVerified: true }, false)).toBe(true);
    expect(api.isBlueMember({ blueVerified: false }, true)).toBe(true);
    expect(api.isBlueMember({ blueVerified: true }, true)).toBe(true);
    expect(api.isBlueMember({ blueVerified: false }, false)).toBe(false);
    expect(api.isBlueMember({}, false)).toBe(false);
    expect(api.isBlueMember({}, true)).toBe(true);
    expect(api.isBlueMember({}, undefined)).toBe(null);
    expect(api.isBlueMember(null, null)).toBe(null);
  });

  it('label 仅对 following:false 打标，含难回关 / 计数 / blueOnly', () => {
    expect(api.label({ following: true, followers: 5000, followingCount: 10 })).toBe(null);
    expect(api.label({ following: null, followers: 5000, followingCount: 10 })).toBe(null);
    expect(api.label(null)).toBe(null);
    expect(api.label({ following: false, followers: 120, followingCount: 80 }))
      .toEqual({ text: '未关注 · 关注 80 · 粉丝 120', hard: false, hasCounts: true });
    expect(api.label({ following: false, followers: 120 }))
      .toEqual({ text: '未关注 · 粉丝 120', hard: false, hasCounts: false });
    expect(api.label({ following: false, followers: 84000, followingCount: 120 }))
      .toEqual({ text: '未关注 · 难回关 · 关注 120 · 粉丝 8.4万', hard: true, hasCounts: true });
    expect(api.label({ following: false }))
      .toEqual({ text: '未关注', hard: false, hasCounts: false });
    expect(api.label({ following: false, blueVerified: false }, { blueOnly: true })).toBe(null);
    expect(api.label({ following: false, blueVerified: true }, { blueOnly: true }))
      .toEqual({ text: '未关注', hard: false, hasCounts: false });
  });
});

describe('C / lib/author-reply-target.js', () => {
  const api = loadLib('lib/author-reply-target.js').window.__xvmAuthorReplyTarget;
  expect(api, '__xvmAuthorReplyTarget 应存在').toBeTruthy();

  const card = (o) => ({ statusId: '', handle: '', ...o });
  const basic = {
    pageStatusId: '100',
    loggedInHandle: 'me',
    cards: [
      card({ statusId: '100', handle: 'me', hasAnalytics: true }),
      card({ statusId: '200', handle: 'ada' }),
      card({ statusId: '201', handle: 'me', nested: true }),
      card({ statusId: '202', handle: 'ad', promoted: true }),
    ],
  };

  it('focalCard 按 pageStatusId 找主贴卡片，缺失返回 null', () => {
    expect(api.focalCard(basic).statusId).toBe('100');
    expect(api.focalCard({ loggedInHandle: 'me', cards: [card({ statusId: '1' })] })).toBe(null);
    expect(api.focalCard({ pageStatusId: '100', loggedInHandle: 'me' })).toBe(null);
    expect(api.focalCard(null)).toBe(null);
  });

  it('focalIsOwn 用 handle 或 hasAnalytics 判断主贴归属，handle 大小写不敏感', () => {
    expect(api.focalIsOwn(basic)).toBe(true);
    expect(api.focalIsOwn({ pageStatusId: '100', loggedInHandle: 'me', cards: [card({ statusId: '100', handle: 'other' })] })).toBe(false);
    expect(api.focalIsOwn({ pageStatusId: '100', loggedInHandle: 'ME', cards: [card({ statusId: '100', hasAnalytics: true })] })).toBe(true);
    expect(api.focalIsOwn({ pageStatusId: '100', loggedInHandle: 'me', cards: [card({ statusId: '100' })] })).toBe(false);
    expect(api.focalIsOwn({ pageStatusId: '100', cards: [card({ statusId: '100', handle: 'me' })] })).toBe(false);
  });

  it('isOwnThread 支持 knownOwnStatusId 在主贴滚出列表后仍成立', () => {
    expect(api.isOwnThread(basic)).toBe(true);
    expect(api.isOwnThread({
      pageStatusId: '100', loggedInHandle: 'me', knownOwnStatusId: '100',
      cards: [card({ statusId: '200', handle: 'ada' }), card({ statusId: '201', handle: 'bob' })],
    })).toBe(true);
    expect(api.isOwnThread(null)).toBe(false);
  });

  it('authorReplyStatusIds 只标记非主贴 / 非 nested / 非 promoted 的评论', () => {
    expect(api.authorReplyStatusIds(basic)).toEqual(['200']);
    expect(api.authorReplyStatusIds({
      pageStatusId: '100', loggedInHandle: 'me', knownOwnStatusId: '100',
      cards: [card({ statusId: '200', handle: 'ada' }), card({ statusId: '201', handle: 'bob' })],
    })).toEqual(['200', '201']);
    expect(api.authorReplyStatusIds({
      pageStatusId: '100', loggedInHandle: 'me',
      cards: [card({ statusId: '200', handle: 'me', hasAnalytics: true, linksPageStatus: true })],
    })).toEqual([]);
    expect(api.authorReplyStatusIds({ pageStatusId: '100', loggedInHandle: 'me', cards: [card({ statusId: '100', handle: 'other' })] })).toEqual([]);
  });

  it('pickNewReplyEditor 优先选对话框里新出现的编辑器，否则最后一个新增，或 null', () => {
    const main = { id: 'main', closest: () => null };
    const dialog = { id: 'dialog', closest: () => ({ role: 'dialog' }) };
    const dialog2 = { id: 'dialog2', closest: () => ({ role: 'dialog' }) };
    const freshPlain = { id: 'fresh', closest: () => null };
    expect(api.pickNewReplyEditor([main], [main, dialog])).toBe(dialog);
    expect(api.pickNewReplyEditor([], [dialog, dialog2])).toBe(dialog2);
    expect(api.pickNewReplyEditor([], [freshPlain])).toBe(freshPlain);
    expect(api.pickNewReplyEditor([main], [main])).toBe(null);
    expect(api.pickNewReplyEditor([main], [])).toBe(null);
    expect(api.pickNewReplyEditor(null, null)).toBe(null);
  });
});

describe('C / lib/timeline-ad-prune.js', () => {
  const source = read('lib/timeline-ad-prune.js');
  function loadApi(extra = {}) {
    const ctx = { window: { ...extra }, globalThis: {} };
    vm.runInNewContext(source, ctx, { filename: 'lib/timeline-ad-prune.js' });
    return ctx.window.__xvmTimelineAdPrune;
  }
  const api = loadApi();
  expect(api, '__xvmTimelineAdPrune 应存在').toBeTruthy();

  function tweetEntry(id, { promoted = false } = {}) {
    const entry = {
      entryId: promoted ? `promoted-tweet-${id}` : `tweet-${id}`,
      sortIndex: String(1000000 - Number(id || 0) * 1000),
      content: {
        entryType: 'TimelineTimelineItem',
        itemContent: {
          itemType: 'TimelineTweet',
          tweet_results: { result: { rest_id: String(id), legacy: { full_text: `tweet ${id}` } } },
        },
      },
    };
    if (promoted) entry.content.itemContent.promotedMetadata = { impression_id: `imp-${id}`, disclosure_type: 'promoted' };
    return entry;
  }
  function homeTimeline(entries) {
    return { data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } };
  }

  it('isPromotedEntry 认 entryId /^promoted-/ 与两种 promotedMetadata', () => {
    expect(api.isPromotedEntry(tweetEntry('1'))).toBe(false);
    expect(api.isPromotedEntry(tweetEntry('2', { promoted: true }))).toBe(true);
    expect(api.isPromotedEntry({ entryId: 'tweet-3', content: { itemContent: { promotedMetadata: { impression_id: 'x' } } } })).toBe(true);
    expect(api.isPromotedEntry({ entryId: 'tweet-3', content: { itemContent: { promoted_metadata: { impression_id: 'x' } } } })).toBe(true);
    expect(api.isPromotedEntry(null)).toBe(false);
    expect(api.isPromotedEntry(undefined)).toBe(false);
  });

  it('pruneEntries 原地删除广告，返回是否变更；空 / 非数组返回 false', () => {
    const changed = [tweetEntry('10'), tweetEntry('11', { promoted: true }), tweetEntry('12')];
    expect(api.pruneEntries(changed)).toBe(true);
    expect(changed.map((e) => e.entryId)).toEqual(['tweet-10', 'tweet-12']);
    const clean = [tweetEntry('10'), tweetEntry('12')];
    expect(api.pruneEntries(clean)).toBe(false);
    expect(api.pruneEntries([])).toBe(false);
    expect(api.pruneEntries(null)).toBe(false);
  });

  it('pruneTimelineAds 变更时返回同一 json，无变更返回 undefined', () => {
    const dirty = homeTimeline([tweetEntry('10'), tweetEntry('11', { promoted: true }), tweetEntry('12'), tweetEntry('13', { promoted: true })]);
    expect(api.pruneTimelineAds(dirty)).toBe(dirty);
    expect(dirty.data.home.home_timeline_urt.instructions[0].entries.map((e) => e.entryId)).toEqual(['tweet-10', 'tweet-12']);
    const clean = homeTimeline([tweetEntry('20'), tweetEntry('21')]);
    expect(api.pruneTimelineAds(clean)).toBe(undefined);
    expect(clean.data.home.home_timeline_urt.instructions[0].entries).toHaveLength(2);
    expect(api.pruneTimelineAds(null)).toBe(undefined);
    expect(api.pruneTimelineAds('x')).toBe(undefined);
  });

  it('pruneTimelineAds 同时剪掉模块内广告项并丢空模块', () => {
    const moduleEntry = (id, items) => ({
      entryId: `home-conversation-${id}`, sortIndex: String(id),
      content: { entryType: 'TimelineTimelineModule', items },
    });
    const moduleItem = (id, promoted) => ({
      entryId: promoted ? `promoted-tweet-${id}` : `conversation-${id}`,
      item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { rest_id: String(id) } } } },
      ...(promoted ? { item: { itemContent: { itemType: 'TimelineTweet', promotedMetadata: { impression_id: 'imp' } } } } : {}),
    });
    const json = homeTimeline([
      tweetEntry('30'),
      moduleEntry('40', [moduleItem('41'), moduleItem('42', true)]),
      moduleEntry('50', [moduleItem('51', true)]),
    ]);
    expect(api.pruneTimelineAds(json)).toBe(json);
    const entries = json.data.home.home_timeline_urt.instructions[0].entries;
    expect(entries.map((e) => e.entryId)).toEqual(['tweet-30', 'home-conversation-40']);
    expect(entries[1].content.items.map((m) => m.entryId)).toEqual(['conversation-41']);
  });

  it('matchesTimelineUrl 只命中已知 timeline GraphQL op', () => {
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/HomeTimeline?variables=1')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/HomeLatestTimeline')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/SearchTimeline')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/UserTweets')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/TweetDetail')).toBe(true);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/Viewer')).toBe(false);
    expect(api.matchesTimelineUrl('https://x.com/i/api/1.1/statuses/update.json')).toBe(false);
    expect(api.matchesTimelineUrl('https://x.com/i/api/graphql/abc/BookmarkFoldersSlice?variables=%7B%7D')).toBe(false);
    expect(api.matchesTimelineUrl('')).toBe(false);
  });

  it('patchTimelineResponse 仅改写命中的 timeline op', () => {
    const json = homeTimeline([tweetEntry('70'), tweetEntry('71', { promoted: true })]);
    expect(api.patchTimelineResponse({ url: 'https://x.com/i/api/graphql/abc/Viewer', json })).toBe(undefined);
    expect(json.data.home.home_timeline_urt.instructions[0].entries).toHaveLength(2);
    expect(api.patchTimelineResponse({ url: 'https://x.com/i/api/graphql/abc/HomeTimeline?variables={}', json })).toBe(json);
    expect(json.data.home.home_timeline_urt.instructions[0].entries.map((e) => e.entryId)).toEqual(['tweet-70']);
  });

  it('window.__xvmDisableAdPrune 打开时跳过改写且不改数据', () => {
    const disabled = loadApi({ __xvmDisableAdPrune: true });
    const json = homeTimeline([tweetEntry('1'), tweetEntry('9', { promoted: true })]);
    expect(disabled.patchTimelineResponse({ url: 'https://x.com/i/api/graphql/abc/HomeTimeline', json })).toBe(undefined);
    expect(json.data.home.home_timeline_urt.instructions[0].entries).toHaveLength(2);
  });
});

describe('C / lib/bookmark-timeline-storage.js', () => {
  const api = loadLib('lib/bookmark-timeline-storage.js').globalThis.__xvmBookmarkTimelineStorage;
  expect(api, '__xvmBookmarkTimelineStorage 应存在').toBeTruthy();

  it('accountIdFromCookie 只解出 twid=u%3D<digits> 的数字账号', () => {
    expect(api.accountIdFromCookie('lang=zh-cn; twid=u%3D123456789')).toBe('123456789');
    expect(api.accountIdFromCookie('twid=u%3D42')).toBe('42');
    expect(api.accountIdFromCookie('foo=1; twid=u%3D123456789; x=2')).toBe('123456789');
    expect(api.accountIdFromCookie('ct0=abc; twid=u%3D7; auth=1')).toBe('7');
    expect(api.accountIdFromCookie('twid=u%3Dabc')).toBe('');
    expect(api.accountIdFromCookie('twid=123')).toBe('');
    expect(api.accountIdFromCookie('twid=u%3D%ZZ')).toBe('');
    expect(api.accountIdFromCookie('u=99')).toBe('');
    expect(api.accountIdFromCookie('')).toBe('');
    expect(api.accountIdFromCookie(undefined)).toBe('');
  });

  it('sanitizeFolderIds 去重 / 仅留 1-32 位数字 / 截到 20 个', () => {
    expect(api.sanitizeFolderIds(['1', '2', '2', '3'])).toEqual(['1', '2', '3']);
    expect(api.sanitizeFolderIds(['1', 'abc', '', ' 42 ', 'x'])).toEqual(['1', '42']);
    expect(api.sanitizeFolderIds([1, 2, 2, '3'])).toEqual(['1', '2', '3']);
    expect(api.sanitizeFolderIds(['0', '123456789012345678901234567890123'])).toEqual(['0']);
    expect(api.sanitizeFolderIds([{}])).toEqual([]);
    expect(api.sanitizeFolderIds('notarray')).toEqual([]);
    expect(api.sanitizeFolderIds(null)).toEqual([]);
    expect(api.sanitizeFolderIds([])).toEqual([]);
  });

  it('sanitizeTweetIds 去重 / 过滤 / 保留末尾 limit 个', () => {
    expect(api.sanitizeTweetIds(['1', '2', '2', '3'])).toEqual(['1', '2', '3']);
    expect(api.sanitizeTweetIds(['1', 'abc', '', ' 42 '])).toEqual(['1', '42']);
    expect(api.sanitizeTweetIds(null)).toEqual([]);
    expect(api.sanitizeTweetIds(['9', '8', '7', '6', '5', '4'])).toEqual(['9', '8', '7', '6', '5', '4']);
    expect(api.sanitizeTweetIds(['1', '2', '3', '4', '5'], 3)).toEqual(['3', '4', '5']);
    expect(api.sanitizeTweetIds(['1', '2', '3'], 0)).toEqual(['1', '2', '3']);
  });

  it('resolveScope 产出 idle / clear / reset / use 四种动作', () => {
    expect(api.resolveScope('', 'x', true, ['1'])).toEqual({ action: 'idle', scope: null });
    expect(api.resolveScope(null, null, true, null)).toEqual({ action: 'idle', scope: null });
    expect(api.resolveScope('111', '111', false, ['1'])).toEqual({ action: 'clear', scope: null });
    expect(api.resolveScope('111', '111', true, [])).toEqual({ action: 'clear', scope: null });
    expect(api.resolveScope('111', '111', true, 'bad')).toEqual({ action: 'clear', scope: null });
    expect(api.resolveScope('111', '222', true, ['1'])).toEqual({ action: 'reset', scope: null });
    expect(api.resolveScope('111', '111', true, ['1', '2']))
      .toEqual({ action: 'use', scope: { accountId: '111', folderIds: ['1', '2'] } });
  });

  it('mergeSeenTweetIds 按账号合并去重并夹到 limit', () => {
    expect(api.mergeSeenTweetIds(null, '111', ['1', '2'])).toEqual({ accountId: '111', ids: ['1', '2'] });
    expect(api.mergeSeenTweetIds({ accountId: '111', ids: ['1', '2'] }, '111', ['2', '3']))
      .toEqual({ accountId: '111', ids: ['1', '2', '3'] });
    expect(api.mergeSeenTweetIds({ accountId: '222', ids: ['9'] }, '111', ['1']))
      .toEqual({ accountId: '111', ids: ['1'] });
    expect(api.mergeSeenTweetIds(null, '', ['1'])).toEqual({ accountId: '', ids: [] });
    expect(api.mergeSeenTweetIds(null, '111', ['1', '2', '3', '4'], 2))
      .toEqual({ accountId: '111', ids: ['3', '4'] });
    expect(api.mergeSeenTweetIds({ accountId: '111', ids: 'bad' }, '111', ['1']))
      .toEqual({ accountId: '111', ids: ['1'] });
  });

  it('normalizeCacheDocument 只保留本人 / 已选 / 未过期 / 合法 entries 的文件夹', () => {
    function tweetEntry(id) {
      return {
        entryId: `tweet-${id}`, sortIndex: '100',
        content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { rest_id: String(id), legacy: { full_text: `t ${id}` } } } } },
      };
    }
    const now = 1700000000000;
    const entry90 = tweetEntry('90');
    const entry91 = tweetEntry('91');
    const raw = {
      accountId: '111',
      folders: {
        '1': { entries: [entry90, entry91], refreshedAt: now },
        '2': { entries: [tweetEntry('92')], refreshedAt: now - 25 * 3600000 }, // 过期
        '3': { entries: [], refreshedAt: now },
      },
    };
    const out = api.normalizeCacheDocument(raw, '111', ['1', '2', '3'], now);
    expect(out.accountId).toBe('111');
    expect(Object.keys(out.folders)).toEqual(['1', '3']);
    expect(out.folders['1'].entries).toEqual([entry90, entry91]);
    expect(out.folders['1'].refreshedAt).toBe(now);
    expect(out.folders['3']).toEqual({ entries: [], refreshedAt: now });
    expect(api.normalizeCacheDocument(raw, '222', ['1'], now)).toEqual({ accountId: '222', folders: {} });
    expect(api.normalizeCacheDocument(raw, '', ['1'], now)).toEqual({ accountId: '', folders: {} });
    expect(api.normalizeCacheDocument(null, '111', ['1'], now)).toEqual({ accountId: '111', folders: {} });
    expect(api.normalizeCacheDocument({ accountId: '111' }, '111', ['1'], now)).toEqual({ accountId: '111', folders: {} });
    expect(api.normalizeCacheDocument(raw, '111', [], now)).toEqual({ accountId: '111', folders: {} });
  });
});

describe('C / lib/bookmark-timeline-inject.js', () => {
  // sortIndexBetween 是模块内私有函数，未挂到公开 api 上。这里往源码里补一行导出，
  // 以便锁死这个「抽取重构参照实现」的行为（不改动仓库文件，仅在内存里追加一句）。
  const source = read('lib/bookmark-timeline-inject.js');
  const exportLine = '  api.cacheBookmarkTimelineEntries = cacheBookmarkTimelineEntries;';
  const exportIdx = source.indexOf(exportLine);
  expect(exportIdx, '应找到 api.cacheBookmarkTimelineEntries 导出点').toBeGreaterThan(-1);
  const patched = source.replace(exportLine, '  api.sortIndexBetween = sortIndexBetween;\n' + exportLine);
  function loadApi() {
    const ctx = { window: {}, globalThis: {}, Date, structuredClone };
    vm.runInNewContext(patched, ctx, { filename: 'lib/bookmark-timeline-inject.js' });
    return ctx.window.__xvmBookmarkTimelineInject;
  }
  const api = loadApi();
  expect(api, '__xvmBookmarkTimelineInject 应存在').toBeTruthy();
  expect(typeof api.sortIndexBetween).toBe('function');

  function tweetEntry(id) {
    return {
      entryId: `tweet-${id}`,
      sortIndex: String(1000000 - Number(id || 0) * 1000),
      content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: { rest_id: String(id), legacy: { full_text: `t ${id}` } } } } },
    };
  }
  function home(ids) {
    return { data: { home: { home_timeline_urt: { instructions: [{ type: 'TimelineAddEntries', entries: ids.map(tweetEntry) }] } } } };
  }
  const cache = () => new Map([['1', [tweetEntry('90'), tweetEntry('91')]]]);

  it('sortIndexBetween 在两个 sortIndex 间取中点 / 退化到 ±1 / 非法值回退 Date.now()', () => {
    expect(api.sortIndexBetween('100', '90')).toBe('95');
    expect(api.sortIndexBetween('5', '3')).toBe('4');
    expect(api.sortIndexBetween('100', '98')).toBe('99');
    expect(api.sortIndexBetween('100', '99')).toBe('99');
    expect(api.sortIndexBetween('100', '100')).toBe('99');
    expect(api.sortIndexBetween('10', '9')).toBe('9');
    expect(api.sortIndexBetween(undefined, '10')).toBe('11');
    expect(api.sortIndexBetween('0', '0')).toBe('1');
    // 非法输入（含 null/null、'abc'/'def'、'0'/undefined）走 catch 后的 Date.now() 分支，
    // 值随时间变化，只断言为纯数字字符串且为正。
    for (const [a, b] of [['abc', 'def'], [null, null], ['0', undefined]]) {
      const out = api.sortIndexBetween(a, b);
      expect(/^\d+$/.test(out)).toBe(true);
      expect(Number(out) > 0).toBe(true);
    }
  });

  it('injectBookmarkTimelineEntries 在 disabled 时原样返回 json（同一引用，无副作用）', () => {
    const json = home(['1', '2', '3']);
    const before = JSON.stringify(json);
    expect(api.injectBookmarkTimelineEntries(json, cache(), { enabled: false, folderIds: ['1'] })).toBe(json);
    expect(JSON.stringify(json)).toBe(before);
  });

  it('injectBookmarkTimelineEntries 在缺 folderIds 时早退', () => {
    const json = home(['1', '2', '3']);
    const before = JSON.stringify(json);
    expect(api.injectBookmarkTimelineEntries(json, cache(), { enabled: true })).toBe(json);
    expect(api.injectBookmarkTimelineEntries(json, cache(), { enabled: true, folderIds: [] })).toBe(json);
    expect(JSON.stringify(json)).toBe(before);
  });

  it('injectBookmarkTimelineEntries 在无 cache / 缓存 folder 未命中时早退', () => {
    const empty = home(['1', '2', '3']);
    expect(api.injectBookmarkTimelineEntries(empty, new Map(), { enabled: true, folderIds: ['1'] })).toBe(empty);
    const missing = home(['1', '2', '3']);
    expect(api.injectBookmarkTimelineEntries(missing, cache(), { enabled: true, folderIds: ['999'] })).toBe(missing);
  });

  it('injectBookmarkTimelineEntries 对非对象 json 直接原样返回', () => {
    expect(api.injectBookmarkTimelineEntries(null, cache(), { enabled: true, folderIds: ['1'] })).toBe(null);
  });

  it('injectBookmarkTimelineEntries 正常注入：每 every 条原创后插入一条书签，entryId 带 xvm-bookmark- 前缀', () => {
    const json = home(['1', '2', '3', '4', '5', '6', '7']);
    const out = api.injectBookmarkTimelineEntries(json, cache(), { enabled: true, folderIds: ['1'], every: 5 });
    expect(out).toBe(json);
    const ids = out.data.home.home_timeline_urt.instructions[0].entries.map((e) => e.entryId);
    expect(ids).toEqual([
      'tweet-1', 'tweet-2', 'tweet-3', 'tweet-4', 'tweet-5',
      expect.stringMatching(/^xvm-bookmark-1-90-\d+-1$/),
      'tweet-6', 'tweet-7',
    ]);
  });
});

// ===========================================================================
// D. 单一数据源一致性（防重复常量漂移）
// ===========================================================================
// 兼容性策略（已按 v2 方案更新，2026-11-07）：
//   WP-B 采用「构建期生成内联块」：src/ai-defaults.data.json 是唯一权威数据，
//   scripts/sync-ai-defaults.mjs 把同一份对象字面量写入 4 个消费者文件共 5 处
//   `// --- ai-defaults:generated:start/end ---` 标记区（content.js 1 处 /
//   popup.js 2 处 / bridge.js 1 处 / background.js 1 处）。因为 4 个消费者分属
//   不同 realm（MAIN / ISOLATED / service worker / 扩展页面），方案明确【不产出
//   lib/ai-defaults.js 运行时全局】、不改 popup.html 的 script 列表。
//
//   因此 readAuthoritativeGlobal() 扫描 lib/*.js 找不到 __xvmAiDefaults 等全局
//   → 返回 null，本组原有 2 项走 readInlineCopies() 内联回退（断言 5 处可见副本
//   彼此相等），全绿且无需改动。新增第 3 项断言把「5 处生成区 vm 求值」直接对齐
//   到权威 JSON，并校验 `\n` 是运行时真换行 U+000A 而非字面反斜杠+n，防静默回归。
//
//   说明：若将来改用「运行时全局单一源」方案，readAuthoritativeGlobal() 的
//   GLOBAL_KEYS 列表与回退分支常量名需相应调整；本轮 v2 不走该路径。
describe('D / 单一数据源一致性', () => {
  // 读取「权威单一源」：扫描 lib/*.js，凡是往 globalThis 挂了 AI 默认值相关的对象
  // 就在 vm 里执行该文件并取出来。去重前不存在这样的文件，返回 null。
  function readAuthoritativeGlobal() {
    const GLOBAL_KEYS = ['__xvmAiDefaults', '__xvmAiPresets', '__xvmGrokDefaults'];
    let libFiles = [];
    try {
      libFiles = readdirSync(resolve(repo, 'lib')).filter((f) => f.endsWith('.js'));
    } catch (_) {
      return null;
    }
    for (const file of libFiles) {
      const src = read(`lib/${file}`);
      if (!GLOBAL_KEYS.some((k) => src.includes(k))) continue;
      const ctx = { window: {}, globalThis: {}, Date, JSON, TextEncoder, TextDecoder, console };
      vm.runInNewContext(src, ctx, { filename: `lib/${file}` });
      for (const key of GLOBAL_KEYS) {
        const fromCtx = ctx.globalThis?.[key] || ctx.window?.[key];
        if (fromCtx && typeof fromCtx === 'object') return fromCtx;
      }
    }
    return null;
  }

  // 从内联常量声明求值（去重前的现状）。
  function readInlineCopies() {
    // content.js 的模板引用了 DEFAULT_GROK_COMMENT_PROMPT，先取出该字符串常量作为前奏。
    const dgpMatch = contentJs.match(/const DEFAULT_GROK_COMMENT_PROMPT\s*=\s*('(?:[^'\\]|\\.)*')/);
    expect(dgpMatch ? dgpMatch[1].length : -1, 'DEFAULT_GROK_COMMENT_PROMPT 应存在').toBeGreaterThan(-1);
    const prelude = `const DEFAULT_GROK_COMMENT_PROMPT = ${dgpMatch[1]};`;

    const contentTemplates = evalConst(contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES', prelude);
    const popupDefs = evalConst(popupJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const bridgeDefs = evalConst(bridgeJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const popupPresets = evalConst(popupJs, 'AI_PLATFORM_PRESETS');
    const bgPresets = evalConst(backgroundJs, 'OPENAI_COMPAT_PLATFORMS');
    return { contentTemplates, popupDefs, bridgeDefs, popupPresets, bgPresets };
  }

  const authoritative = readAuthoritativeGlobal();
  const inline = readInlineCopies();

  // 把「权威源」归一化成 { zhTemplates, presets }；读不到就用内联副本里的
  // 一份充当基准，语义仍是「任意两处可见副本彼此相等」。
  const zhTemplates = authoritative?.zhTemplates
    || authoritative?.zh_CN?.promptTemplates
    || inline.contentTemplates;
  const presets = authoritative?.presets || inline.popupPresets;

  it('zh_CN 默认模板在 content.js / popup.js / bridge.js 中 id/name/prompt 逐字一致', () => {
    const fromPopup = inline.popupDefs.zh_CN.promptTemplates;
    const fromBridge = inline.bridgeDefs.zh_CN.promptTemplates;
    expect(fromPopup).toEqual(zhTemplates);
    expect(fromBridge).toEqual(zhTemplates);
    expect(fromPopup).toEqual(fromBridge);
    // 明确锁住「内容相等」而非引用相等：逐项比对三个字段。
    expect(fromPopup.map((t) => ({ id: t.id, name: t.name, prompt: t.prompt })))
      .toEqual(zhTemplates.map((t) => ({ id: t.id, name: t.name, prompt: t.prompt })));
    expect(fromPopup).toHaveLength(6);
    expect(fromPopup[0]).toMatchObject({ id: 'default', name: '默认评论' });
  });

  it('8 个 platform 预设的 label/baseUrl/model 在 popup.js 与 background.js 完全一致', () => {
    expect(Object.keys(presets)).toHaveLength(8);
    expect(Object.keys(inline.bgPresets)).toHaveLength(8);
    for (const platform of Object.keys(presets)) {
      const a = presets[platform];
      const b = inline.bgPresets[platform];
      expect(b, `background.js 应含平台 ${platform}`).toBeTruthy();
      expect({ label: b.label, baseUrl: b.baseUrl, model: b.model })
        .toEqual({ label: a.label, baseUrl: a.baseUrl, model: a.model });
    }
    expect(inline.popupPresets).toEqual(presets);
  });

  // 新增（WP-E 验收）：4 个消费者的 5 处 ai-defaults:generated 标记区，vm 求值
  // 结果必须与 src/ai-defaults.data.json 权威源逐项相等；并锁死 `\n` 在运行时是
  // 真换行 U+000A，而非字面量反斜杠+n（防止生成器退化为 JSON.stringify 双引号串
  // 或把转义序列写成字面两字符导致静默功能回归）。
  it('5 处生成区 vm 求值 == src/ai-defaults.data.json 权威源，且 \\n 是运行时真换行', () => {
    const START = '// --- ai-defaults:generated:start ---';
    const END = '// --- ai-defaults:generated:end ---';

    // 按标记枚举所有「生成区」并用 vm 真执行，返回具名 const 的值。
    // popup.js 有 2 个生成区，所以必须扫描全部 START/END 对，取包含目标
    // `const NAME =` 声明的那一块，而不是写死第一块。
    // 利用本文件已有的 extractConstExpr / vm 求值方式，保证与 A/B/C 组同源解析。
    function evalGenerated(file, src, name, prelude = '') {
      const declRe = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`);
      let cursor = 0;
      let found = null;
      for (;;) {
        const s = src.indexOf(START, cursor);
        if (s < 0) break;
        const e = src.indexOf(END, s);
        expect(e, `${file} 的生成区 start 都应配对 end`).toBeGreaterThan(-1);
        const block = src.slice(s + START.length, e);
        if (declRe.test(block)) { found = block; break; }
        cursor = e + END.length;
      }
      expect(found, `${file} 的某个生成区应含 ${name} 声明`).toBeTruthy();
      const expr = extractConstExpr(found, name);
      const ctx = {};
      vm.runInNewContext(`${prelude}\nconst __V = ${expr};\nthis.VALUE = __V;`, ctx);
      return ctx.VALUE;
    }

    const data = JSON.parse(read('src/ai-defaults.data.json'));

    // content.js 生成区：DEFAULT_GROK_COMMENT_PROMPT 是单引号字符串，模板数组
    // 的第一项 prompt 直接引用该常量 → 注入 prelude 后再求值模板数组。
    const contentGen = contentJs.slice(
      contentJs.indexOf(START) + START.length,
      contentJs.indexOf(END, contentJs.indexOf(START)),
    );
    const dgpMatch = contentGen.match(/const DEFAULT_GROK_COMMENT_PROMPT\s*=\s*('(?:[^'\\]|\\.)*')/);
    expect(dgpMatch ? dgpMatch[1].length : -1, '生成区应含单引号 DEFAULT_GROK_COMMENT_PROMPT').toBeGreaterThan(-1);
    const dgpPrelude = `const DEFAULT_GROK_COMMENT_PROMPT = ${dgpMatch[1]};`;
    const fromContent = evalGenerated('content.js', contentJs, 'DEFAULT_GROK_PROMPT_TEMPLATES', dgpPrelude);

    const fromPopupDefs = evalGenerated('popup.js', popupJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const fromBridgeDefs = evalGenerated('bridge.js', bridgeJs, 'GROK_DEFAULTS_BY_LANGUAGE');
    const fromPopupPresets = evalGenerated('popup.js', popupJs, 'AI_PLATFORM_PRESETS');
    const fromBgPresets = evalGenerated('background.js', backgroundJs, 'OPENAI_COMPAT_PLATFORMS');

    // 5 处生成区 == 权威源（按各自形状对齐 templates / platforms）。
    expect(fromContent).toEqual(data.templates.zh_CN);
    for (const [label, defs] of [
      ['popup.js', fromPopupDefs], ['bridge.js', fromBridgeDefs],
    ]) {
      expect(defs.zh_CN.promptTemplates, `${label} zh_CN`).toEqual(data.templates.zh_CN);
      expect(defs.en.promptTemplates, `${label} en`).toEqual(data.templates.en);
      expect(defs.ja.promptTemplates, `${label} ja`).toEqual(data.templates.ja);
    }
    expect(fromPopupPresets).toEqual(data.platforms);
    expect(fromBgPresets).toEqual(data.platforms);

    // `\n` 必须是运行时真换行 U+000A：权威源里首个模板 prompt 含 \n，
    // 生成区求值后该位置必须是 '\n' 字符，且不得出现字面反斜杠+n。
    const sample = fromContent[0].prompt;
    expect(sample).toBe(data.templates.zh_CN[0].prompt);
    expect(sample.charCodeAt(sample.indexOf('{推文内容}') + '{推文内容}'.length)).toBe(0x0a);
    expect(sample).toContain('\n');
    expect(sample).not.toContain('\\n'); // 不含字面反斜杠+n 两字符序列
    // 权威源自身也应是真换行（双保险：若 JSON 写成了字面 \\n 也能被这里挡住）。
    expect(data.templates.zh_CN[0].prompt).not.toContain('\\n');
  });
});
