# 蓝V特工 (X Viral Monitor fork)

[中文完整说明](README.md)

A personal fork of [Icy-Cat/x-viral-monitor](https://github.com/Icy-Cat/x-viral-monitor) (MIT). It keeps the velocity monitor and adds a reply workflow: open someone else's post and **Quick reply** drafts comments for it; open your own post and **Reply** drafts an answer to each comment, using the original post's stance as context. Drafts are inserted into X's editor, never sent automatically.

**This fork has no Chrome Web Store or Edge Add-ons listing.** The store extension named "X Viral Monitor" is the upstream project and runs different code. Install this fork from source.

## What it does

- AI reply drafts in every reply composer — OpenAI-compatible endpoints (DeepSeek, OpenRouter, self-hosted gateways) or a local Ollama model; no API key leaves the machine unless you configure a remote endpoint
- Reply assist on your own posts, with the thread's original post and the comment being answered as context
- Comment hot board — ranks reply sections by how crowded and fresh they are
- Comment filtering, recent repliers, and Following records
- Reciprocity ledger — compares the posts you reply to or like for each person with your posts they reply to, like, or repost, sorted by imbalance; a one-way filter surfaces people who never give back. One post counts once per direction (reply + like on the same post is still 1). A compact `me : them` chip appears at the top-right of home-timeline posts when this browser has a record for the author, and can be turned off from Marks → Reciprocity. Inbound replies count only under your own posts; only interactions seen by this browser are counted
- Velocity badges, velocity leaderboard, bookmark counts, Markdown copy, Thank-You Star Chart
- English / Chinese / Japanese UI

Pro gates (velocity filtering, per-surface thresholds) are open in the default community-dev build; no license is needed. The velocity filter itself is still opt-in from the popup.

## Build and install

```bash
npm install
npm run build:community   # sync rules and write dist/ with every Pro gate open
```

Then open `chrome://extensions/`, turn on **Developer mode**, click **Load unpacked**, and choose either the repository root or the generated `dist/` folder. Reload the extension after code changes and refresh x.com.

`npm run build:dist` produces the store channel with the upstream Pro gates intact. It exists only for parity with upstream; this fork is not listed anywhere.

## Userscripts

`userscript/` carries the upstream lightweight Tampermonkey script. It covers badges and the leaderboard only — no AI reply or filtering features. It can also run under iOS Safari's Userscripts app or Quetta on Android.

## Development

```bash
npm test               # vitest
npm run build:community
npm run sync:rules     # rules.json -> rules.js only
```

## Upstream and license

Forked from [Icy-Cat/x-viral-monitor](https://github.com/Icy-Cat/x-viral-monitor) at `b1b896d` (v1.18.17, 2026-10-13), MIT licensed — see [LICENSE](LICENSE). The Thank-You Star Chart is adapted from [London-Chen/Thank-you-star-chart](https://github.com/London-Chen/Thank-you-star-chart) (MIT).
