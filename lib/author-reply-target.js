// Decide which cards get an author-reply button.
// The focal card is the one whose own status link matches the page URL.
// A link to that status inside a comment does not make the comment the focal post.
(() => {
  function focalCard(input) {
    const pageStatusId = String(input?.pageStatusId || '');
    if (!pageStatusId) return null;
    return (input.cards || []).find((card) => String(card?.statusId || '') === pageStatusId) || null;
  }

  function isOwnThread(input) {
    const focal = focalCard(input);
    const me = String(input?.loggedInHandle || '').toLowerCase();
    if (!focal || !me) return false;
    const handle = String(focal.handle || '').toLowerCase();
    if (handle) return handle === me;
    return focal.hasAnalytics === true;
  }

  function authorReplyStatusIds(input) {
    if (!isOwnThread(input)) return [];
    const pageStatusId = String(input.pageStatusId || '');
    return (input.cards || [])
      .filter((card) => {
        const statusId = String(card?.statusId || '');
        return statusId
          && statusId !== pageStatusId
          && !card.nested
          && !card.promoted;
      })
      .map((card) => String(card.statusId));
  }

  const api = { focalCard, isOwnThread, authorReplyStatusIds };
  if (typeof window !== 'undefined') window.__xvmAuthorReplyTarget = api;
  if (typeof globalThis !== 'undefined') globalThis.__xvmAuthorReplyTarget = api;
})();
