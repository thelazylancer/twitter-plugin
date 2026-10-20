// 1.18.13 removed the separate long-post template list. A user's own long-post
// templates must survive the upgrade; the bundled ones must not pile up.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const bridge = readFileSync(resolve(here, '..', 'bridge.js'), 'utf8');
const block = bridge.match(/\/\/ --- article-template-migration:start ---([\s\S]*?)\/\/ --- article-template-migration:end ---/)?.[1];
const ctx = {};
vm.runInNewContext(`${block}\nthis.merge = mergeLegacyArticleTemplates; this.bundled = LEGACY_BUNDLED_ARTICLE_PROMPTS;`, ctx);
const { merge, bundled } = ctx;

const DEFAULTS = [{ id: 'default', name: '默认', prompt: '{推文内容}\n\n默认' }];
const bundledPrompt = [...bundled][0];

describe('mergeLegacyArticleTemplates', () => {
  it('knows all six templates that shipped in 1.18.12', () => {
    expect(bundled.size).toBe(6);
  });

  it('does nothing when the long-post list was only the shipped defaults', () => {
    expect(merge(DEFAULTS, [{ id: 'article-default', name: '文章评论', prompt: bundledPrompt }], DEFAULTS)).toBe(null);
    expect(merge(DEFAULTS, [], DEFAULTS)).toBe(null);
    expect(merge(DEFAULTS, undefined, DEFAULTS)).toBe(null);
  });

  it('appends a user-written long-post template to the existing list', () => {
    const mine = [{ id: 'default', name: '我的', prompt: '{推文内容}\n\n我的短评' }];
    const out = merge(mine, [{ id: 'article-default', name: '文章评论', prompt: bundledPrompt }, { id: 'custom-1', name: '长文毒舌', prompt: '{推文内容}\n\n毒舌点评长文' }], DEFAULTS);
    expect(out.map((t) => t.name)).toEqual(['我的', '长文毒舌']);
  });

  it('an edited shipped template counts as the user\'s own', () => {
    const out = merge(null, [{ id: 'article-default', name: '文章评论', prompt: bundledPrompt + '\n再加一条要求' }], DEFAULTS);
    expect(out.map((t) => t.id)).toEqual(['default', 'article-default']);
  });

  it('falls back to the defaults when the user never saved a short list, and never duplicates ids or prompts', () => {
    const out = merge([], [
      { id: 'default', name: '同 id', prompt: '{推文内容}\n\n不同内容' },
      { id: 'x', name: '重复内容', prompt: '{推文内容}\n\n默认' },
    ], DEFAULTS);
    expect(out.map((t) => t.id)).toEqual(['default', 'default-legacy']);
  });
});
