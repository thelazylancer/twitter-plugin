import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.route(url => url.hostname !== 'xvm.icy-cat.com', route => route.abort());
  await page.route('https://xvm.icy-cat.com/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path.endsWith('/') ? `${path}index.html` : path;
    const contentType = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    await route.fulfill({ body: readFileSync(resolve(root, `docs${file}`)), contentType });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [path, lang] of [['/', 'en'], ['/zh/', 'zh-CN'], ['/ja/', 'ja']]) {
        await page.goto(`https://xvm.icy-cat.com${path}`);
        const state = await page.evaluate(() => ({
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          lang: document.documentElement.lang,
          background: getComputedStyle(document.body).backgroundColor,
          primary: getComputedStyle(document.querySelector('.hero .primary')).backgroundColor,
          links: [...document.querySelectorAll('.btn')].map(a => a.getAttribute('href')),
          installLinks: [...document.querySelectorAll('a[href^="https://github.com/thelazylancer/twitter-plugin"]')].map(a => a.textContent),
          storeLinks: [...document.querySelectorAll('a[href*="chromewebstore.google.com"], a[href*="microsoftedge.microsoft.com"]')],
        }));
        assert.equal(state.width, width);
        assert.equal(state.scrollWidth, width, `${path} overflows at ${width}px`);
        assert.equal(state.lang, lang);
        assert.equal(state.background, colorScheme === 'light' ? 'rgb(242, 242, 247)' : 'rgb(28, 28, 30)');
        assert.equal(state.primary, colorScheme === 'light' ? 'rgb(0, 104, 217)' : 'rgb(77, 163, 255)');
        assert(state.links.every(Boolean));
        const guideLinks = await page.locator('.foot-guides a').evaluateAll(links => links.map(link => link.getAttribute('href')));
        assert.equal(guideLinks.length, 6);
        assert(guideLinks.every(href => href.startsWith(path) && existsSync(resolve(root, 'docs' + href))));
        assert(state.installLinks.length >= 2);
        assert.deepEqual(state.storeLinks, []);
        if (width !== 768) await page.screenshot({ path: `/tmp/xvm-checked-${lang}-${width}-${colorScheme}.png`, fullPage: true });
        console.log(`PASS ${path} ${width}px ${colorScheme}`);
      }
    }
  }
  await page.goto('https://xvm.icy-cat.com/');
  await page.locator('.lang-switch button[data-lang="zh"]').click();
  await page.waitForURL('https://xvm.icy-cat.com/zh/');
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  for (const guide of ['x-views-per-hour', 'find-viral-tweets', 'x-analytics-without-premium', 'ai-twitter-reply-generator', 'best-twitter-chrome-extensions', 'convert-tweet-to-markdown']) {
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const source = readFileSync(resolve(root, 'site/guides/en', guide + '.html'), 'utf8');
      for (const [prefix, lang] of [['/', 'en'], ['/zh/', 'zh-CN'], ['/ja/', 'ja']]) {
        const url = `https://xvm.icy-cat.com${prefix}${guide}.html`;
        await page.goto(url);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${url} overflows`);
        assert.equal(await page.locator('html').getAttribute('lang'), lang);
        assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), url);
        assert.equal(await page.locator('meta[property="og:url"]').getAttribute('content'), url);
        assert.equal(await page.locator('link[rel="alternate"][hreflang]').count(), 4);
        assert.equal(await page.locator('.lang-switch a').count(), 3);
        assert.equal(await page.locator('.lang-switch a[aria-current="page"]').getAttribute('href'), prefix + guide + '.html');
        assert.equal(await page.locator('article h2').count(), (source.match(/<h2>/g) || []).length);
        assert.equal(await page.locator('article h3').count(), (source.match(/<h3>/g) || []).length);
        const content = await page.locator('article').textContent();
        if (lang === 'zh-CN') assert.match(content, /常见问题|如何搭配/);
        if (lang === 'ja') assert.match(content, /よくある質問|どう組み合わせるか/);
        const data = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
        assert.equal(data['@graph'][0].inLanguage, lang);
        assert.equal(data['@graph'][0].mainEntityOfPage, url);
        assert.equal(data['@graph'][0].headline, await page.locator('h1').textContent());
        const localLinks = await page.locator('a[href^="/"]:not(.lang-switch a)').evaluateAll(links => links.map(a => a.getAttribute('href')));
        assert(localLinks.every(href => href.startsWith(prefix) && existsSync(resolve(root, 'docs' + (href.endsWith('/') ? href + 'index.html' : href)))));
        console.log(`PASS ${prefix}${guide}.html ${width}px`);
      }
    }
    await page.goto(`https://xvm.icy-cat.com/${guide}.html`);
    await page.locator('.lang-switch a[hreflang="zh-CN"]').click();
    await page.waitForURL(`https://xvm.icy-cat.com/zh/${guide}.html`);
    await page.locator('.lang-switch a[hreflang="ja"]').click();
    await page.waitForURL(`https://xvm.icy-cat.com/ja/${guide}.html`);
    await page.locator('.lang-switch a[hreflang="en"]').click();
    await page.waitForURL(`https://xvm.icy-cat.com/${guide}.html`);
  }
  const sitemap = readFileSync(resolve(root, 'docs/sitemap.xml'), 'utf8');
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.equal(new Set(urls).size, 21);
  assert(urls.every(url => existsSync(resolve(root, 'docs' + (new URL(url).pathname.endsWith('/') ? new URL(url).pathname + 'index.html' : new URL(url).pathname)))));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
