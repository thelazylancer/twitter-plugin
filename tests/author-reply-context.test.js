import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const contentJs = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../content.js'), 'utf8');

describe('author reply reads the main post and the current comment', () => {
  it('builds a two-part context and refuses to reply from only one of them', () => {
    expect(contentJs).toContain('【主贴】\\n${mainText}\\n\\n【当前评论】\\n${who}：${commentText}');
    expect(contentJs).toContain('if (!mainText || !commentText || mainText === commentText) return null;');
    expect(contentJs).toContain("showGrokErrorToast('没读到主贴或当前评论')");
  });

  it('reads both texts before opening the reply composer', () => {
    const start = contentJs.indexOf('async function startAuthorReply');
    const click = contentJs.indexOf('replyBtn.click()', start);
    const build = contentJs.indexOf('buildAuthorReplyPayload(article, mainArticle)', start);
    expect(start).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(start);
    expect(click).toBeGreaterThan(build);
  });

  it('passes the assembled context into generation instead of re-reading the composer', () => {
    expect(contentJs).toContain('handleGrokGenerate(btn, editable, { id: \'author-reply\', name: \'回评\', prompt: AUTHOR_REPLY_PROMPT }, payload)');
    expect(contentJs).toContain('if (authorJob?.context)');
    expect(contentJs).toContain('tweetText = authorJob.context');
  });
});
