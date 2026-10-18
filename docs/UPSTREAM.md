# 上游来源

本仓库是 [Icy-Cat/x-viral-monitor](https://github.com/Icy-Cat/x-viral-monitor)（MIT）的衍生作品，改造为「X 快回」回复插件。

## 基本信息

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/Icy-Cat/x-viral-monitor |
| 上游许可 | MIT |
| 分叉点 | `b1b896de5079d672afc9d829beef01c51a0b970c`（`Release v1.18.17`，2026-10-13） |
| 本地仓库 | https://github.com/thelazylancer/twitter-plugin（私有） |

本地仓库不是 GitHub 意义上的 fork（`isFork: false`），因为 GitHub 不允许把公开仓库 fork 成私有仓库。与上游的关系只由 git 历史记录：分叉点之前的 324 个 commit 与上游完全相同。

## 为什么 fork 徽章不显示

GitHub 的 fork 关系只在点击 Fork 按钮时建立，无法事后补挂。当前仓库是独立创建的私有仓库，因此页面上没有 "forked from" 标记。这不影响 MIT 合规——`LICENSE` 原样保留，README 顶部注明了出处。

## 同步上游

上游地址不随仓库分发（`.git/config` 不纳入版本控制），新机器 clone 后需要重新添加。下面的脚本会自动处理：

```bash
node scripts/sync-upstream.mjs          # 只检查，列出上游有哪些新提交
node scripts/sync-upstream.mjs --merge  # 检查后直接 merge 到当前分支
```

脚本首次运行时会自动执行 `git remote add upstream ...`。

手动操作等价于：

```bash
git remote add upstream https://github.com/Icy-Cat/x-viral-monitor.git
git fetch upstream
git log --oneline main..upstream/main   # 上游有、本地没有
git merge upstream/main
```

## 合并上游时的注意事项

本仓库对上游做了产品级改造，以下路径冲突概率高，合并时需要逐个确认：

- `manifest.json` / `_locales/` —— 产品名、描述已改为「X 快回」
- `background.js` / `lib/grok-reply.js` —— 回复语言检测与提示词已重写
- `content.js` / `bridge.js` —— 快回、回评入口是新增的
- `src/premium/` —— 本仓库走 community-dev 通道，Pro 闸门默认全开

合并后务必跑一遍：

```bash
node ./node_modules/vitest/vitest.mjs run
npm run build:dist
```

`tests/build-dist-sync.test.js` 会校验 `dist/` 与源码是否一致，忘记重建会直接失败。
