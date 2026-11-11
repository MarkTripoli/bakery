const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'paper-manifest.json')));
  assert.equal(manifest.screens.length, 40);
  assert.equal(manifest.primitiveBoards.length, 4);
  assert.equal(Object.keys(manifest.primitives).length, 32);
  const primitives = JSON.parse(fs.readFileSync(path.join(root, 'primitives.json')));
  for (const key of Object.keys(manifest.primitives)) assert.ok(primitives.jsx[key]?.includes('<'), key);
  const hashes = new Set();
  for (const b of [...manifest.screens, ...manifest.primitiveBoards]) {
    const data = fs.readFileSync(path.join(root, b.image));
    assert.equal(data.readUInt32BE(16), b.width);
    assert.equal(data.readUInt32BE(20), b.height);
    assert.ok(data.length > 5000, b.image);
    hashes.add(require('node:crypto').createHash('sha256').update(data).digest('hex'));
  }
  assert.equal(hashes.size, 44, 'Every export is distinct');
  for (const use of manifest.uses) assert.equal(use.sourceNodeId, manifest.primitives[use.master].id);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:8799/integration-mocks/index.html');
  await page.waitForFunction(() => document.querySelectorAll('#screen option').length === 24);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => [...document.fonts].some(f => f.family === 'Geist' && f.status === 'loaded')));
  let layouts = 0;
  for (const width of [320, 390, 744, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (let i = 0; i < 24; i++) {
      await page.locator('#screen').selectOption(String(i));
      if (i < 20) await page.locator(width < 744 ? '#phone' : '#desktop').click();
      await page.waitForFunction(() => { const i = document.getElementById('artboard'); return i.complete && i.naturalWidth > 0; });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${i} overflow`);
      assert.ok((await page.locator('#artboard').getAttribute('alt')).length > 25);
      layouts++;
    }
  }
  await page.locator('#screen').selectOption('0');
  assert.equal(await page.locator('#previous').isDisabled(), true);
  await page.locator('#next').click();
  assert.equal(await page.locator('#title').innerText(), 'GitHub');
  await page.locator('#next-step a').first().click();
  await page.waitForFunction(() => location.hash === '#authorize');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('title').textContent === 'Authorize GitHub');
  await page.locator('#phone').focus();
  assert.equal(await page.locator('#phone').evaluate(e => getComputedStyle(e).outlineStyle), 'solid');
  for (const [width, mode] of [[1440, 'desktop'], [390, 'phone']]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.locator('#screen').selectOption('0');
    await page.locator('#' + mode).click();
    await page.locator('#artboard').evaluate(i => i.decode());
    await page.screenshot({ path: path.join(root, `gallery-${mode}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  await browser.close();
  const result = { status: 'passed', layouts, paperExports: 44, primitiveVariants: 32, cloneMappings: manifest.uses.length, checks: ['local fonts', 'image dimensions and uniqueness', 'responsive navigation', 'deep links and reload', 'keyboard focus', 'no page errors'], boundary: 'Design gallery checks; no runtime authorization or production UI validation' };
  fs.writeFileSync(path.join(root, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error); process.exit(1); });
