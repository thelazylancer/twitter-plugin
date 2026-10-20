// Named slots let a prompt place each piece of context itself. The three
// invariants below are what keep that safe: an empty slot must not leave a
// dangling label, a substituted value must never be re-expanded, and a prompt
// that only uses metadata slots still gets the post body.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const contentJs = readFileSync(resolve(here, '..', 'content.js'), 'utf8');
const backgroundJs = readFileSync(resolve(here, '..', 'background.js'), 'utf8');

const block = contentJs.match(/\/\/ --- prompt-normalize:start ---([\s\S]*?)\/\/ --- prompt-normalize:end ---/)?.[1];
const ctx = {};
vm.runInNewContext(`${block}\nthis.norm = normalizeGrokPromptText; this.render = renderGrokContext;`, ctx);
const { norm, render } = ctx;

describe('named context slots', () => {
  it('substitutes every slot it is given', () => {
    const out = render('{作者} 说：{当前评论}\n\n{关注状态}\n\n{数据}', {
      作者: '@ann',
      当前评论: '@ann：Nice work!',
      关注状态: '你和@ann是互相关注',
      数据: '浏览 1.2k · 点赞 30',
    });
    expect(out).toContain('@ann 说：@ann：Nice work!');
    expect(out).toContain('你和@ann是互相关注');
    expect(out).toContain('浏览 1.2k · 点赞 30');
    expect(out).not.toMatch(/\[(?:作者|当前评论|关注状态|数据)\]/);
  });

  it('removes an empty slot instead of leaving a bare label', () => {
    const out = render('{主贴}\n\n{当前评论}\n\n{关注状态}\n\n要求：简短。', {
      主贴: 'Today I shipped a thing.',
      当前评论: '@ann：Nice work!',
      关注状态: '',
    });
    expect(out).not.toContain('{关注状态}');
    expect(out).not.toContain('【关注状态】');
    expect(out).not.toContain('\n\n\n');
    expect(out).toContain('要求：简短。');
  });

  it('does not re-expand a value that looks like a slot', () => {
    const out = render('{推文内容}\n\n要求：简短。', {
      推文内容: '我的推文里就写了 {当前评论} 这四个字',
      当前评论: 'SHOULD NOT APPEAR',
    });
    expect(out).toContain('{当前评论}');
    expect(out).not.toContain('SHOULD NOT APPEAR');
  });

  it('expands {推文内容} to the whole context block', () => {
    const out = render('{推文内容}\n\n要求：简短。', { 推文内容: '【主贴】\nA\n\n【当前评论】\n@ann：B' });
    expect(out).toBe('【主贴】\nA\n\n【当前评论】\n@ann：B\n\n要求：简短。');
  });
});

describe('normalizeGrokPromptText with slots', () => {
  it('does not prepend {推文内容} when a body slot is already placed', () => {
    const tpl = '{主贴}\n\n{当前评论}\n\n要求：简短。';
    expect(norm(tpl)).not.toContain('{推文内容}');
  });

  it('still prepends {推文内容} for a metadata-only slot', () => {
    const out = norm('{关注状态}\n\n写三条评论');
    expect(out.startsWith('{推文内容}')).toBe(true);
  });

  it('picks the code-block hint language without being fooled by slot names', () => {
    // Every slot token is Chinese; without stripping them this English prompt
    // would get the zh hint.
    expect(norm('{作者}\n\nWrite three replies to this post.')).toContain('code block');
  });

  it('leaves slot-free templates behaving exactly as before', () => {
    const tpl = '{推文内容}\n\n生成10条评论，每条用代码块包裹。';
    expect(norm(tpl)).toBe(tpl);
  });
});

describe('background defers to the page-rendered prompt', () => {
  function loadBackground() {
    const context = {
      chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: { sync: { get: async () => ({}) }, local: { get: async () => ({}) } },
      },
      fetch: async () => ({ ok: true, json: async () => ({}) }),
      URL, AbortController, TextDecoder, setTimeout, clearTimeout, console,
    };
    vm.createContext(context);
    vm.runInContext(backgroundJs, context);
    return context;
  }

  it('does not splice the tweet block twice when the page already rendered', () => {
    const { renderPrompt } = loadBackground();
    const prompt = renderPrompt('THE WHOLE BLOCK', '{推文内容}\n\n要求：简短。', 3, {
      replyLanguage: 'zh',
      preRendered: true,
    });
    // The page replaced {推文内容} already; the block must not reappear.
    expect(prompt).toContain('{推文内容}');
    expect(prompt).not.toContain('THE WHOLE BLOCK');
  });

  it('still renders the placeholder when the page did not pre-render', () => {
    const { renderPrompt } = loadBackground();
    const prompt = renderPrompt('THE WHOLE BLOCK', '{推文内容}\n\n要求：简短。', 3, { replyLanguage: 'zh' });
    expect(prompt).toContain('THE WHOLE BLOCK');
  });
});

describe('slot wiring', () => {
  it('content.js sends the pre-rendered flag', () => {
    expect(contentJs).toContain('promptPreRendered: true');
    expect(contentJs).toContain('renderGrokContext(normalizeGrokPromptText(tpl?.prompt || tpl), contextSlots)');
  });

  it('every generation branch produces slot values', () => {
    expect(contentJs).toContain('contextSlots = payload.slots;');
    // A job without slot values still has to render {推文内容}; otherwise every
    // slot expands empty and the post disappears from the prompt.
    expect(contentJs).toContain('contextSlots = authorJob.slots || { 推文内容: authorJob.context };');
    expect(contentJs).toContain('对该推文的回复: replyText,');
    expect(contentJs).toContain('数据: describeTweetStats(article),');
  });

  it('keeps the bundled prompts free of the stale label inside the status value', () => {
    // describeFollowRelation returns the label; the slot must strip it or the
    // model sees 【关注状态】 twice.
    expect(contentJs).toContain('关注状态: stripSlotLabel(relationNote),');
    expect(contentJs).toContain("return String(note || '').replace(/^【[^】]+】/, '').trim();");
  });
});
