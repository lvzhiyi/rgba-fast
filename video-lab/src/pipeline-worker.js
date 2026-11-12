import { JSProcessor, loadWasm, validateConfig } from './kernels.js';
import { LiveMeter, coverRect, droppedBetween } from './live-stats.js';
import { getEffect } from './effects.js';

// 实时视频管线（Worker 端）：VideoFrame → Wasm 线性内存 → 滤镜 → OffscreenCanvas。
// 帧来源两种：MediaStreamTrackProcessor 的 ReadableStream，或主线程逐帧转移的 VideoFrame。
const STATS_INTERVAL = 500;
const meter = new LiveMeter();
let canvas, context, engines, settings, reader, scratch;
let session = 0;
let rgbaCopy;        // undefined：未探测；true：copyTo 可转 RGBA；false：回退 Canvas 读像素
let fallbackReason = '';
let lastStats = 0;
let path = '';
let previousTimestamp;
let minInterval = Infinity;

self.postMessage({ type: 'caps', mstp: typeof self.MediaStreamTrackProcessor === 'function' });

async function prepareEngines(width, height) {
  if (engines?.width === width && engines?.height === height) return;
  const url = kind => new URL(`../wasm/benchmark-${kind}.wasm`, import.meta.url);
  const scalar = await loadWasm(url('scalar'), width, height);
  let simd;
  try {
    simd = await loadWasm(url('simd'), width, height);
  } catch {
    simd = undefined;
  }
  // 预先为所有可能的输出缓冲区创建 ImageData 视图：逐帧不分配、不复制到中间数组。
  const plain = new Uint8Array(width * height * 4);
  const js = new JSProcessor(width, height);
  const views = [plain, js.a, js.b];
  for (const engine of [scalar, simd]) if (engine) views.push(...engine.outputs.values());
  const images = new Map(views.map(view =>
    [view, new ImageData(new Uint8ClampedArray(view.buffer, view.byteOffset, view.length), width, height)]));
  engines = { width, height, plain, js, scalar, simd, images };
}

function applyEffect(id) {
  const effect = getEffect(id);
  for (const engine of [engines.js, engines.scalar, engines.simd]) engine?.setEffect(effect);
}

// 把一帧写进目标缓冲区（Wasm 输入区或 JS 数组），返回实际采用的路径。
async function copyIn(frame, target) {
  const { width, height } = settings;
  const rect = coverRect(frame.displayWidth, frame.displayHeight, width, height);
  if (rgbaCopy !== false) {
    try {
      const exact = frame.visibleRect.width === width && frame.visibleRect.height === height &&
        frame.displayWidth === width && frame.displayHeight === height;
      if (exact) {
        // 尺寸一致：一次 copyTo 完成格式转换并直接落进 Wasm 内存，没有中间 JS 缓冲区。
        await frame.copyTo(target, { format: 'RGBA', colorSpace: 'srgb' });
      } else {
        // 尺寸不同：先用 ImageBitmap 在浏览器侧裁剪缩放，再 copyTo 写入 Wasm 内存。
        const bitmap = await createImageBitmap(frame, rect.x, rect.y, rect.width, rect.height,
          { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
        const scaled = new VideoFrame(bitmap, { timestamp: frame.timestamp });
        bitmap.close();
        try {
          await scaled.copyTo(target, { format: 'RGBA', colorSpace: 'srgb' });
        } finally {
          scaled.close();
        }
      }
      rgbaCopy = true;
      return exact ? 'copyTo 直写' : '缩放 + copyTo';
    } catch (error) {
      if (rgbaCopy) throw error;
      // 浏览器不支持 copyTo 转 RGBA 时，永久切到 Canvas 读像素路径并记录原因。
      rgbaCopy = false;
      fallbackReason = error.message;
    }
  }
  if (scratch?.width !== width || scratch?.height !== height) {
    scratch = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  }
  scratch.drawImage(frame, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  target.set(scratch.getImageData(0, 0, width, height).data);
  return 'Canvas 读像素';
}

async function processFrame(frame) {
  const { mode, passes } = settings;
  const start = performance.now();
  const wasm = mode === 'scalar' || mode === 'simd' ? engines[mode] : undefined;
  if ((mode === 'scalar' || mode === 'simd') && !wasm) {
    frame.close();
    throw new Error('当前浏览器无法使用 SIMD，请选择标量模式');
  }
  const target = wasm ? wasm.input : engines.plain;
  let format;
  try {
    format = frame.format;
    path = await copyIn(frame, target);
  } finally {
    frame.close();
  }
  const copied = performance.now();
  let output = target;
  if (mode === 'js') output = engines.js.run(target, passes);
  else if (wasm) output = wasm.run(passes);
  const processed = performance.now();
  context.putImageData(engines.images.get(output), 0, 0);
  const end = performance.now();
  meter.add({ copyIn: copied - start, process: processed - copied, output: end - processed, total: end - start });
  if (end - lastStats >= STATS_INTERVAL) {
    lastStats = end;
    const summary = meter.summary();
    meter.next();
    self.postMessage({ type: 'stats', ...summary, path, format, fallbackReason,
      size: `${settings.width}×${settings.height}` });
  }
}

async function pump(readable, token) {
  // 每个会话持有自己的 reader；全局变量只用于 stop() 取消，避免新旧会话互相覆盖。
  const own = readable.getReader();
  reader = own;
  try {
    while (token === session) {
      const { value: frame, done } = await own.read();
      if (done) break;
      if (token !== session) { frame.close(); break; }
      // MediaStreamTrackProcessor 在处理跟不上时丢弃旧帧，用时间戳间隔估算掉帧数。
      if (previousTimestamp !== undefined && frame.timestamp > previousTimestamp) {
        minInterval = Math.min(minInterval, frame.timestamp - previousTimestamp);
      }
      meter.drop(droppedBetween(previousTimestamp, frame.timestamp, settings.interval || minInterval));
      previousTimestamp = frame.timestamp;
      await processFrame(frame);
    }
  } catch (error) {
    if (token === session) self.postMessage({ type: 'error', message: error.message });
  } finally {
    own.cancel().catch(() => {});
    if (reader === own) reader = undefined;
  }
}

function stop() {
  session++;
  reader?.cancel().catch(() => {});
  reader = undefined;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    canvas = data.canvas;
    context = canvas.getContext('2d');
  } else if (data.type === 'start') {
    stop();
    const token = session;
    const { width, height, passes, mode, frameRate, effect } = data;
    try {
      validateConfig(width, height, passes);
      await prepareEngines(width, height);
      if (token !== session) return;
      applyEffect(effect);
      settings = { width, height, passes, mode, interval: frameRate > 0 ? 1e6 / frameRate : 0 };
      canvas.width = width;
      canvas.height = height;
      meter.reset();
      lastStats = performance.now();
      previousTimestamp = undefined;
      minInterval = Infinity;
      path = '';
      let readable = data.readable;
      if (data.track) readable = new MediaStreamTrackProcessor({ track: data.track, maxBufferSize: 1 }).readable;
      self.postMessage({ type: 'started', simd: Boolean(engines.simd), session: token });
      if (readable) pump(readable, token);
    } catch (error) {
      if (token === session) self.postMessage({ type: 'error', message: error.message });
    }
  } else if (data.type === 'frame') {
    // 主线程逐帧转移的回退路径：主线程负责背压和精确的掉帧计数。
    const { frame } = data;
    if (settings && data.session === session) {
      meter.drop(data.missed);
      try {
        await processFrame(frame);
      } catch (error) {
        if (data.session === session) self.postMessage({ type: 'error', message: error.message });
      }
    } else frame.close();
    self.postMessage({ type: 'ready', session: data.session });
  } else if (data.type === 'mode') {
    if (settings) settings.mode = data.mode;
    meter.reset();
    lastStats = performance.now();
  } else if (data.type === 'effect') {
    // 效果参数写进 Wasm 内存即可，下一帧生效，无需重启管线。
    try {
      if (engines) applyEffect(data.effect);
    } catch (error) {
      self.postMessage({ type: 'error', message: error.message });
    }
    meter.reset();
    lastStats = performance.now();
  } else if (data.type === 'stop') {
    stop();
    settings = undefined;
  }
};
