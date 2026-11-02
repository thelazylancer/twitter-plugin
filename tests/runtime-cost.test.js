// The content script wakes up every two seconds on every x.com page. These
// tests pin the parts of that tick that must not repeat work when nothing
// changed. The difference is invisible, but it is what keeps an idle tab from
// re-reading and re-drawing the same DOM forever.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const contentJs = readFileSync(resolve(repo, 'content.js'), 'utf8');

function sliceFunction(name) {
  const start = contentJs.indexOf(`function ${name}(`);
  expect(start, `${name} should exist`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = contentJs.indexOf('{', start); i < contentJs.length; i += 1) {
    if (contentJs[i] === '{') depth += 1;
    else if (contentJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return contentJs.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe('the two-second tick', () => {
  it('does not map every article outside the owner’s own thread', () => {
    // authorReplyStatusIds already returns [] on a feed or someone else's
    // post; building the card list first made that decision cost a full DOM
    // sweep every two seconds.
    expect(contentJs).toContain('if (!pageStatusId) {');
    expect(contentJs).toContain(
      'const focalIsOwn = !!focal && (focalHandle ? focalHandle === me : articleHasOwnAnalytics(focal));',
    );
    expect(contentJs).toContain('if (!focalIsOwn) {');
  });

  it('reuses the logged-in handle for five seconds', () => {
    let now = 1000;
    const ctx = {
      Date: { now: () => now },
      calls: 0,
      document: {
        querySelector() {
          ctx.calls += 1;
          return { getAttribute: () => '/Lancer' };
        },
      },
    };
    vm.createContext(ctx);
    vm.runInContext(
      `let _loggedInHandle = '';
       let _loggedInHandleAt = 0;
       const LOGGED_IN_HANDLE_TTL_MS = 5000;
       ${sliceFunction('getLoggedInHandle')};
       this.handle = getLoggedInHandle;`,
      ctx,
    );

    expect(ctx.handle()).toBe('lancer');
    expect(ctx.handle()).toBe('lancer');
    expect(ctx.calls).toBe(1);

    now = 7000;
    expect(ctx.handle()).toBe('lancer');
    expect(ctx.calls).toBe(2);
  });

  it('leaves an unchanged leaderboard list in place', () => {
    expect(contentJs).toContain("let leaderboardHtml = '';");
    expect(contentJs).toContain('const rebuilt = html !== leaderboardHtml;');
    expect(contentJs).toContain("leaderboardEl.querySelector('.xvm-lb-list')?.addEventListener('click'");
    expect(contentJs).not.toContain("list.querySelectorAll('.xvm-lb-item').forEach");
  });

  it('leaves an unchanged comment board list in place', () => {
    expect(contentJs).toContain("let commentBoardHtml = '';");
    expect(contentJs).toContain('if (html !== commentBoardHtml) {');
    expect(contentJs).toContain("el.querySelector('.xvm-lb-list')?.addEventListener('click'");
    expect(contentJs).not.toContain("list.querySelectorAll('.xvm-cb-item').forEach");
  });

  it('parses a notification’s kind once per timestamp', () => {
    expect(contentJs).toContain('cell.dataset.xvmNotifStamp');
    expect(contentJs).toContain('cell.dataset.xvmNotifKind');
  });

  it('samples the page canvas at most every five seconds', () => {
    expect(contentJs).toContain('now - _pageSurfaceCheckedAt < 5000');
    expect(contentJs).toContain('syncPageSurfaceTheme(true);');
  });
});
