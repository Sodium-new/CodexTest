/**
 * 本地管线验证脚本（Node + onnxruntime-web wasm）
 *
 * 用法：
 *   ORT_PATH=... ort.cjs 路径
 *   MODEL_PATH=... model_quantized.onnx 路径
 *   node tools/test-pipeline.mjs
 *
 * 流程：生成一张合成测试图（深色背景 + 白色圆形主体）→ 预处理到 1024×1024
 * → RMBG-1.4 推理 → 得到 alpha 蒙版 → 生成白色剪影 PNG → 输出统计验证。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, '..', '.test-output');
fs.mkdirSync(OUT_DIR, { recursive: true });

// 复用 Codex 运行时自带的 pngjs 做 PNG 编解码（避免额外安装）
const RUNTIME_NM = 'C:/Users/sodium/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const require = createRequire(path.join(RUNTIME_NM, 'pngjs', 'package.json'));
const { PNG } = require('pngjs');

const ORT_PATH = process.env.ORT_PATH || 'C:/Users/sodium/AppData/Local/Temp/silhouette-test/ort.cjs';
const MODEL_PATH = process.env.MODEL_PATH || 'C:/Users/sodium/AppData/Local/Temp/silhouette-test/model_quantized.onnx';
const WASM_BASE = process.env.WASM_BASE || 'C:/Users/sodium/AppData/Local/Temp/silhouette-test/';

const W = 640;
const H = 480;
const MODEL_SIZE = 1024;

// ---------- 1. 生成合成测试图 ----------
function makeTestImage() {
  const png = new PNG({ width: W, height: H });
  const cx = W / 2;
  const cy = H / 2;
  const r = 150;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = y / H;
      // 深色渐变背景
      png.data[i] = Math.round(22 + 8 * t);
      png.data[i + 1] = Math.round(30 + 6 * t);
      png.data[i + 2] = Math.round(72 - 26 * t);
      png.data[i + 3] = 255;
      // 白色圆形主体
      const d = Math.hypot(x - cx, y - cy);
      if (d <= r) {
        png.data[i] = 255;
        png.data[i + 1] = 255;
        png.data[i + 2] = 255;
      }
    }
  }
  const inputPath = path.join(OUT_DIR, 'test-input.png');
  fs.writeFileSync(inputPath, PNG.sync.write(png));
  return { png, inputPath };
}

// ---------- 2. 双线性缩放（RGB） ----------
function resizeRGB(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh * 3);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = y * yr;
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = x * xr;
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const s00 = (y0 * sw + x0) * 3;
      const s01 = (y0 * sw + x1) * 3;
      const s10 = (y1 * sw + x0) * 3;
      const s11 = (y1 * sw + x1) * 3;
      const o = (y * dw + x) * 3;
      for (let c = 0; c < 3; c++) {
        out[o + c] =
          src[s00 + c] * (1 - fx) * (1 - fy) +
          src[s01 + c] * fx * (1 - fy) +
          src[s10 + c] * (1 - fx) * fy +
          src[s11 + c] * fx * fy;
      }
    }
  }
  return out;
}

// ---------- 3. 蒙版缩放（单通道） ----------
function resizeMask(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = y * yr;
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = x * xr;
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = y * dw + x;
      out[o] =
        src[y0 * sw + x0] * (1 - fx) * (1 - fy) +
        src[y0 * sw + x1] * fx * (1 - fy) +
        src[y1 * sw + x0] * (1 - fx) * fy +
        src[y1 * sw + x1] * fx * fy;
    }
  }
  return out;
}

// ---------- 4. 保存蒙版 / 剪影 ----------
function saveMask(mask, w, h, file) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(Math.min(1, Math.max(0, mask[i])) * 255);
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  fs.writeFileSync(path.join(OUT_DIR, file), PNG.sync.write(png));
}

function saveSilhouette(mask, w, h, file) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const a = Math.round(Math.min(1, Math.max(0, mask[i])) * 255);
    png.data[i * 4] = 255;
    png.data[i * 4 + 1] = 255;
    png.data[i * 4 + 2] = 255;
    png.data[i * 4 + 3] = a;
  }
  fs.writeFileSync(path.join(OUT_DIR, file), PNG.sync.write(png));
}

// ---------- 5. 主流程 ----------
const ort = require(ORT_PATH);
ort.env.wasm.wasmPaths = {
  mjs: 'file:///' + WASM_BASE.replace(/\\/g, '/').replace(/^\/?([A-Za-z]:)/, '$1').replace(/\/$/, '') + '/ort-wasm-simd-threaded.mjs',
  wasm: 'file:///' + WASM_BASE.replace(/\\/g, '/').replace(/^\/?([A-Za-z]:)/, '$1').replace(/\/$/, '') + '/ort-wasm-simd-threaded.wasm',
};
ort.env.wasm.numThreads = 1;

console.log('onnxruntime version:', ort.env.version || 'n/a');
const modelBuf = fs.readFileSync(MODEL_PATH);
console.log('model bytes:', modelBuf.length);

const session = await ort.InferenceSession.create(modelBuf, {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
});
console.log('input names:', session.inputNames);
console.log('output names:', session.outputNames);

const { png, inputPath } = makeTestImage();
console.log('test image:', inputPath);

// RGB 数据：PNG 是 RGBA
const rgb = new Float32Array(W * H * 3);
for (let i = 0; i < W * H; i++) {
  rgb[i * 3] = png.data[i * 4];
  rgb[i * 3 + 1] = png.data[i * 4 + 1];
  rgb[i * 3 + 2] = png.data[i * 4 + 2];
}

const resized = resizeRGB(rgb, W, H, MODEL_SIZE, MODEL_SIZE);
const inputTensor = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
for (let y = 0; y < MODEL_SIZE; y++) {
  for (let x = 0; x < MODEL_SIZE; x++) {
    const o = (y * MODEL_SIZE + x) * 3;
    for (let c = 0; c < 3; c++) {
      inputTensor[c * MODEL_SIZE * MODEL_SIZE + y * MODEL_SIZE + x] =
        resized[o + c] / 255 - 0.5; // mean 0.5, std 1
    }
  }
}

const inputName = session.inputNames[0];
const feeds = {};
feeds[inputName] = new ort.Tensor('float32', inputTensor, [1, 3, MODEL_SIZE, MODEL_SIZE]);
const started = Date.now();
const results = await session.run(feeds);
console.log('inference ms:', Date.now() - started);

const outName = session.outputNames[0];
const out = results[outName];
console.log('output:', outName, 'dims:', out.dims, 'type:', out.type);
const mask1024 = out.data; // Float32Array

let min = 1, max = 0;
for (let i = 0; i < mask1024.length; i++) {
  if (mask1024[i] < min) min = mask1024[i];
  if (mask1024[i] > max) max = mask1024[i];
}
console.log('raw mask min/max:', min.toFixed(3), max.toFixed(3));

const mask = resizeMask(mask1024, MODEL_SIZE, MODEL_SIZE, W, H);

// 统计：圆形内部 vs 四角
let circleSum = 0, circleN = 0, cornerSum = 0, cornerN = 0;
const cx = W / 2, cy = H / 2, r = 120;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, y - cy);
    const v = mask[y * W + x];
    if (d < r) { circleSum += v; circleN++; }
    if ((x < 40 && y < 40) || (x > W - 40 && y < 40) || (x < 40 && y > H - 40) || (x > W - 40 && y > H - 40)) {
      cornerSum += v; cornerN++;
    }
  }
}
console.log('mask mean inside circle:', (circleSum / circleN).toFixed(3));
console.log('mask mean at corners:', (cornerSum / cornerN).toFixed(3));

saveMask(mask, W, H, 'mask.png');
saveSilhouette(mask, W, H, 'silhouette.png');
console.log('outputs written to', OUT_DIR);

const pass = circleSum / circleN > 0.9 && cornerSum / cornerN < 0.1;
console.log(pass ? 'PASS: 主体被正确识别为白色剪影' : 'FAIL: 蒙版结果不符合预期');
process.exit(pass ? 0 : 1);
