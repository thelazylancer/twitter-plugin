---
name: release
description: "Automate the 蓝V特工 / X Viral Monitor fork release: bump the patch version, run tests, build the community-dev zip, and report the artifact. Use this skill whenever the user says /release, 发版, 打包发布, 打包, bump version, 更新版本, or wants to create a release zip / prepare a new version for this fork. This fork ships community-dev builds only via GitHub Releases (no Chrome Web Store / Edge listing, no store upload)."
---

# Release Workflow

Package the **community-dev** build of this personal fork for a GitHub Release.

This fork has **no Chrome Web Store or Edge listing**, sells no License, and defaults to the `community-dev` channel (every Pro gate open). A tag is published through the GitHub Release CI, not an app store.

- **CI release path**: push a `v*` tag → `.github/workflows/release.yml` → `npm ci` → `npm run build:community` (= `sync-rules.mjs` + `build-dist.mjs --channel community-dev`) → `(cd dist && zip -r ../x-viral-monitor-<tag>-community-dev.zip .)` → `softprops/action-gh-release` uploads the zip.
- **Manual package path**: `npm run package:community` runs `scripts/package-zip.mjs --channel community-dev`, which zips everything from `dist/` into `release/`. It is cross-platform and pulls the full file set from `dist/` automatically — there is no hand-maintained file list in this skill.
- `build:dist` / `build:store` are the **store** channel (Pro gates intact) and exist only for structural parity with upstream; this fork is not listed anywhere.

`dist/` and `release/` are both in `.gitignore` — never commit either.

## Hard rules

- 本 fork **不上架 Chrome Web Store / Edge**，不要上传商店；没有商店上传步骤。
- 不要 `git push`；本 skill 不执行任何 commit / push 等外向操作，除非用户明确单独要求。打 tag 与推送标签由用户在确认后**自行**完成。
- 版本号必须三处一致：`manifest.json`、`package.json`、`package-lock.json`（有测试锁定）。bump 时三处一起改。
- 用 Edit 工具改文件；不要改任何 JS 源码、不要新增 `import` / `export`。

## Steps

### 1. Check the working tree

Run `git status --porcelain`. If there are uncommitted changes beyond the version bump you are about to make, **warn the user and stop** — do not fold unrelated work into a release.

### 2. Bump the patch version (Edit only)

Read the current `"version"` from `manifest.json` (e.g. `1.18.18`). Increment the patch (`1.18.18` → `1.18.19`). If the user gave an explicit version (e.g. `/release 2.0.0`), use that instead.

Use **Edit** to update the version in all three files so they stay in sync:

- `manifest.json` → `"version"`
- `package.json` → `"version"`
- `package-lock.json` → top-level `"version"` and `packages[""].version`

**Do not** `git commit`, **do not** `git push`, and do not create a tag here. Leave the bump as uncommitted edits for the user to review.

### 3. Run tests

Use a clean environment (the shell profile's nvm loader prints noise):

```
env -i HOME="$HOME" PATH="$PATH" node ./node_modules/vitest/vitest.mjs run --reporter=dot
```

If anything is red, stop and report — do not package a failing tree.

### 4. Build the community-dev package

Preferred (one command, cross-platform zip):

```
npm run package:community
```

Equivalent manual form:

```
npm run build:community
(cd dist && zip -r ../x-viral-monitor-v<VERSION>-community-dev.zip .)
```

`scripts/package-zip.mjs` reads the whole `dist/` tree, so `background.js`, `bookmark-menu.js`, `popup-dashboard.js`, `popup-reciprocity.js` and the entire `src/` tree are included automatically. Do not maintain a manual file list.

### 5. Report the artifact

Print:

- New version number and the three updated files
- Output path (e.g. `release/x-viral-monitor-v<VERSION>-community-dev.zip`, or the repo-root zip from the manual form)
- File size (e.g. `ls -lh <zip>` / `stat`)

### 6. Hand tagging back to the user

Tell the user that the package is ready and that, **after confirming**, they should create and push a `v<VERSION>` tag themselves to trigger the GitHub Release CI. Example wording:

> 产物已就绪。请确认后自行创建并推送 `v<VERSION>` 标签以触发 GitHub Release；本 skill 到此为止，不会替你打标签或推送。

Do **not** run the tag/push command yourself.

## Notes

- `release/` and `dist/` are gitignored; the zip is never committed.
- To verify a loadable build, load `dist/` via `chrome://extensions/` → Developer mode → Load unpacked.
- `npm run build:dist` / `npm run build:store` produce the **store** channel (Pro gates closed); use them only to keep the tree aligned with upstream, never for a fork release.
