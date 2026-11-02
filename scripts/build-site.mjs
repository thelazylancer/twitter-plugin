#!/usr/bin/env node
// 官网预渲染：site/index.html（源模板，三语文案在页内 siteI18n）→ docs/ 下每种语言一个静态页。
//   /      英文（x-default）   /zh/  中文   /ja/  日文
// 静态 HTML 里就是对应语言的正文和 TDK，搜索引擎不用执行 JS 也能读到；页内 JS 仍会按路径再套一次，结果相同。
// 顺带生成 sitemap.xml（带 hreflang）和 robots.txt。改完 site/ 必须跑 `npm run build:site` 再提交 docs/。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://xvm.icy-cat.com';
const LANGS = { en: { path: '/', hreflang: 'en' }, zh: { path: '/zh/', hreflang: 'zh-CN' }, ja: { path: '/ja/', hreflang: 'ja' } };
const version = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8')).version;
const template = pathToFileURL(resolve(ROOT, 'site/index.html')).href;
copyFileSync(resolve(ROOT, 'icons/icon128.png'), resolve(ROOT, 'docs/favicon.png'));

for (const asset of ['icycat-uiux.css', 'site.css']) {
  copyFileSync(resolve(ROOT, 'site', asset), resolve(ROOT, 'docs', asset));
}

const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const page = await browser.newPage();
await page.route('https://**/*', route => route.abort());
for (const [lang, { path }] of Object.entries(LANGS)) {
  await page.goto(`${template}?prerender=${lang}`);
  const html = await page.evaluate(({ lang, LANGS, ORIGIN, version }) => {
    const head = document.head;
    head.querySelectorAll('link[rel="alternate"][hreflang]').forEach((l) => l.remove());
    const canonical = head.querySelector('link[rel="canonical"]');
    canonical.href = ORIGIN + LANGS[lang].path;
    for (const [k, v] of [...Object.entries(LANGS), ['x-default', LANGS.en]]) {
      const l = document.createElement('link');
      l.rel = 'alternate';
      l.hreflang = k === 'x-default' ? 'x-default' : v.hreflang;
      l.href = ORIGIN + v.path;
      canonical.after(l);
    }
    const ld = head.querySelector('script[type="application/ld+json"]');
    const data = JSON.parse(ld.textContent);
    data.softwareVersion = version;
    data.url = ORIGIN + LANGS[lang].path;
    data.inLanguage = LANGS[lang].hreflang;
    ld.textContent = JSON.stringify(data, null, 2);
    return '<!doctype html>\n' + document.documentElement.outerHTML + '\n';
  }, { lang, LANGS, ORIGIN, version });
  const out = resolve(ROOT, 'docs', `.${path}`, 'index.html');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`wrote docs${path}index.html`);
}
const guideTitles = await page.evaluate(() => Object.fromEntries(Object.entries(siteI18n).map(([lang, t]) => [lang, t.guideTitles])));
const guideNames = ['x-views-per-hour.html', 'find-viral-tweets.html', 'x-analytics-without-premium.html', 'ai-twitter-reply-generator.html', 'best-twitter-chrome-extensions.html', 'convert-tweet-to-markdown.html'];
const extra = readdirSync(resolve(ROOT, 'site/guides/en')).filter(f => f.endsWith('.html'));
const labels = {
  en: { install: 'Install', home: 'Fork home', related: 'Related:', cta: 'Install this fork', chrome: 'Get the extension', edge: 'Install steps', product: 'Product homepage', disclaimer: 'A fork of X Viral Monitor by IcyCat. Not affiliated with X Corp.', locale: 'en_US', ctaText: 'This fork has no store release: load the repository as an unpacked extension, or build dist/ with npm run build:community. Pro gates are open by default; the bundled userscript covers badges and the leaderboard only.' },
  zh: { install: '安装', home: 'fork 首页', related: '相关指南：', cta: '安装这个 fork', chrome: '从 GitHub 安装', edge: '安装说明', product: '产品首页', disclaimer: '基于 IcyCat 的 X Viral Monitor 修改，与 X Corp. 无关联。', locale: 'zh_CN', ctaText: '这个 fork 不发布商店版本：在开发者模式里加载仓库，或构建 dist/。Pro 闸门默认打开；同包的油猴脚本只覆盖徽章和排行榜。' },
  ja: { install: 'インストール', home: 'fork ホーム', related: '関連ガイド：', cta: 'この fork をインストール', chrome: 'GitHub からインストール', edge: 'インストール手順', product: '製品ホーム', disclaimer: 'IcyCat の X Viral Monitor を基にした fork です。X Corp. とは関係ありません。', locale: 'ja_JP', ctaText: 'この fork はストア版を配布していません。開発者モードでリポジトリを読み込むか、dist/ をビルドします。Pro 機能は既定で有効で、同梱の userscript はバッジとランキングのみです。' },
};
for (const file of extra) {
  const source = readFileSync(resolve(ROOT, 'site/guides/en', file), 'utf8');
  for (const [lang, { path }] of Object.entries(LANGS)) {
    const fragment = lang === 'en' ? null : readFileSync(resolve(ROOT, 'site/guides', lang, file), 'utf8');
    await page.setContent(source, { waitUntil: 'domcontentloaded' });
    const html = await page.evaluate(({ lang, path, file, fragment, LANGS, ORIGIN, labels, guideTitles, guideNames }) => {
      const t = labels[lang];
      const article = document.querySelector('article');
      const cta = article.querySelector('.cta').cloneNode(true);
      const related = article.querySelector('.related').cloneNode(true);
      if (fragment) {
        const template = document.createElement('template');
        template.innerHTML = fragment;
        const translated = template.content.querySelector('article');
        article.innerHTML = translated.innerHTML;
        article.append(cta, related);
        document.title = article.querySelector('h1').textContent + ' - X Viral Monitor';
        document.querySelector('meta[name="description"]').content = translated.dataset.description;
      }
      document.documentElement.lang = LANGS[lang].hreflang;
      const url = ORIGIN + path + file;
      const description = document.querySelector('meta[name="description"]').content;
      document.querySelector('link[rel="canonical"]').href = url;
      document.querySelector('link[href*="/site.css"]').setAttribute('href', '/site.css?v=20261003');
      for (const platform of ['og', 'twitter']) {
        for (const [key, value] of Object.entries({ title: document.title, description })) {
          document.querySelector(`meta[${platform === 'og' ? 'property' : 'name'}="${platform}:${key}"]`).content = value;
        }
      }
      document.querySelector('meta[property="og:url"]').content = url;
      document.querySelector('meta[property="og:locale"]').content = t.locale;
      document.querySelectorAll('link[hreflang]').forEach(link => link.remove());
      for (const [key, target] of [...Object.entries(LANGS), ['x-default', LANGS.en]]) {
        const alternate = document.createElement('link');
        alternate.rel = 'alternate';
        alternate.hreflang = key === 'x-default' ? key : target.hreflang;
        alternate.href = ORIGIN + target.path + file;
        document.head.append(alternate);
      }
      const nav = document.querySelector('.nav .wrap');
      const actions = document.createElement('div');
      actions.className = 'nav-actions';
      const install = nav.querySelector('.nav-cta');
      install.textContent = t.install;
      actions.append(install);
      const switcher = document.createElement('nav');
      switcher.className = 'lang-switch';
      switcher.setAttribute('aria-label', 'Language');
      for (const [key, text] of [['zh', '中'], ['en', 'EN'], ['ja', '日']]) {
        const link = document.createElement('a');
        link.href = LANGS[key].path + file;
        link.hreflang = LANGS[key].hreflang;
        link.lang = LANGS[key].hreflang;
        link.textContent = text;
        if (key === lang) link.setAttribute('aria-current', 'page');
        switcher.append(link);
      }
      actions.append(switcher);
      nav.append(actions);
      article.querySelector('.cta h2').textContent = t.cta;
      if (t.ctaText) article.querySelector('.cta p').textContent = t.ctaText;
      article.querySelectorAll('.cta .btn').forEach((link, i) => { link.textContent = [t.chrome, t.edge, t.product][i]; });
      article.querySelector('.related').firstChild.textContent = t.related + ' ';
      document.querySelector('footer .wrap > div:last-child').textContent = t.disclaimer;
      document.querySelectorAll('.related a, footer .foot-links a').forEach(link => {
        const file = link.getAttribute('href').split('/').pop();
        const i = guideNames.indexOf(file);
        if (i >= 0) link.textContent = guideTitles[lang][i];
        else if (link.getAttribute('href') === '/') link.textContent = t.home;
      });
      document.querySelectorAll('a[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (link.closest('.lang-switch') || !href.startsWith('/')) return;
        if (href === '/') link.href = path;
        else if (guideNames.includes(href.slice(1))) link.href = path + href.slice(1);
      });
      const ld = document.querySelector('script[type="application/ld+json"]');
      const data = JSON.parse(ld.textContent);
      const work = data['@graph'].find(item => item['@type'] === 'Article');
      Object.assign(work, { headline: article.querySelector('h1').textContent, description, url, mainEntityOfPage: url, inLanguage: LANGS[lang].hreflang, dateModified: '2026-10-03' });
      data['@graph'] = data['@graph'].filter(item => item['@type'] !== 'FAQPage');
      const questions = [...article.querySelectorAll('h3')].map(heading => ({ '@type': 'Question', name: heading.textContent, acceptedAnswer: { '@type': 'Answer', text: heading.nextElementSibling.textContent } }));
      if (questions.length) data['@graph'].push({ '@type': 'FAQPage', mainEntity: questions });
      ld.textContent = JSON.stringify(data, null, 2);
      return '<!doctype html>\n' + document.documentElement.outerHTML + '\n';
    }, { lang, path, file, fragment, LANGS, ORIGIN, labels, guideTitles, guideNames });
    writeFileSync(resolve(ROOT, 'docs', '.' + path, file), html);
    console.log(`wrote docs${path}${file}`);
  }
}
await browser.close();

const urls = ['index.html', ...extra].flatMap(file => {
  const suffix = file === 'index.html' ? '' : file;
  const alt = [...Object.values(LANGS), { path: '/', hreflang: 'x-default' }].map(v => `    <xhtml:link rel="alternate" hreflang="${v.hreflang}" href="${ORIGIN}${v.path}${suffix}"/>`).join('\n');
  return Object.values(LANGS).map(v => `  <url>\n    <loc>${ORIGIN}${v.path}${suffix}</loc>\n${alt}\n  </url>`);
});
writeFileSync(resolve(ROOT, 'docs/sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
writeFileSync(resolve(ROOT, 'docs/robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
console.log(`wrote docs/sitemap.xml (${urls.length} urls), docs/robots.txt`);
