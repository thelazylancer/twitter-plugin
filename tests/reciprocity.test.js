// Give-and-take ledger: the posts I engaged with per handle vs the posts of
// mine they engaged with. The content script observes, the popup renders.
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

// Run the ledger block for real: the post counters, per-post dedupe, hydration
// replay, and save payload are the parts that are easy to get subtly wrong.
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
    getStatusIdFromLocation: () => '',
    isOwnStatusPage: () => false,
    tweetDataStore: new Map(),
    setTimeout,
    clearTimeout,
  };
  ctx.sent = [];
  vm.runInNewContext(`
    const reciprocityLedger = new Map();
    const reciprocityPosts = new Map();
    const reciprocityLegacyEvents = new Set();
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
      posts: reciprocityPosts,
      legacyEvents: reciprocityLegacyEvents,
      tweetDataStore,
    };
  `, ctx);
  ctx.api.sent = ctx.sent;
  ctx.api.setPath = (pathname) => { ctx.window.location.pathname = pathname; };
  return ctx.api;
}

describe('give-and-take ledger', () => {
  it('counts my reply against the post I replied to, once', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    const payload = {
      id: 'reply-1',
      screenName: 'Me',
      inReplyToScreenName: 'alice',
      inReplyToStatusId: 'alice-post-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    api.observeReciprocityFromPayload(payload);
    api.observeReciprocityFromPayload(payload); // the same tweet in another response
    const entry = api.ledger.get('alice');
    expect(entry.outReply).toBe(1);
    expect(entry.outPosts).toBe(1);
    expect(entry.inReply).toBe(0);
    expect(entry.inPosts).toBe(0);
    expect(api.posts.size).toBe(1);
    api.flushReciprocity();
  });

  it('does not refresh the post record when the same event is observed again', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    const payload = {
      id: 'reply-1',
      screenName: 'Me',
      inReplyToScreenName: 'alice',
      inReplyToStatusId: 'alice-post-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    api.observeReciprocityFromPayload(payload);
    const post = [...api.posts.values()][0];
    const touchedAt = post.at;
    const firstLastAt = api.ledger.get('alice').lastAt;
    // The DOM and notification scans re-see the same reply every couple of
    // seconds; that must not keep the post's TTL alive or queue a save.
    api.observeReciprocityFromPayload(payload);
    expect(post.at).toBe(touchedAt);
    expect(api.ledger.get('alice').lastAt).toBe(firstLastAt);
    // A second, newer reply on the same post stays one post but moves lastAt.
    api.observeReciprocityFromPayload({ ...payload, id: 'reply-2', createdAt: '2026-02-01T00:00:00.000Z' });
    expect(api.ledger.get('alice').outReply).toBe(1);
    expect(api.ledger.get('alice').outPosts).toBe(1);
    expect(api.ledger.get('alice').lastAt).toBe(Date.parse('2026-02-01T00:00:00.000Z'));
    expect(post.at).toBe(touchedAt);
    api.flushReciprocity();
  });

  it('counts their reply to my post and ignores replies that are not under my post', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.tweetDataStore.set('my-root', { id: 'my-root', screenName: 'me', conversationId: 'my-root' });
    api.observeReciprocityFromPayload({
      id: 'r2', screenName: 'alice', inReplyToScreenName: 'me',
      inReplyToStatusId: 'my-root', conversationId: 'my-root',
    });
    api.observeReciprocityFromPayload({ id: 'r3', screenName: 'me', inReplyToScreenName: 'me' });
    // Alice replying inside her own thread is not a reply to me.
    api.observeReciprocityFromPayload({ id: 'r4', screenName: 'alice', inReplyToScreenName: 'alice' });
    const entry = api.ledger.get('alice');
    expect(entry.inReply).toBe(1);
    expect(entry.inPosts).toBe(1);
    expect(api.ledger.get('me')).toBeUndefined();
    expect(api.posts.size).toBe(1);
    api.flushReciprocity();
  });

  it('does not count a reply to my reply inside the other person’s thread', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.tweetDataStore.set('alice-root', { id: 'alice-root', screenName: 'alice', conversationId: 'alice-root' });
    api.tweetDataStore.set('my-reply', {
      id: 'my-reply', screenName: 'me', inReplyToStatusId: 'alice-root', conversationId: 'alice-root',
    });
    api.observeReciprocityFromPayload({
      id: 'alice-answer',
      screenName: 'alice',
      inReplyToScreenName: 'me',
      inReplyToStatusId: 'my-reply',
      conversationId: 'alice-root',
    });
    expect(api.ledger.get('alice')).toBeUndefined();
    expect(api.posts.size).toBe(0);
    api.flushReciprocity();
  });

  it('counts a reply to my reply when the conversation root is my post', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.tweetDataStore.set('my-root', { id: 'my-root', screenName: 'me', conversationId: 'my-root' });
    api.tweetDataStore.set('my-reply', {
      id: 'my-reply', screenName: 'me', inReplyToStatusId: 'my-root', conversationId: 'my-root',
    });
    api.observeReciprocityFromPayload({
      id: 'alice-answer',
      screenName: 'alice',
      inReplyToScreenName: 'me',
      inReplyToStatusId: 'my-reply',
      conversationId: 'my-root',
    });
    const entry = api.ledger.get('alice');
    expect(entry.inReply).toBe(1);
    expect(entry.inPosts).toBe(1);
    api.flushReciprocity();
  });

  it('walks the parent chain and keys the interaction by the root post', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.tweetDataStore.set('my-root', { id: 'my-root', screenName: 'me' });
    api.tweetDataStore.set('my-reply', {
      id: 'my-reply', screenName: 'me', inReplyToStatusId: 'my-root',
    });
    api.observeReciprocityFromPayload({
      id: 'alice-answer',
      screenName: 'alice',
      inReplyToScreenName: 'me',
      inReplyToStatusId: 'my-reply',
    });
    // A like notification on the root is the same post, not a second one.
    api.recordReciprocity('alice', 'in', 'like', 'my-root', 200);
    const entry = api.ledger.get('alice');
    expect(entry.inReply).toBe(1);
    expect(entry.inLike).toBe(1);
    expect(entry.inPosts).toBe(1);
    api.flushReciprocity();
  });

  it('counts one post once when I both reply to it and like it', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'out', 'reply', 'alice-post-1', 100);
    api.recordReciprocity('alice', 'out', 'like', 'alice-post-1', 200);
    const entry = api.ledger.get('alice');
    expect(entry.outReply).toBe(1);
    expect(entry.outLike).toBe(1);
    expect(entry.outPosts).toBe(1);
    expect(entry.inPosts).toBe(0);
    // A second post is a second investment.
    api.recordReciprocity('alice', 'out', 'like', 'alice-post-2', 300);
    expect(entry.outLike).toBe(2);
    expect(entry.outPosts).toBe(2);
    api.flushReciprocity();
  });

  it('counts one of my posts once when they reply, like, and repost it', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'in', 'reply', 'my-post-1', 100);
    api.recordReciprocity('alice', 'in', 'like', 'my-post-1', 200);
    api.recordReciprocity('alice', 'in', 'repost', 'my-post-1', 300);
    const entry = api.ledger.get('alice');
    expect(entry.inReply).toBe(1);
    expect(entry.inLike).toBe(1);
    expect(entry.inRepost).toBe(1);
    expect(entry.inPosts).toBe(1);
    expect(entry.outPosts).toBe(0);
    api.recordReciprocity('alice', 'in', 'like', 'my-post-2', 400);
    expect(entry.inLike).toBe(2);
    expect(entry.inPosts).toBe(2);
    api.flushReciprocity();
  });

  it('collapses an old like and repost on the same post during migration', () => {
    const api = loadLedger();
    const at = Date.now();
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 0, outLike: 0, inReply: 0, inLike: 1, inRepost: 1, lastAt: at } },
      seen: {
        'il:alice:9': { h: 'alice', d: 'in', k: 'like', at },
        'it:alice:9': { h: 'alice', d: 'in', k: 'repost', at },
      },
    }, false);
    const entry = api.ledger.get('alice');
    expect(entry.inLike).toBe(1);
    expect(entry.inRepost).toBe(1);
    expect(entry.inPosts).toBe(1);
    api.flushReciprocity();
  });

  it('keeps two different posts apart during migration', () => {
    const api = loadLedger();
    const at = Date.now();
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 0, outLike: 0, inReply: 0, inLike: 1, inRepost: 1, lastAt: at } },
      seen: {
        'il:alice:9': { h: 'alice', d: 'in', k: 'like', at },
        'it:alice:10': { h: 'alice', d: 'in', k: 'repost', at },
      },
    }, false);
    expect(api.ledger.get('alice').inPosts).toBe(2);
    api.flushReciprocity();
  });

  it('does not collapse when the old seen map is incomplete', () => {
    // Two likes and one repost were counted, but the seen map only retains one
    // like (the cap or TTL pruned the other). Reducing to the seen post count
    // would drop a post that is still in the counters.
    const api = loadLedger();
    const at = Date.now();
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 0, outLike: 0, inReply: 0, inLike: 2, inRepost: 1, lastAt: at } },
      seen: {
        'il:alice:9': { h: 'alice', d: 'in', k: 'like', at },
        'it:alice:9': { h: 'alice', d: 'in', k: 'repost', at },
      },
    }, false);
    expect(api.ledger.get('alice').inPosts).toBe(3);
    api.flushReciprocity();
  });

  it('replays queued observations after hydration without double-counting a stored post', () => {
    const api = loadLedger();
    api.recordReciprocity('alice', 'out', 'like', '5', 100);
    api.recordReciprocity('alice', 'out', 'like', '6', 200);
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 0, outLike: 1, inReply: 0, inLike: 0, inRepost: 0, lastAt: 100 } },
      seen: { 'ol:5': { h: 'alice', d: 'out', k: 'like', at: 100 } },
    }, false);
    const entry = api.ledger.get('alice');
    expect(entry.outLike).toBe(2);
    expect(entry.outPosts).toBe(2);
    api.flushReciprocity();
  });

  it('merges a stored like with a new reply on the same post during migration', () => {
    const api = loadLedger();
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 0, outLike: 1, inReply: 0, inLike: 0, inRepost: 0, lastAt: 100 } },
      seen: { 'ol:5': { h: 'alice', d: 'out', k: 'like', at: 100 } },
    }, false);
    api.recordReciprocity('alice', 'out', 'reply', '5', 200);
    const entry = api.ledger.get('alice');
    expect(entry.outLike).toBe(1);
    expect(entry.outReply).toBe(1);
    expect(entry.outPosts).toBe(1);
    api.flushReciprocity();
  });

  it('moves an old reply onto its real post when the reply is fetched again', () => {
    const api = loadLedger();
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 1, outLike: 0, inReply: 0, inLike: 0, inRepost: 0, lastAt: 100 } },
      seen: { 'or:reply-1': { h: 'alice', d: 'out', k: 'reply', at: 100 } },
    }, false);
    expect(api.ledger.get('alice').outPosts).toBe(1);
    expect(api.posts.has('out|alice|legacy:or:reply-1')).toBe(true);
    // The same reply arrives in a timeline payload, now with its parent id.
    api.observeReciprocityFromPayload({
      id: 'reply-1',
      screenName: 'me',
      inReplyToScreenName: 'alice',
      inReplyToStatusId: 'alice-post-1',
    });
    const entry = api.ledger.get('alice');
    expect(entry.outPosts).toBe(1);
    expect(entry.outReply).toBe(1);
    expect(api.posts.has('out|alice|legacy:or:reply-1')).toBe(false);
    expect(api.posts.has('out|alice|alice-post-1')).toBe(true);
    // A like on the parent now lands on the same record.
    api.recordReciprocity('alice', 'out', 'like', 'alice-post-1', 200);
    expect(entry.outLike).toBe(1);
    expect(entry.outPosts).toBe(1);
    api.flushReciprocity();
  });

  it('merges an old reply into a post that was already counted under its real id', () => {
    const api = loadLedger();
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 1, outLike: 0, inReply: 0, inLike: 0, inRepost: 0, lastAt: 100 } },
      seen: { 'or:reply-1': { h: 'alice', d: 'out', k: 'reply', at: 100 } },
    }, false);
    // A like on the same parent is seen before the old reply is fetched again.
    api.recordReciprocity('alice', 'out', 'like', 'alice-post-1', 150);
    expect(api.ledger.get('alice').outPosts).toBe(2);
    api.observeReciprocityFromPayload({
      id: 'reply-1',
      screenName: 'me',
      inReplyToScreenName: 'alice',
      inReplyToStatusId: 'alice-post-1',
    });
    const entry = api.ledger.get('alice');
    expect(entry.outPosts).toBe(1);
    expect(entry.outReply).toBe(1);
    expect(entry.outLike).toBe(1);
    expect(api.posts.get('out|alice|alice-post-1').k).toEqual({ l: 1, r: 1 });
    api.flushReciprocity();
  });

  it('moves an old inbound reply onto my real post when it is fetched again', () => {
    const api = loadLedger();
    api.tweetDataStore.set('my-root', { id: 'my-root', screenName: 'me', conversationId: 'my-root' });
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 0, outLike: 0, inReply: 1, inLike: 0, inRepost: 0, lastAt: 100 } },
      seen: { 'ir:r2': { h: 'alice', d: 'in', k: 'reply', at: 100 } },
    }, false);
    expect(api.ledger.get('alice').inPosts).toBe(1);
    api.observeReciprocityFromPayload({
      id: 'r2',
      screenName: 'alice',
      inReplyToScreenName: 'me',
      inReplyToStatusId: 'my-root',
      conversationId: 'my-root',
    });
    const entry = api.ledger.get('alice');
    expect(entry.inPosts).toBe(1);
    expect(entry.inReply).toBe(1);
    expect(api.posts.has('in|alice|legacy:ir:r2')).toBe(false);
    expect(api.posts.has('in|alice|my-root')).toBe(true);
    // A like notification on my post merges with the migrated reply.
    api.recordReciprocity('alice', 'in', 'like', 'my-root', 200);
    expect(entry.inLike).toBe(1);
    expect(entry.inPosts).toBe(1);
    api.flushReciprocity();
  });

  it('keeps the legacy reply mapping across a save and reload', () => {
    const api = loadLedger();
    const seenAt = Date.now();
    api.hydrateReciprocity({
      ledger: { alice: { outReply: 1, outLike: 0, inReply: 0, inLike: 0, inRepost: 0, lastAt: 100 } },
      seen: { 'or:reply-1': { h: 'alice', d: 'out', k: 'reply', at: seenAt } },
    }, false);
    api.flushReciprocity();
    const save = api.sent.find((m) => m.type === 'XVM_RECIPROCITY_SAVE');
    // The bridge drops the old seen map; the event key has to survive on the
    // synthetic record or the next page load would count the reply again.
    expect(save.reciprocity.posts['out|alice|legacy:or:reply-1'].e).toBe('or:reply-1');
    const next = loadLedger();
    next.hydrateReciprocity(save.reciprocity, false);
    next.observeReciprocityFromPayload({
      id: 'reply-1',
      screenName: 'me',
      inReplyToScreenName: 'alice',
      inReplyToStatusId: 'alice-post-1',
    });
    const entry = next.ledger.get('alice');
    expect(entry.outPosts).toBe(1);
    expect(entry.outReply).toBe(1);
    expect(next.posts.has('out|alice|alice-post-1')).toBe(true);
    next.flushReciprocity();
  });

  it('keeps a post counted after an unlike when I also replied to it', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'out', 'reply', '5', 100);
    api.recordReciprocity('alice', 'out', 'like', '5', 200);
    expect(api.ledger.get('alice').outPosts).toBe(1);
    api.removeReciprocityEvent('alice', 'out', 'like', '5');
    const entry = api.ledger.get('alice');
    expect(entry.outLike).toBe(0);
    expect(entry.outReply).toBe(1);
    expect(entry.outPosts).toBe(1);
    api.flushReciprocity();
  });

  it('withdraws a like on unlike, and forgets the handle when it hits zero', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'out', 'like', '5', 100);
    expect(api.ledger.get('alice').outPosts).toBe(1);
    api.removeReciprocityEvent('alice', 'out', 'like', '5');
    expect(api.ledger.get('alice')).toBeUndefined();
    expect(api.posts.size).toBe(0);
    api.flushReciprocity();
  });

  it('backfills my likes while I am on my own Likes tab', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.setPath('/me/likes');
    api.observeReciprocityFromPayload({ id: 'post-9', screenName: 'alice', inReplyToScreenName: '' });
    expect(api.ledger.get('alice').outLike).toBe(1);
    expect(api.ledger.get('alice').outPosts).toBe(1);
    api.flushReciprocity();
  });

  it('clearing wipes the ledger and stops a pending save from restoring it', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'in', 'like', '9', 100);
    api.hydrateReciprocity(null, true);
    expect(api.ledger.size).toBe(0);
    expect(api.posts.size).toBe(0);
    api.flushReciprocity();
    expect(api.sent.filter((m) => m.type === 'XVM_RECIPROCITY_SAVE')).toHaveLength(0);
  });

  it('saves per-post counters and the post records together', () => {
    const api = loadLedger();
    api.hydrateReciprocity(null, false);
    api.recordReciprocity('alice', 'in', 'repost', '9', 100);
    api.flushReciprocity();
    const save = api.sent.find((m) => m.type === 'XVM_RECIPROCITY_SAVE');
    expect(save.reciprocity.ledger.alice.inRepost).toBe(1);
    expect(save.reciprocity.ledger.alice.inPosts).toBe(1);
    expect(save.reciprocity.posts['in|alice|9']).toMatchObject({
      h: 'alice', d: 'in', p: '9', k: { t: 1 },
    });
    expect(Number.isFinite(save.reciprocity.posts['in|alice|9'].at)).toBe(true);
    expect(save.reciprocity.version).toBe(2);
    expect(Number.isFinite(save.reciprocity.savedAt)).toBe(true);
  });
});

describe('give-and-take capture', () => {
  it('records my replies against the parent post and their replies against mine', () => {
    expect(contentJs).toContain("recordReciprocity(target, 'out', 'reply', data.inReplyToStatusId || data.id, at, `or:${data.id}`)");
    expect(contentJs).toContain("recordReciprocity(author, 'in', 'reply', myRootId, at, `ir:${data.id}`)");
  });

  it('records likes on click and withdraws them on unlike', () => {
    expect(contentJs).toContain('button[data-testid="like"], button[data-testid="unlike"]');
    expect(contentJs).toContain("recordReciprocity(author, 'out', 'like', id, Date.now())");
    expect(contentJs).toContain("removeReciprocityEvent(author, 'out', 'like', id)");
  });

  it('backfills likes from the account owner’s Likes tab', () => {
    expect(contentJs).toContain('function isOwnLikesPage(me = getLoggedInHandle())');
    expect(contentJs).toContain("recordReciprocity(author, 'out', 'like', data.id, at)");
  });

  it('records likes and reposts from notifications against the acted-on post', () => {
    expect(contentJs).toContain('function notificationStatusId(cell, me)');
    expect(contentJs).toContain("recordReciprocity(actor, 'in', kind, postId, at)");
    // Mentions inside the liked post must not become actors.
    expect(contentJs).toContain('cell.querySelectorAll(\'a[href^="/"] img\')');
  });

  it('never attributes a notification reply to me', () => {
    // A notification row can be "X replied to their own post". Inbound replies
    // must come from the payload's in_reply_to_screen_name, or from the reply
    // list under my own status — never from the notification actor.
    expect(contentJs).toContain("if (kind !== 'reply') recordInteraction(actor, kind, at);");
    expect(contentJs).toContain("const postId = kind === 'like' || kind === 'repost' ? notificationStatusId(cell, me) : '';");
    expect(contentJs).toContain('const myRootId = target === me ? ownReplyRootId(data) : \'\';');
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

  it('dedupes by post and queues observations until the store loads', () => {
    expect(contentJs).toContain('const mapKey = reciprocityMapKey(dir, handle, postKey);');
    expect(contentJs).toContain('if (post && post.k && post.k[flag]) {');
    expect(contentJs).toContain('if (!reciprocityHydrated) {');
    expect(contentJs).toContain('reciprocityPending.push');
    expect(contentJs).toContain('for (const [handle, dir, kind, key, at, eventKey] of pending) {');
  });

  it('caps the stored ledger and forwards a popup clear to open tabs', () => {
    expect(bridgeJs).toContain("type === 'XVM_RECIPROCITY_SAVE'");
    expect(bridgeJs).toContain('xvmReciprocity');
    expect(bridgeJs).toContain('RECIPROCITY_MAX_POSTS');
    expect(bridgeJs).toContain('raw.posts');
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

  it('counts posts, not actions, in the headline', () => {
    expect(contentJs).toContain("const outPosts = entry?.outPosts == null");
    expect(contentJs).toContain('mine: outPosts');
    expect(contentJs).toContain('theirs: inPosts');
  });

  it('leaves the corner to 未关注 and skips self / promoted / quoted posts', () => {
    expect(contentJs).toContain('relationForComment(article)?.following === false');
    expect(contentJs).toContain('handle === me');
    expect(contentJs).toContain('isPromotedArticle(article)');
    expect(contentJs).toContain('article.parentElement?.closest?.(\'article[data-testid="tweet"]\')');
    expect(contentJs).toContain('function removeReciprocityMark');
  });

  it('only paints on the home timeline and clears the chip when navigating away', () => {
    expect(contentJs).toContain("const onHome = scopeFromPath() === 'home';");
    expect(contentJs).toContain('!reciprocityInlineEnabled || !reciprocityHydrated || !onHome');
    expect(contentJs).toContain('if (!reciprocityInlineEnabled || !onHome) clearReciprocityMarks(root);');
    // The SPA navigation hook must repaint, not wait for the 2s tick.
    expect(contentJs).toContain('clearLink();\n    // Drop chips when leaving home;');
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

  it('counts one post once per direction', () => {
    expect(popupScript).toContain("const outPosts = entry?.outPosts == null ? outReply + outLike : count(entry, 'outPosts');");
    expect(popupScript).toContain("const inPosts = entry?.inPosts == null ? inReply + inLike + inRepost : count(entry, 'inPosts');");
    expect(popupScript).toContain('mine: outPosts');
    expect(popupScript).toContain('theirs: inPosts');
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
