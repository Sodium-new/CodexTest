/**
 * 浏览器端到端验证（Playwright + 本机 Chrome/Edge）
 *
 * 用法：
 *   node tools/browser-test.mjs [页面URL]
 *
 * 验证内容：
 *   1. 页面固定为 4 个画框，且没有上传卡片（不能新增画框）
 *   2. 通过设置面板更换画框照片 → 等待 AI 剪影 → 校验剪影 PNG 像素
 *   3. 自定义标题/背景色/画框内容 → 刷新后仍保留
 *   4. 恢复默认画框内容
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(
  'C:/Users/sodium/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'
);
const { chromium } = require('playwright');

const RUNTIME_NM = 'C:/Users/sodium/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const pngRequire = createRequire(path.join(RUNTIME_NM, 'pngjs', 'package.json'));
const { PNG } = pngRequire('pngjs');

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const URL = args.find((a) => !a.startsWith('--')) || 'http://127.0.0.1:8123/';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const tmpDir = path.join(os.tmpdir(), 'silhouette-test');
fs.mkdirSync(tmpDir, { recursive: true });
const PROFILE_DIR = path.join(tmpDir, 'browser-profile');

// 生成合成测试图：深色背景 + 白色圆形主体
function makeTestImage(file) {
  const W = 640;
  const H = 480;
  const png = new PNG({ width: W, height: H });
  const cx = W / 2;
  const cy = H / 2;
  const r = 150;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = y / H;
      png.data[i] = Math.round(22 + 8 * t);
      png.data[i + 1] = Math.round(30 + 6 * t);
      png.data[i + 2] = Math.round(72 - 26 * t);
      png.data[i + 3] = 255;
      if (Math.hypot(x - cx, y - cy) <= r) {
        png.data[i] = 255;
        png.data[i + 1] = 255;
        png.data[i + 2] = 255;
      }
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
  console.log('PASS:', msg);
}

const inputFile = path.join(tmpDir, 'browser-input.png');
makeTestImage(inputFile);

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME,
  headless: true,
  viewport: { width: 1280, height: 900 },
});

const page = context.pages()[0] || (await context.newPage());
// 清掉上次运行保存的页面设置，保证从默认状态开始（模型缓存保留）
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });

const pageErrors = [];
page.on('pageerror', (err) => pageErrors.push(String(err)));
page.on('console', (msg) => {
  if (['error', 'warning'].includes(msg.type())) {
    console.log('[console]', msg.type(), msg.text().slice(0, 300));
  }
});
page.on('requestfailed', (req) => {
  console.log('[reqfail]', req.url().slice(0, 140), (req.failure() || {}).errorText || '');
});
page.on('response', (res) => {
  const u = res.url();
  if (/modelscope|huggingface|jsdelivr.*onnxruntime|ort-wasm/.test(u)) {
    console.log('[resp]', res.status(), u.slice(0, 140));
  }
});

console.log('open page:', URL);
await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
assert((await page.textContent('#gallery-title')) === '剪影画廊', '页面默认标题正确');

// ---- 1. 固定四幅画框，无上传卡片 ----
const frameCount = await page.evaluate(() => document.querySelectorAll('.grid .card').length);
assert(frameCount === 4, '页面固定为 4 个画框');
assert((await page.$('#upload-card')) === null, '不存在上传卡片（不能新增画框）');

// ---- 2. 设置面板：画框内容区域 ----
await page.click('#settings-btn');
await page.waitForSelector('#frame-settings .frame-edit');
const editCount = await page.evaluate(() => document.querySelectorAll('#frame-settings .frame-edit').length);
assert(editCount === 4, '设置面板包含 4 个画框编辑项');
assert(
  (await page.textContent('#frame-settings .frame-edit:first-child .frame-edit-name')).includes('山峦'),
  '画框 1 默认内容正确'
);

if (!QUICK) {
  // ---- 2a. 更换画框 1 的照片 ----
  console.log('replace frame 1 image, waiting for model download + inference...');
  await page.click('#frame-settings .frame-edit:first-child .file-btn');
  await page.setInputFiles('#frame-file', inputFile);

  const poll = setInterval(async () => {
    const status = await page.$eval('#frame-status', (el) => el.textContent).catch(() => '');
    const width = await page.$eval('#frame-progress-bar', (el) => el.style.width).catch(() => '');
    const toastText = await page.$eval('#toast', (el) => (el.hidden ? '' : el.textContent)).catch(() => '');
    console.log(
      '[progress]',
      new Date().toISOString().slice(11, 19),
      'status:',
      status,
      'bar:',
      width,
      'toast:',
      toastText
    );
  }, 10000);
  await page
    .waitForFunction(
      () => document.querySelector('.grid .card .frame .photo').src.startsWith('data:'),
      null,
      { timeout: 480000 }
    )
    .finally(() => clearInterval(poll));

  assert(true, '画框 1 的照片已替换为自定义图片');

  // ---- 2b. 校验剪影像素 ----
  const stats = await page.evaluate(async () => {
    const el = document.querySelector('.grid .card .frame .silhouette');
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\("?(data:image\/png;base64,[^")]+)"?\)/);
    if (!m) return { error: '未找到剪影 data URL: ' + bg };
    const img = new Image();
    img.src = m[1];
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    let white = 0;
    const total = c.width * c.height;
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] > 8) {
        opaque++;
        if (data[i * 4] > 240 && data[i * 4 + 1] > 240 && data[i * 4 + 2] > 240) white++;
      }
    }
    return { w: c.width, h: c.height, total, opaque, white, ratio: opaque / total };
  });
  console.log('silhouette stats:', JSON.stringify(stats));
  assert(!stats.error, '剪影 data URL 可访问');
  assert(stats.ratio > 0.12 && stats.ratio < 0.55, '主体面积占比合理（约 23% 的圆）');
  assert(stats.opaque > 0 && stats.opaque === stats.white, '所有不透明像素均为纯白');
} else {
  console.log('quick mode: 跳过模型推理，只验证设置面板与持久化');
}

// ---- 3. 自定义标题与背景色 ----
await page.fill('#set-title', '我的剪影');
await page.fill('#set-sub', 'My Gallery');
await page.click('.swatch[data-color="#111111"]');
await page.click('#settings-done');
await page.waitForTimeout(600); // 等待背景色过渡动画结束

assert((await page.textContent('#gallery-title')) === '我的剪影', '标题即时生效');
assert((await page.textContent('#gallery-sub')) === 'My Gallery', '副标题即时生效');
assert(
  (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(17, 17, 17)',
  '背景色即时生效'
);

// ---- 4. 刷新后持久化（标题/背景/画框内容） ----
await page.reload({ waitUntil: 'load' });
assert((await page.textContent('#gallery-title')) === '我的剪影', '刷新后标题持久化');
assert(
  (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(17, 17, 17)',
  '刷新后背景色持久化'
);
if (!QUICK) {
  const photoSrc = await page.evaluate(() => document.querySelector('.grid .card .frame .photo').src);
  assert(photoSrc.startsWith('data:'), '刷新后画框 1 的自定义内容持久化');

  // ---- 5. 恢复默认 ----
  await page.click('#settings-btn');
  await page.click('#frame-settings .frame-edit:first-child .ghost-btn');
  await page.waitForFunction(
    () => document.querySelector('.grid .card .frame .photo').src.endsWith('01-mountains.svg')
  );
  assert(true, '画框 1 恢复默认图片');
}

// ---- 收尾 ----
await page.screenshot({ path: path.join(tmpDir, 'browser-result.png'), fullPage: true });
console.log('screenshot saved:', path.join(tmpDir, 'browser-result.png'));

if (pageErrors.length) {
  console.log('page errors:', pageErrors);
  await context.close();
  process.exit(1);
}

await context.close();
console.log('ALL PASS');
process.exit(0);
