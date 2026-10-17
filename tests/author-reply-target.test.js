import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../lib/author-reply-target.js', import.meta.url), 'utf8');
const sandbox = { window: {}, globalThis: {} };
vm.runInNewContext(src, sandbox);
const api = sandbox.window.__xvmAuthorReplyTarget;

describe('author reply target', () => {
  it('does not treat a comment that links to the page status as the main post', () => {
    const input = {
      pageStatusId: '100',
      loggedInHandle: 'me',
      cards: [
        {
          statusId: '200',
          handle: 'me',
          hasAnalytics: true,
          linksPageStatus: true,
        },
        {
          statusId: '201',
          handle: 'ada',
          linksPageStatus: true,
        },
      ],
    };
    expect(api.isOwnThread(input)).toBe(false);
    expect(api.authorReplyStatusIds(input)).toEqual([]);
  });

  it('marks only comments under the logged-in user focal post', () => {
    const input = {
      pageStatusId: '100',
      loggedInHandle: 'me',
      cards: [
        { statusId: '100', handle: 'me', hasAnalytics: true },
        { statusId: '200', handle: 'ada' },
        { statusId: '201', handle: 'me', nested: true },
        { statusId: '202', handle: 'ad', promoted: true },
      ],
    };
    expect(api.authorReplyStatusIds(input)).toEqual(['200']);
  });

  it('does not mark comments when the focal post belongs to someone else', () => {
    const input = {
      pageStatusId: '100',
      loggedInHandle: 'me',
      cards: [
        { statusId: '100', handle: 'other' },
        { statusId: '200', handle: 'ada', hasAnalytics: true },
      ],
    };
    expect(api.isOwnThread(input)).toBe(false);
    expect(api.authorReplyStatusIds(input)).toEqual([]);
  });

  it('keeps marking comments after the main post scrolls out of the list', () => {
    const input = {
      pageStatusId: '100',
      loggedInHandle: 'me',
      knownOwnStatusId: '100',
      cards: [
        { statusId: '200', handle: 'ada' },
        { statusId: '201', handle: 'bob' },
      ],
    };
    expect(api.isOwnThread(input)).toBe(true);
    expect(api.authorReplyStatusIds(input)).toEqual(['200', '201']);
  });

  it('fills the composer that appeared after the click, not the main post box', () => {
    const main = { id: 'main', closest: () => null };
    const dialogBox = { id: 'dialog', closest: () => ({ role: 'dialog' }) };
    expect(api.pickNewReplyEditor([main], [main, dialogBox])).toBe(dialogBox);
    expect(api.pickNewReplyEditor([main], [main])).toBeNull();
  });
});
