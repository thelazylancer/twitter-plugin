// Give-and-take ledger: my replies/likes toward a handle vs their replies/
// likes/reposts toward me. The content script observes, the popup renders.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const contentJs = readFileSync(resolve(repo, 'content.js'), 'utf8');
const bridgeJs = readFileSync(resolve(repo, 'bridge.js'), 'utf8');
const popupHtml = readFileSync(resolve(repo, 'popup.html'), 'utf8');
const popupScript = readFileSync(resolve(repo, 'popup-reciprocity.js'), 'utf8');
const dashboardJs = readFileSync(resolve(repo, 'popup-dashboard.js'), 'utf8');

// Run the ledger block for real: the counters, dedupe, hydration replay, and
// save payload are the parts that are easy to get subtly wrong.
function loadLedger() {
  const start = contentJs.indexOf('const RECIPROCITY_FIELDS');
  const end = contentJs.indexOf('// Whoever replied to the root of one of my own posts replied to me.');
  expect(start, 'ledger block should exist').toBeGreaterThan(-1);
  expect(end, 'ledger block should end before observeRepliersToMe').toBeGreaterThan(start);
  const src = contentJs.slice(start, end);
  const ctx = {
    window: {
      postMessage: (msg) => ctx.sent.push(msg),
      addEventListener: () => {},
      location: { pathname: '/' },
    },
    document: { addEventListener: () => {} },
    Element: class {},
    getLoggedInHandle: () => 'me',
    setTimeout,
    clearTimeout,
  };
  ctx.sent = [];
  vm.runInNewContext(`
    const reciprocityLedger = new Map();
    const reciprocitySeen = new Map();
    let reciprocitySaveTimer = 0;
    let reciprocityHydrated = false;
    const reciprocityPending = [];
    ${src}
    this.api = {
      recordReciprocity,
      removeReciprocityEvent,
      hydrateReciprocity,
      observeReciprocityFromPayload,
      flushReciprocity,
      ledger: reciprocityLedger,
      seen: reciprocitySeen,
    };
  `, ctx);
  ctx.api.sent = ctx.sent;
  ctx.api.setPath = (pathname) => { ctx.window.location.pathname = pathname; };
  return ctx.api;
}

describe('give-and-take ledger', () => {
  it('counts my reply against the person I replied to, once', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    const payload = {
      id: 'reply-1',
      screenName: 'Me',
      inReplyToScreenName: 'alice',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    api.observeReciprocityFromPayload(payload);
    api.observeReciprocityFromPayload(payload); // the same tweet in another response
    const entry = api.ledger.get('alice');
    expect(entry.outReply).toBe(1);
    expect(entry.inReply).toBe(0);
    expect(api.seen.has('or:reply-1')).toBe(true);
    api.flushReciprocity();
  });

  it('counts their reply to me and ignores my reply to myself', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.observeReciprocityFromPayload({ id: 'r2', screenName: 'alice', inReplyToScreenName: 'me' });
    api.observeReciprocityFromPayload({ id: 'r3', screenName: 'me', inReplyToScreenName: 'me' });
    // Alice replying inside her own thread is not a reply to me.
    api.observeReciprocityFromPayload({ id: 'r4', screenName: 'alice', inReplyToScreenName: 'alice' });
    expect(api.ledger.get('alice').inReply).toBe(1);
    expect(api.ledger.get('me')).toBeUndefined();
    expect(api.seen.has('ir:r2')).toBe(true);
    expect(api.seen.has('ir:r4')).toBe(false);
    api.flushReciprocity();
  });

  it('replays queued observations after hydration without double-counting stored events', () => {
    const api = loadLedger();
    api.recordReciprocity('alice', 'out', 'reply', 'or:r1', 100);
    api.recordReciprocity('alice', 'out', 'reply', 'or:r2', 200);
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 1, outLike: 0, inReply: 0, inLike: 0, inRepost: 0, lastAt: 100 } },
      seen: { 'or:r1': { h: 'alice', d: 'out', k: 'reply', at: 100 } },
    }, false);
    expect(api.ledger.get('alice').outReply).toBe(2);
    api.flushReciprocity();
  });

  it('withdraws a like on unlike, and forgets the handle when it hits zero', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'out', 'like', 'ol:5', 100);
    expect(api.ledger.get('alice').outLike).toBe(1);
    api.removeReciprocityEvent('ol:5');
    expect(api.ledger.get('alice')).toBeUndefined();
    expect(api.seen.has('ol:5')).toBe(false);
    api.flushReciprocity();
  });

  it('backfills my likes while I am on my own Likes tab', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.setPath('/me/likes');
    api.observeReciprocityFromPayload({ id: 'post-9', screenName: 'alice', inReplyToScreenName: '' });
    expect(api.ledger.get('alice').outLike).toBe(1);
    api.flushReciprocity();
  });

  it('clearing wipes the ledger and stops a pending save from restoring it', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'in', 'like', 'il:alice:9', 100);
    api.hydrateReciprocity(null, true);
    expect(api.ledger.size).toBe(0);
    expect(api.seen.size).toBe(0);
    api.flushReciprocity();
    expect(api.sent.filter((m) => m.type === 'XVM_RECIPROCITY_SAVE')).toHaveLength(0);
  });

  it('saves counters and dedupe keys together', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'in', 'repost', 'it:alice:9', 100);
    api.flushReciprocity();
    const save = api.sent.find((m) => m.type === 'XVM_RECIPROCITY_SAVE');
    expect(save.reciprocity.ledger.alice.inRepost).toBe(1);
    expect(save.reciprocity.seen['it:alice:9']).toMatchObject({ h: 'alice', d: 'in', k: 'repost' });
    expect(Number.isFinite(save.reciprocity.seen['it:alice:9'].at)).toBe(true);
    expect(Number.isFinite(save.reciprocity.savedAt)).toBe(true);
  });
});

describe('give-and-take capture', () => {
  it('records my replies and their replies from the tweet payload', () => {
    expect(contentJs).toContain("recordReciprocity(target, 'out', 'reply', `or:${data.id}`, at)");
    expect(contentJs).toContain("recordReciprocity(author, 'in', 'reply', `ir:${data.id}`, at)");
  });

  it('records likes on click and withdraws them on unlike', () => {
    expect(contentJs).toContain('button[data-testid="like"], button[data-testid="unlike"]');
    expect(contentJs).toContain("recordReciprocity(author, 'out', 'like', `ol:${id}`, Date.now())");
    expect(contentJs).toContain('removeReciprocityEvent(`ol:${id}`)');
  });

  it('backfills likes from the account owner’s Likes tab', () => {
    expect(contentJs).toContain('function isOwnLikesPage(me = getLoggedInHandle())');
    expect(contentJs).toContain("recordReciprocity(author, 'out', 'like', `ol:${data.id}`, at)");
  });

  it('records likes and reposts from notifications against the acted-on post', () => {
    expect(contentJs).toContain('function notificationStatusId(cell, me)');
    expect(contentJs).toContain("`${kind === 'like' ? 'il' : 'it'}:${actor.toLowerCase()}:${postId}`");
    // Mentions inside the liked post must not become actors.
    expect(contentJs).toContain('cell.querySelectorAll(\'a[href^="/"] img\')');
  });

  it('never attributes a notification reply to me', () => {
    // A notification row can be "X replied to their own post". Inbound replies
    // must come from the payload's in_reply_to_screen_name, or from the reply
    // list under my own status — never from the notification actor.
    expect(contentJs).toContain("if (kind !== 'reply') recordInteraction(actor, kind, at);");
    expect(contentJs).toContain("const postId = kind === 'like' || kind === 'repost' ? notificationStatusId(cell, me) : '';");
    expect(contentJs).toContain('if (target === me) {');
    expect(contentJs).toContain('data.inReplyToStatusId !== rootId');
  });

  it('only counts a like/repost notification when the embedded post is mine', () => {
    // The embedded article is the post that was acted on. Checking its author
    // keeps a notification about someone else's quote of my post out of my
    // inbound side, and its own timestamp link avoids keying against the quote.
    expect(contentJs).toContain('const author = articleHandle(post);');
    expect(contentJs).toContain("if (!author || !me || author !== me.toLowerCase()) return '';");
    expect(contentJs).toContain('return articleOwnStatusId(post);');
  });

  it('dedupes every event and queues observations until the store loads', () => {
    expect(contentJs).toContain('if (reciprocitySeen.has(key)) return;');
    expect(contentJs).toContain('if (!reciprocityHydrated) {');
    expect(contentJs).toContain('reciprocityPending.push');
    expect(contentJs).toContain('for (const [handle, dir, kind, key, at] of pending) recordReciprocity');
  });

  it('caps the stored ledger and forwards a popup clear to open tabs', () => {
    expect(bridgeJs).toContain("type === 'XVM_RECIPROCITY_SAVE'");
    expect(bridgeJs).toContain('xvmReciprocity');
    expect(bridgeJs).toContain('RECIPROCITY_MAX_EVENTS');
    expect(bridgeJs).toContain("type: 'XVM_RECIPROCITY_LOAD', reciprocity: null, cleared: true");
    expect(contentJs).toContain('hydrateReciprocity(event.data.reciprocity, event.data.cleared === true)');
  });
});

describe('in-feed reciprocity chip', () => {
  it('paints a compact ratio only for handles with a ledger entry', () => {
    expect(contentJs).toContain('function paintReciprocityMarks');
    expect(contentJs).toContain('const entry = reciprocityLedger.get(handle)');
    expect(contentJs).toContain("`${i18n('recipMine')} ${t.mine} : ${t.theirs}`");
    expect(contentJs).toContain('chip.classList.toggle(\'xvm-recip--oneway\', t.mine > 0 && t.theirs === 0)');
  });

  it('leaves the corner to 未关注 and skips self / promoted / quoted posts', () => {
    expect(contentJs).toContain('relationForComment(article)?.following === false');
    expect(contentJs).toContain('handle === me');
    expect(contentJs).toContain('isPromotedArticle(article)');
    expect(contentJs).toContain('article.parentElement?.closest?.(\'article[data-testid="tweet"]\')');
    expect(contentJs).toContain('function removeReciprocityMark');
  });

  it('refreshes after ledger changes and exposes the breakdown on hover', () => {
    expect(contentJs).toContain('function scheduleReciprocityPaint');
    expect(contentJs).toContain("if (typeof scheduleReciprocityPaint === 'function') scheduleReciprocityPaint();");
    expect(contentJs).toContain("i18n('contentRecipLastAt')");
    expect(contentJs).toContain("i18n('recipHint')");
  });

  it('can be turned off from the tab and is persisted in sync storage', () => {
    expect(contentJs).toContain('reciprocityInlineEnabled = event.data.reciprocityInlineEnabled !== false');
    expect(bridgeJs).toContain('reciprocityInlineEnabled: raw?.reciprocityInlineEnabled !== false');
    expect(bridgeJs).toContain('changes.reciprocityInlineEnabled');
    expect(popupHtml).toContain('id="recip-inline-toggle"');
    expect(popupScript).toContain("const INLINE_KEY = 'reciprocityInlineEnabled'");
    expect(popupScript).toContain('chrome.storage.sync.set({ [INLINE_KEY]: el.checked })');
  });

  it('forwards the chip strings to the content script', () => {
    for (const key of ['recipMine', 'recipTheirs', 'recipReply', 'recipLike', 'recipRepost', 'recipHint', 'contentRecipLastAt']) {
      expect(bridgeJs).toContain(`'${key}'`);
    }
  });
});

describe('reciprocity panel', () => {
  it('lives in the Marks tab instead of taking a tab of its own', () => {
    expect(popupHtml).not.toContain('data-tab="reciprocity"');
    expect(popupHtml).not.toContain('id="tabpanel-reciprocity"');
    const start = popupHtml.indexOf('id="tabpanel-marks"');
    const end = popupHtml.indexOf('</section>', start);
    const marks = popupHtml.slice(start, end);
    expect(marks).toContain('id="recip-inline-toggle"');
    expect(marks).toContain('id="recip-list"');
    expect(marks).toContain('id="recip-summary-meta"');
    expect(dashboardJs).not.toMatch(/'leaderboard', 'reciprocity'/);
    expect(dashboardJs).toContain("reciprocity: 'marks'");
  });

  it('sorts by imbalance and keeps the one-way filter', () => {
    expect(popupScript).toContain("state.filter === 'oneway' && !oneway");
    expect(popupScript).toContain('(b.mine - b.theirs) - (a.mine - a.theirs)');
    expect(popupScript).toContain('sum.mine > 0 && sum.theirs === 0');
  });

  it('counts replies and likes as mine, replies/likes/reposts as theirs', () => {
    expect(popupScript).toContain('mine: outReply + outLike');
    expect(popupScript).toContain('theirs: inReply + inLike + inRepost');
  });

  it('clears the stored ledger in two steps', () => {
    expect(popupScript).toContain("t('recipClearConfirm')");
    expect(popupScript).toContain('chrome.storage.local.remove(STORAGE_KEY)');
  });

  it('declares every new string in en + zh_CN + ja', () => {
    const keys = [
      'tabReciprocity', 'recipFilterAll', 'recipFilterOneWay', 'recipClear',
      'recipClearConfirm', 'recipHint', 'recipSync', 'recipEmpty',
      'recipEmptyFilter', 'recipMine', 'recipTheirs', 'recipReply',
      'recipLike', 'recipRepost', 'recipInlineTitle', 'recipInlineDesc',
      'recipRanking', 'recipPeople', 'contentRecipLastAt',
    ];
    for (const locale of ['en', 'zh_CN', 'ja']) {
      const messages = JSON.parse(readFileSync(resolve(repo, `_locales/${locale}/messages.json`), 'utf8'));
      for (const key of keys) {
        expect(messages[key]?.message, `${locale} is missing ${key}`).toBeTruthy();
        // content/popup i18n never substitutes, so chrome.i18n placeholders
        // would render literally.
        expect(messages[key].message).not.toMatch(/\$\d+\$/);
      }
    }
  });
});
