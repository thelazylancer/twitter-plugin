# 蓝V特工

基于 [Icy-Cat/x-viral-monitor](https://github.com/Icy-Cat/x-viral-monitor)（MIT）改成的回复插件。打开别人的帖子，点 **快回** 生成评论。打开自己的帖子，每条评论旁有 **回评**。它会先读主贴和这条评论，再按主贴的立场回复这条评论。点一条填入，不会自动发送。

流速徽章、排行榜、星图、Markdown 复制和广告裁剪默认关闭。弹窗打开就是「AI 评论」。默认走 OpenAI 兼容接口（DeepSeek / OpenRouter / 自建中转都行），也可以换成不需要 Key 的本机 Ollama。

这是个人 fork，**没有 Chrome Web Store / Edge 商店版本**；上游商店里叫「X Viral Monitor」的扩展是另一个项目，不要从那里安装。本仓库默认走 community-dev 通道，Pro 闸门全部打开，没有试用倒计时，也不需要 License。流速过滤默认仍是关的，要在弹窗「过滤」里自己打开。

加载：Chrome 打开 `chrome://extensions/`，打开开发者模式，加载已解压的扩展程序，选这个仓库根目录。改完代码后在扩展页点重新加载，再刷新 x.com。

---

# X Viral Monitor

[English](README.en.md)

在 X (Twitter) 时间线上实时显示每条推文的**浏览量流速**，并附带一整套阅读 / 创作辅助工具。

[![Chrome Extension](https://img.shields.io/badge/Chrome-自行构建-blue?logo=googlechrome)](#安装)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)](manifest.json)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-精简版-orange?logo=tampermonkey)](userscript/x-viral-monitor.user.js)
[![iOS Userscripts](https://img.shields.io/badge/iOS_Safari-Userscripts-lightgrey?logo=safari)](userscript/x-viral-monitor.mobile.user.js)

> 主体是 Chrome / Edge 扩展；`userscript/` 里附带上游的精简油猴脚本，只有徽章和排行榜，可以在 Tampermonkey、iOS Safari 的 Userscripts App 或安卓 Quetta 里用，详见[安装](#安装)章节。

---

## 功能总览

| 功能 | 触发位置 | 说明 |
|---|---|---|
| 流速徽章 | 时间线每条推文 | 每小时浏览量（impression/h），胶囊或行内两种样式 |
| 流速排行榜 | 浮动面板（可拖拽） | 当前页面可见推文按流速排序，列可自定义 |
| 书签数显示 | 推文操作栏 | 时间线上书签按钮旁直接显示数字 |
| 图片查看增强 | X 原生灯箱 | 触控板捏合 / Ctrl+滚轮缩放、双指 / 拖拽平移、双击切换；长图（h/w > 3）自动切到固定宽度纵向滚动 |
| 内容过滤 | 推文回复区 | 多级规则过滤 spam/色情/电报漏斗，**规则远程拉取**自动更新 |
| 流速过滤 | 时间线 | 按 views/min 阈值隐藏低流速推文，文章和短推文独立阈值 |
| AI 评论候选 | 回复框 ✦ 按钮 | OpenAI 兼容接口 / 本机 Ollama，一套多语言提示词模板列表 |
| Markdown 复制 | 分享菜单 | 把推文复制成 Markdown 格式 |
| 感谢星图 | 分享菜单 | 把转推/引用用户做成动画粒子可视化 |
| 互惠榜 | Popup → 标记 → 互惠排行；首页帖子右上角 | 对比「我给对方的回复/点赞」和「对方给我的回复/点赞/转推」，按投入差排序，可筛出单向互动；同一帖子、同一方向只算 1 次（回复 + 点赞仍算 1）；有记录的人的首页帖子右上角也会直接显示 `我 N : 对方 N` 小标；对方给你的回复只算你帖子下的；只统计本机浏览时看到的事件 |

---

## 版本说明

这是从上游 X Viral Monitor 分出来的个人版本，不发布商店版本，也不销售 Pro License。仓库里保留 Pro 闸门和 store 构建通道，只是为了跟上游保持结构一致；日常使用的 community-dev 构建会把闸门全部打开。

本仓库包含完整源码（MIT），可以自行审计、修改和构建。商店里那个「X Viral Monitor」是上游项目，和这个 fork 无关。

### 上游的免费 / Pro 边界

下表说明上游把哪些能力放在 Pro 后面；在本 fork 的 community-dev 构建里，这些能力都直接可用。

| 上游免费功能 | 上游 Pro / 试用能力 |
|---|---|
| 流速徽章、流速排行榜、书签数显示 | 流速过滤：按 views/min 和总浏览量隐藏低流速推文 |
| 图片查看增强、长图阅读 | 短推文 / 长文独立阈值 |
| 内容过滤、远程规则更新、自定义规则 | Home / Lists / Profile / Tweet detail 分范围启用 |
| AI 评论候选、Markdown 复制、感谢星图 | 后续高级监控、通知和自动化能力 |

---

## 流速分级

| 图标 | 颜色 | 流速 | 含义 |
|------|------|------|------|
| 🌱 | 绿色 | < 1,000/h | 正常 |
| 🚀 | 橙色 | 1,000 - 10,000/h | 有热度 |
| 🔥 | 红色 | ≥ 10,000/h | 爆帖 |

### 爆帖指数（悬浮卡内）

综合评分 0-100，基于四个加权维度：

| 维度 | 权重 | 满分条件 |
|------|------|----------|
| 流速 | 40% | 50,000/h |
| 互动率 | 25% | 10% |
| 转发比 | 20% | 转发/点赞 = 50% |
| 收藏比 | 15% | 收藏/点赞 = 30% |

---

## AI 评论生成

在任意推文回复框右下会出现 **✦ AI 生成** 按钮，点击：

1. 弹出提示词模板选择：一套多语言模板列表（中文 6 条 / 英文、日文各 5 条），模板以胶囊展示，点击切换、`×` 删除、`+` 新增，编辑自动保存；短推文与长文共用这一套，不再按字数自动切换模板组
2. 候选评论流式渲染（第一条出来就能选，不用等全部生成完）
3. 点中一条 → 直接填进 X 的回复编辑器，回复按钮自动激活

生成走扩展弹窗里选定的服务来源：**OpenAI 兼容接口**（可填任意 Base URL：OpenAI / DeepSeek / OpenRouter / 自建中转 / Ollama 都行，需要模型名；远程接口要 API Key）或**本机 Ollama**（不用 Key，但要在本机跑起来并下好模型）。推文文本和回复上下文会发给所选服务。

支持嵌套场景：回复某条推文下的回复时，提示词会自动拼装「原推文 + 被回复内容」两层上下文。长文（X Article）没有独立模板组，其 Markdown 正文通过 `articleMd` 并入推文正文一起送进同一套模板。

模板可在扩展弹窗里编辑——**单一模板列表**（短推文和长文共用一套）。`{推文内容}` 占位符会被替换成源推文文本；模板里没有这个占位符时，源文本自动前置追加。

除了整块的 `{推文内容}`，模板还可以用命名槽位单独摆放每一段上下文：

| 槽位 | 内容 |
|---|---|
| `{作者}` | 对方 `@handle` |
| `{关注状态}` | 你和对方谁关注了谁 |
| `{主贴}` | 回评模式下你自己的主贴正文 |
| `{当前评论}` | 回评模式下被回复的那条评论 |
| `{原推文}` | 快回嵌套场景下被回复推文的原文 |
| `{对该推文的回复}` | 快回嵌套场景下被回复的那条回复 |
| `{数据}` | 浏览量 / 点赞 / 转推 / 回复 / 发布时间 |

槽位在当前场景没有内容时会整段消失，不会留下空标签。槽位名固定用中文（与 `{推文内容}` 一致），英文、日文模板里照写即可。

`{推文内容}` 只包含推文正文（回评模式下是主贴 + 当前评论，快回嵌套时是原推文 + 被回复内容），**不包含**关注状态。想让模型知道你和对方的关系，模板里自己写 `{关注状态}`；不写就没有这层信息。

---

## 内容过滤

针对 X 推文回复区的多级 spam / 色情 / 电报漏斗过滤，**完全本地运行**，不上传任何内容。

- 三档强度：**宽松 / 标准 / 严格**
- 三档严重度：`block` / `high` / `medium` / `low`
- 白名单（关注的人 / handle / 域名）+ 黑名单 handle
- 自定义规则类型：`keyword` / `regex` / `domain` / `short-symbol`
- 被隐藏的回复在主推文下方折叠为「已过滤 N 条 - XVM」面板，可展开查看

### 远程规则自动更新

远程规则来自本仓库 `src/premium/content-filter/rules.json`，扩展会：

1. **冷启动**使用打包内置的 `src/premium/content-filter/rules.js`（由 `bootstrap-rules.json` 生成的最小兜底规则集，永远可用）
2. 后台从 `raw.githubusercontent.com` 拉取最新 `rules.json`（完整规则集，6 小时 TTL，缓存在 `chrome.storage.local`）
3. 拉取成功后**热替换**，无需 reload 扩展
4. 弹窗"过滤"Tab 内显示当前规则来源 + 上次更新时间，可点 **「立即检查更新」** 手动刷新

```
[GitHub raw rules.json]
   ↓ fetch (6h TTL, cached in chrome.storage)
[XVM_CONTENT_FILTER_RULES_UPDATE postMessage]
   ↓
[filter.js 热替换 + 重新分类]
```

发现新 spam 模式? 提 PR 改 `rules.json`，合并到 main 后 6 小时内所有用户自动拿到。

---

## 安装

### Chrome / Edge 扩展（推荐）

本 fork 不发布商店版本，用开发者模式加载：

1. 打开 Chrome 或 Edge，访问 `chrome://extensions/`
2. 右上角打开**开发者模式**
3. 左上角点**加载已解压的扩展程序**
4. 选择这个仓库的根目录（或下一节构建出的 `dist/`）
5. 刷新 x.com

### 先构建再加载

```bash
npm install
npm run build:community   # 同步规则并输出 dist/，Pro 闸门全开
```

构建完成后在扩展页加载 `dist/` 目录。`npm run build:dist` 构建的是 store 渠道（保留 Pro 闸门），仅用于和上游保持一致，这个 fork 不上架。

### 从 Release 安装

推送 `v*` 标签会触发 Release workflow，生成 community-dev 的 zip；解压后按上面的开发者模式步骤加载。

### 油猴脚本 / Tampermonkey（桌面精简版）

这是上游附带的精简脚本，只有徽章和排行榜，不包含 AI 回复、内容过滤等扩展功能：

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 打开 [`userscript/x-viral-monitor.user.js`](userscript/x-viral-monitor.user.js)，点 "Raw" 安装
3. 通过 Tampermonkey 菜单打开设置面板

### 安卓 — Quetta + 油猴脚本

安卓 Chrome 不支持扩展，但 [**Quetta**](https://quetta.net/) 浏览器原生支持 Tampermonkey：

1. Play Store 或官网下载 Quetta App
2. 在 Quetta 内安装 Tampermonkey
3. 安装 [`userscript/x-viral-monitor.mobile.user.js`](userscript/x-viral-monitor.mobile.user.js)（移动版，启用 DOM fallback 兜底）

### iOS Safari — Userscripts App

iOS Safari 用户使用 [**Userscripts**](https://apps.apple.com/app/userscripts/id1463298887)（免费开源 App）：

1. App Store 搜索安装 "Userscripts" by Justin Wasack
2. 在 设置 → Safari → 扩展 中启用 Userscripts
3. 在 Userscripts App 内添加 [`userscript/x-viral-monitor.mobile.user.js`](userscript/x-viral-monitor.mobile.user.js)
4. 打开 x.com，Safari 地址栏左下角的 ⓂA 菜单 → Userscripts → 启用脚本

> 移动版油猴脚本默认不显示浮动排行榜面板（屏幕太小），只保留徽章。

---

## 工作原理

扩展通过 hook X 前端的 `fetch` / `XMLHttpRequest`，拦截 GraphQL API 响应，提取每条推文的指标数据（浏览量、点赞、转发、回复、收藏、发布时间）。计算平均流速（`总浏览量 / 发布至今小时数`），在推文操作按钮旁渲染内联标签。

未被初始拦截捕获的推文，会通过 TweetDetail API 逐条补充获取。

内容过滤工作在同一条 GraphQL 拦截链路上，从 `TweetDetail` / `HomeTimeline` 等响应里抽取每条 reply 的 author + content 字段做本地规则匹配，**不与服务器交互**。

油猴脚本和 iOS 移动版在没法 hook 网络时会启用 DOM fallback，从 article 节点直接抽取可见字段，精度略低但保证有徽章可看。

---

## 致谢

「感谢星图」功能改编自 [London-Chen/Thank-you-star-chart](https://github.com/London-Chen/Thank-you-star-chart)（MIT 协议）——
轨道动画的数学公式、侧边面板的布局、配色方案均移植自该项目。

---

## 来源

上游 [Icy-Cat/x-viral-monitor](https://github.com/Icy-Cat/x-viral-monitor)（MIT），分叉点 `b1b896d`（v1.18.17，2026-10-13）。

同步上游：`git remote add upstream https://github.com/Icy-Cat/x-viral-monitor.git` → `git fetch upstream` → `git merge upstream/main`

---

## 项目结构

```
├── _locales/                  # 国际化（en / zh_CN / ja）
├── icons/                     # 扩展图标
├── lib/                       # 运行时库
│   ├── x-net-hook.js          # fetch/XHR 拦截
│   ├── image-viewer.js        # 增强图片查看器（zoom/pan）
│   └── long-image-viewer.js   # 长图阅读模式
├── src/premium/               # Pro 闸门 + 高级功能
│   ├── license/               # 试用 / 激活 / tier 路由
│   ├── content-filter/        # 内容过滤（免费，远程规则）
│   └── rate-filter/           # 流速过滤（Pro）
├── userscript/                # 油猴脚本（桌面 + 移动 + debug）
├── scripts/                   # 构建/同步脚本
├── tests/                     # vitest 测试
├── bridge.js                  # 扩展 ↔ 页面通信桥
├── content.js                 # 主内容脚本（MAIN world）
├── popup.html / popup.js      # 扩展弹窗设置界面
├── starchart.js               # 感谢星图模块
├── styles.css                 # 注入页面的样式
└── manifest.json              # Chrome 扩展清单
```

---

## 开发

```bash
npm install
npm test                 # vitest run
npm run build:community  # 同步 rules.js / AI 默认值 + 输出 community-dev 构建到 dist/（Pro 闸门全开）
npm run build:dist       # 同上，但用 store 渠道（保留 Pro 闸门），仅用于和上游保持一致
npm run sync:rules       # 从 src/premium/content-filter/bootstrap-rules.json 生成 rules.js（最小冷启动兜底）
npm run sync:ai-defaults # 从 src/ai-defaults.data.json 重新生成 4 个消费者文件里的 AI 默认值
```

AI 默认提示词模板和平台预设只有一份权威数据 `src/ai-defaults.data.json`；`scripts/sync-ai-defaults.mjs` 在构建期把同一份字面量写入 `content.js` / `popup.js` / `bridge.js` / `background.js` 的标记区。要改默认值**只改 JSON** 再跑任意 build 命令（它们都已前置生成器），不要手改这 4 个文件的生成区。

`dist/` 用于 `chrome://extensions/` 的"加载已解压"入口，改完源码运行 `npm run build:community` 后到扩展页面点 🔄 即可。日常开发请用 `build:community`；`build:dist` / `build:store` 是 store 渠道（闸门关闭），仅用于和上游保持结构一致，这个 fork 不上架。`dist/` 与 `release/` 都被 .gitignore，不要提交。

---

## 许可证

MIT. See [LICENSE](LICENSE).
