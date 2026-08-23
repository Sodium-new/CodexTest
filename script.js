/**
 * 剪影画廊 · 交互脚本
 *
 * - 更换画框照片 → onnxruntime-web + RMBG-1.4（浏览器本地推理）→ 白色剪影 PNG
 * - 悬停查看原图
 * - 自定义标题、背景与画框内容（本地持久化）
 *
 * 图片与模型都在浏览器本地处理，不会上传到任何服务器。
 */
(function () {
  'use strict';

  /* ---------------- 常量 ---------------- */
  const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort.min.js';
  const ORT_WASM_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
  // 按顺序尝试的模型下载源（浏览器需要支持 CORS）
  const MODEL_SOURCES = [
    'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx',
    'https://modelscope.cn/models/briaai/RMBG-1.4/resolve/master/onnx/model_quantized.onnx',
  ];
  const MODEL_CACHE = 'silhouette-model-v1';
  const MODEL_SIZE = 1024;          // 模型输入尺寸
  const MAX_OUTPUT_DIM = 1600;      // 剪影输出最大边长
  const MAX_FILE_MB = 30;
  const HOST_TIMEOUT_MS = 10000;    // 每个模型源的超时时间

  const SETTINGS_KEY = 'silhouette-gallery-settings-v1';
  const DEFAULT_SETTINGS = {
    title: '剪影画廊',
    sub: 'Silhouette Gallery',
    bgColor: '#f0f0f0',
    bgImage: '',
    frames: [null, null, null, null],
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- DOM ---------------- */
  const frameEls = $$('.grid .card .frame');
  const FRAME_DEFAULTS = frameEls.map((f) => {
    const photo = f.querySelector('.photo');
    const sil = f.querySelector('.silhouette');
    return {
      photo: photo.getAttribute('src'),
      alt: photo.getAttribute('alt'),
      mask: sil.style.getPropertyValue('--mask'),
      label: f.getAttribute('aria-label'),
    };
  });

  const frameSettings = $('#frame-settings');
  const frameFileInput = $('#frame-file');
  const frameProgress = $('#frame-progress');
  const frameProgressBar = $('#frame-progress-bar');
  const frameStatus = $('#frame-status');

  const settingsBtn = $('#settings-btn');
  const settingsPanel = $('#settings-panel');
  const settingsClose = $('#settings-close');
  const settingsDone = $('#settings-done');
  const setTitle = $('#set-title');
  const setSub = $('#set-sub');
  const setBgColor = $('#set-bg-color');
  const bgSwatches = $('#bg-swatches');
  const setBgImage = $('#set-bg-image');
  const clearBgImage = $('#clear-bg-image');
  const resetSettings = $('#reset-settings');

  const galleryTitle = $('#gallery-title');
  const gallerySub = $('#gallery-sub');
  const toast = $('#toast');

  /* ---------------- 状态 ---------------- */
  let sessionPromise = null;
  let ort = null;
  let toastTimer = null;
  let frameBusy = false;
  let editingFrameIndex = -1;

  /* ---------------- 小工具 ---------------- */
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function showToast(msg, ms) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, ms || 2800);
  }

  function safeName(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '').trim();
    return base || '剪影';
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片无法读取'));
      };
      img.src = url;
    });
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('图片读取失败'));
      r.readAsDataURL(blob);
    });
  }

  function fileToDataURL(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        const c = makeCanvas(w, h);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#f0f0f0';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('图片读取失败'));
      };
      img.src = url;
    });
  }

  /* ---------------- 模型加载 ---------------- */
  function loadOrt() {
    if (ort) return Promise.resolve(ort);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = ORT_URL;
      s.onload = () => {
        if (!window.ort) {
          reject(new Error('AI 引擎加载失败'));
          return;
        }
        ort = window.ort;
        ort.env.wasm.wasmPaths = {
          mjs: ORT_WASM_BASE + 'ort-wasm-simd-threaded.mjs',
          wasm: ORT_WASM_BASE + 'ort-wasm-simd-threaded.wasm',
        };
        // 仅在页面具备跨域隔离（COOP/COEP）时启用多线程，否则单线程最稳
        ort.env.wasm.numThreads =
          typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
            ? Math.min(4, navigator.hardwareConcurrency || 4)
            : 1;
        resolve(ort);
      };
      s.onerror = () => reject(new Error('AI 引擎加载失败，请检查网络'));
      document.head.appendChild(s);
    });
  }

  async function downloadWithProgress(url, onProgress) {
    // 超时只作用于连接阶段；正文下载不设限，避免大模型被中断
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HOST_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const total = Number(resp.headers.get('content-length')) || 0;
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total && onProgress) onProgress(received / total);
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    if (onProgress) onProgress(1);
    return out;
  }

  async function getModelBytes(onProgress) {
    if (onProgress) onProgress(0);
    const cache = 'caches' in self ? await caches.open(MODEL_CACHE).catch(() => null) : null;
    const errors = [];

    for (const url of MODEL_SOURCES) {
      // 优先使用浏览器缓存，避免重复下载 42MB 模型
      if (cache) {
        try {
          const hit = await cache.match(url);
          if (hit) {
            if (onProgress) onProgress(1);
            return new Uint8Array(await hit.arrayBuffer());
          }
        } catch (e) {
          errors.push(e);
        }
      }
      try {
        const bytes = await downloadWithProgress(url, onProgress);
        if (cache) {
          cache.put(url, new Response(new Blob([bytes]))).catch(() => {});
        }
        return bytes;
      } catch (e) {
        errors.push(url + ' → ' + e.message);
        console.warn('模型源不可用:', url, e);
      }
    }
    throw new Error('模型下载失败：' + errors.join('；'));
  }

  async function loadModel(onProgress) {
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const o = await loadOrt();
        const bytes = await getModelBytes(onProgress);
        // 统一使用 wasm 后端：兼容性最好、初始化稳定；WebGPU 留作后续优化
        return o.InferenceSession.create(bytes, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'basic',
        });
      })();
      sessionPromise.catch(() => {
        sessionPromise = null; // 失败后允许重试
      });
    }
    return sessionPromise;
  }

  /* ---------------- 剪影生成 ---------------- */
  async function makeSilhouette(file, onProgress) {
    const { img, url } = await loadImageFromFile(file);
    try {
      const width = img.naturalWidth;
      const height = img.naturalHeight;

      // 1. 预处理：缩放至模型输入尺寸 1024×1024
      const prep = makeCanvas(MODEL_SIZE, MODEL_SIZE);
      const pctx = prep.getContext('2d', { willReadFrequently: true });
      pctx.drawImage(img, 0, 0, MODEL_SIZE, MODEL_SIZE);
      const pixels = pctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;

      const n = MODEL_SIZE * MODEL_SIZE;
      const input = new Float32Array(3 * n);
      for (let i = 0; i < n; i++) {
        input[i] = pixels[i * 4] / 255 - 0.5;
        input[n + i] = pixels[i * 4 + 1] / 255 - 0.5;
        input[2 * n + i] = pixels[i * 4 + 2] / 255 - 0.5;
      }

      // 2. 推理
      const session = await loadModel(onProgress);
      const feeds = {};
      feeds[session.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, MODEL_SIZE, MODEL_SIZE]);
      const results = await session.run(feeds);
      const outName = session.outputNames[0];
      const mask = results[outName].data; // Float32Array，1024×1024，0~1 前景 alpha

      // 3. 蒙版转图片，轻微增加对比让边缘更利落
      const maskCanvas = makeCanvas(MODEL_SIZE, MODEL_SIZE);
      const mctx = maskCanvas.getContext('2d', { willReadFrequently: true });
      const maskImage = mctx.createImageData(MODEL_SIZE, MODEL_SIZE);
      for (let i = 0; i < n; i++) {
        const v = Math.round(clamp((mask[i] - 0.5) * 1.3 + 0.5, 0, 1) * 255);
        maskImage.data[i * 4] = v;
        maskImage.data[i * 4 + 1] = v;
        maskImage.data[i * 4 + 2] = v;
        maskImage.data[i * 4 + 3] = 255;
      }
      mctx.putImageData(maskImage, 0, 0);

      // 4. 放大蒙版到输出尺寸，得到平滑的 alpha
      const scale = Math.min(1, MAX_OUTPUT_DIM / Math.max(width, height));
      const outW = Math.max(1, Math.round(width * scale));
      const outH = Math.max(1, Math.round(height * scale));
      const outCanvas = makeCanvas(outW, outH);
      const octx = outCanvas.getContext('2d', { willReadFrequently: true });
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(maskCanvas, 0, 0, outW, outH);
      // 蒙版画布不透明，灰度值在 RGB 通道；取红色通道作为 alpha
      const drawn = octx.getImageData(0, 0, outW, outH).data;

      // 5. 填充白色，保留 alpha → 白色剪影
      const sil = octx.createImageData(outW, outH);
      for (let i = 0; i < outW * outH; i++) {
        sil.data[i * 4] = 255;
        sil.data[i * 4 + 1] = 255;
        sil.data[i * 4 + 2] = 255;
        sil.data[i * 4 + 3] = drawn[i * 4];
      }
      octx.putImageData(sil, 0, 0);

      const blob = await new Promise((resolve, reject) => {
        outCanvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('剪影生成失败'))),
          'image/png'
        );
      });

      return { blob, originalUrl: url };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }

  /* ---------------- 画框内容 ---------------- */
  function applyFrame(index, content) {
    const frame = frameEls[index];
    const photo = frame.querySelector('.photo');
    const sil = frame.querySelector('.silhouette');
    const d = FRAME_DEFAULTS[index];
    if (content) {
      photo.src = content.original;
      photo.alt = content.name;
      frame.setAttribute('aria-label', content.name + '，悬停查看原图');
      sil.classList.add('png-silhouette');
      sil.style.removeProperty('--mask');
      sil.style.setProperty('--silhouette-img', 'url("' + content.silhouette + '")');
    } else {
      photo.src = d.photo;
      photo.alt = d.alt;
      frame.setAttribute('aria-label', d.label);
      sil.classList.remove('png-silhouette');
      sil.style.removeProperty('--silhouette-img');
      sil.style.setProperty('--mask', d.mask);
    }
  }

  function renderFrameSettings() {
    const state = current.frames || [];
    frameSettings.textContent = '';
    frameEls.forEach((frame, i) => {
      const content = state[i] || null;
      const d = FRAME_DEFAULTS[i];
      const row = document.createElement('div');
      row.className = 'frame-edit';

      const thumb = document.createElement('img');
      thumb.className = 'frame-thumb';
      thumb.alt = '';
      thumb.src = content ? content.original : d.photo;

      const info = document.createElement('div');
      info.className = 'frame-edit-info';

      const name = document.createElement('span');
      name.className = 'frame-edit-name';
      name.textContent = '画框 ' + (i + 1) + ' · ' + (content ? content.name : d.alt);

      const actions = document.createElement('div');
      actions.className = 'frame-edit-actions';

      const replaceBtn = document.createElement('button');
      replaceBtn.type = 'button';
      replaceBtn.className = 'file-btn';
      replaceBtn.textContent = '更换';
      replaceBtn.disabled = frameBusy;
      replaceBtn.title = '选择照片生成白色剪影';
      replaceBtn.addEventListener('click', () => {
        editingFrameIndex = i;
        frameFileInput.value = '';
        frameFileInput.click();
      });

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'ghost-btn';
      restoreBtn.textContent = '恢复默认';
      restoreBtn.disabled = !content || frameBusy;
      restoreBtn.addEventListener('click', () => {
        const frames = (current.frames || []).slice();
        frames[i] = null;
        updateAndSave({ frames });
        showToast('画框 ' + (i + 1) + ' 已恢复默认');
      });

      actions.append(replaceBtn, restoreBtn);
      info.append(name, actions);
      row.append(thumb, info);
      frameSettings.appendChild(row);
    });
  }

  function setFrameBusy(busy, statusText) {
    frameBusy = busy;
    frameProgress.hidden = !busy;
    frameStatus.textContent = statusText || '';
    frameProgressBar.style.width = busy ? '0%' : '';
    renderFrameSettings();
  }

  function setFrameProgress(frac) {
    frameProgressBar.style.width = Math.round(frac * 100) + '%';
  }

  async function replaceFrameContent(index, file) {
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const looksLikeImage =
      file.type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].includes(ext);
    if (!looksLikeImage) {
      showToast('请选择图片文件');
      return;
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      showToast('「' + file.name + '」超过 ' + MAX_FILE_MB + 'MB，已跳过');
      return;
    }
    setFrameBusy(true, '正在处理「' + file.name + '」… 首次使用需下载模型，请稍候');
    try {
      const result = await makeSilhouette(file, setFrameProgress);
      setFrameProgress(1);
      const [original, silhouette] = await Promise.all([
        fileToDataURL(file, 1280, 0.82),
        blobToDataURL(result.blob),
      ]);
      URL.revokeObjectURL(result.originalUrl);
      const frames = (current.frames || []).slice();
      frames[index] = { original, silhouette, name: safeName(file.name) };
      updateAndSave({ frames });
      showToast('画框 ' + (index + 1) + ' 已更换');
    } catch (e) {
      showToast('更换画框失败：' + e.message);
    } finally {
      setFrameBusy(false, '');
    }
  }

  frameFileInput.addEventListener('change', () => {
    const file = frameFileInput.files && frameFileInput.files[0];
    frameFileInput.value = '';
    if (!file) return;
    const index = editingFrameIndex;
    editingFrameIndex = -1;
    if (index < 0) return;
    replaceFrameContent(index, file);
  });

  /* ---------------- 自定义设置 ---------------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (e) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(state) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state));
    } catch (e) {
      showToast('保存失败：本地存储空间不足');
    }
  }

  function applySettings(state) {
    galleryTitle.textContent = state.title;
    gallerySub.textContent = state.sub;
    document.title = state.title + ' · ' + state.sub;
    document.documentElement.style.setProperty('--page-bg', state.bgColor);
    document.documentElement.style.setProperty(
      '--page-bg-image',
      state.bgImage ? 'url("' + state.bgImage + '")' : 'none'
    );
    document.body.classList.toggle('has-bg-image', !!state.bgImage);

    // 画框内容
    (state.frames || []).forEach((content, i) => applyFrame(i, content));
    renderFrameSettings();

    // 同步面板控件
    setTitle.value = state.title;
    setSub.value = state.sub;
    setBgColor.value = state.bgColor;
    $$('.swatch[data-color]', bgSwatches).forEach((s) => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === state.bgColor.toLowerCase());
    });
    const custom = $('#set-bg-color');
    custom.closest('.swatch-custom').classList.toggle(
      'active',
      !$$('.swatch[data-color]', bgSwatches).some(
        (s) => (s.dataset.color || '').toLowerCase() === state.bgColor.toLowerCase()
      )
    );
    clearBgImage.disabled = !state.bgImage;
  }

  let current = loadSettings();
  applySettings(current);

  let saveTimer = null;
  function updateAndSave(patch) {
    current = { ...current, ...patch };
    applySettings(current);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveSettings(current), 250);
  }

  setTitle.addEventListener('input', () => updateAndSave({ title: setTitle.value.trim() || DEFAULT_SETTINGS.title }));
  setSub.addEventListener('input', () => updateAndSave({ sub: setSub.value.trim() || DEFAULT_SETTINGS.sub }));

  bgSwatches.addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch[data-color]');
    if (sw) updateAndSave({ bgColor: sw.dataset.color });
  });

  setBgColor.addEventListener('input', () => updateAndSave({ bgColor: setBgColor.value }));

  setBgImage.addEventListener('change', async () => {
    const file = setBgImage.files && setBgImage.files[0];
    setBgImage.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToDataURL(file, 1920, 0.85);
      updateAndSave({ bgImage: dataUrl });
      showToast('背景图片已应用');
    } catch (e) {
      showToast(e.message);
    }
  });

  clearBgImage.addEventListener('click', () => updateAndSave({ bgImage: '' }));
  resetSettings.addEventListener('click', () => updateAndSave({ ...DEFAULT_SETTINGS }));

  function togglePanel(show) {
    settingsPanel.hidden = !show;
  }

  settingsBtn.addEventListener('click', () => togglePanel(settingsPanel.hidden));
  settingsClose.addEventListener('click', () => togglePanel(false));
  settingsDone.addEventListener('click', () => togglePanel(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') togglePanel(false);
  });
  document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && !settingsBtn.contains(e.target)) {
      togglePanel(false);
    }
  });
})();
