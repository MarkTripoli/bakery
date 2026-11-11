const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'paper-manifest.json')));
  assert.equal(manifest.screens.length, 22);
  assert.equal(new Set(manifest.screens.map(screen => screen.key)).size, 11);
  const hashes = new Set();
  for (const screen of manifest.screens) {
    const data = fs.readFileSync(path.join(root, screen.image));
    assert.equal(data.readUInt32BE(16), screen.width, screen.image);
    assert.equal(data.readUInt32BE(20), screen.height, screen.image);
    assert.ok(data.length > 5000, screen.image);
    hashes.add(crypto.createHash('sha256').update(data).digest('hex'));
  }
  assert.equal(hashes.size, 22, 'Every Paper export is distinct');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:8799/integration-mocks-v2/index.html');
  await page.waitForFunction(() => window.bakeryIntegrationV2Ready === true);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Geist' && font.status === 'loaded')));
  let layouts = 0;
  for (const width of [320, 390, 744, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (let i = 0; i < 11; i++) {
      await page.locator('#screen').selectOption(String(i));
      await page.locator(width < 744 ? '#phone' : '#desktop').click();
      await page.locator('#artboard').evaluate(image => image.decode());
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${i} overflow`);
      assert.ok((await page.locator('#artboard').getAttribute('alt')).length > 35);
      for (const control of await page.locator('button, select').all()) {
        assert.ok((await control.evaluate(element => element.getBoundingClientRect().height)) >= 44, `${width}/${i} touch target`);
      }
      layouts++;
    }
  }
  await page.goto('http://127.0.0.1:8799/integration-mocks-v2/index.html#github-provider');
  await page.waitForFunction(() => window.bakeryIntegrationV2Ready === true);
  assert.equal(await page.locator('#route').innerText(), '/integrations/github');
  await page.locator('#screen').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'phone');
  assert.equal(await page.locator('#phone').evaluate(element => getComputedStyle(element).outlineStyle), 'solid');
  assert.ok(await page.locator('html').getAttribute('lang'));
  assert.ok((await page.locator('label').innerText()).includes('Route'));
  assert.ok((await page.locator('#description').evaluate(element => element.getBoundingClientRect().width)) < 700);
  for (const link of await page.locator('a[target="_blank"]').all()) {
    assert.equal(await link.getAttribute('rel'), 'noopener');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:8799/integration-mocks-v2/index.html#home');
  await page.waitForFunction(() => window.bakeryIntegrationV2Ready === true);
  await page.locator('#artboard').evaluate(image => image.decode());
  await page.screenshot({ path: path.join(root, 'gallery-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#phone').click();
  await page.locator('#artboard').evaluate(image => image.decode());
  await page.screenshot({ path: path.join(root, 'gallery-phone.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await browser.close();
  const result = { status: 'passed', layouts, paperExports: 22, routeFamilies: 11, checks: ['local fonts', 'image dimensions and uniqueness', 'responsive gallery', '44px controls', 'bounded copy measure', 'deep links', 'keyboard focus', 'safe external links', 'no page errors'], boundary: 'Design gallery checks only; no runtime authorization or production UI validation' };
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exit(1); });
