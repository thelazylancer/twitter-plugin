// Prompt templates are user-authored; content.js patches in the two things the
// pipeline depends on (tweet placeholder + code-block instruction). Pinned here
// because a silent regression means Grok returns unparseable replies.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(resolve(here, '..', 'content.js'), 'utf8');
const block = content.match(/\/\/ --- prompt-normalize:start ---([\s\S]*?)\/\/ --- prompt-normalize:end ---/)?.[1];

const ctx = { normalizeGrokPromptText: null };
vm.runInNewContext(`${block}\nthis.normalizeGrokPromptText = normalizeGrokPromptText;`, ctx);
const norm = ctx.normalizeGrokPromptText;

describe('normalizeGrokPromptText', () => {
  it('leaves a complete template untouched', () => {
    const tpl = '{推文内容}\n\n生成10条评论，每条用代码块包裹。';
    expect(norm(tpl)).toBe(tpl);
  });

  it('prepends the tweet placeholder when missing', () => {
    expect(norm('用贴吧老哥的语气写评论，用代码块包裹')).toBe('{推文内容}\n\n用贴吧老哥的语气写评论，用代码块包裹');
  });

  it('appends the code-block instruction in the template language', () => {
    expect(norm('{推文内容}\n\n写十条评论')).toContain('用代码块包裹');
    expect(norm('{推文内容}\n\nWrite ten replies')).toContain('code block');
    expect(norm('{推文内容}\n\n返信を十件書いてください')).toContain('コードブロック');
  });

  it('patches both when both are missing', () => {
    const out = norm('写十条评论');
    expect(out.startsWith('{推文内容}\n\n')).toBe(true);
    expect(out).toContain('用代码块包裹');
  });

  it('keeps empty input empty', () => {
    expect(norm('')).toBe('');
    expect(norm(null)).toBe('');
  });
});
