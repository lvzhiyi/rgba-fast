import { IMPLEMENTATIONS, JSProcessor, loadAllWasm, validateConfig } from './kernels.js';
import { LiveMeter, coverRect, droppedBetween } from './live-stats.js';
import { getEffect } from './effects.js';

// 实时视频管线（Worker 端）：VideoFrame → Wasm 线性内存 → 滤镜 → OffscreenCanvas。
// 帧来源两种：MediaStreamTrackProcessor 的 ReadableStream，或主线程逐帧转移的 VideoFrame。
//
// 与主线程的消息协议：
//   收到 init   { canvas }          —— 只发一次，拿到输出用的 OffscreenCanvas
//   收到 start  { width, height, passes, mode, effect, frameRate, readable | track }
//   收到 frame  { frame, session, missed } —— 回退路径：主线程逐帧送来
//   收到 mode / effect               —— 运行中切换实现或效果
//   收到 stop
//   发出 caps / started / ready / stats / error
//
// 整个 Worker 只有这一份全局状态，每次 start 覆盖它。
const STATS_INTERVAL = 500;          // 每 500 ms 向主线程汇报一次统计
const meter = new LiveMeter();
let canvas, context, engines, settings, scratch;
// 会话号：每次 start / stop 都加一。异步代码开始时记下当时的值（token），
// 之后发现 token !== session 就说明期间已经开始了新会话或已停止，应立即放弃，不能再改动全局状态。
let session = 0;
let rgbaCopy;        // undefined：未探测；true：copyTo 可转 RGBA；false：回退 Canvas 读像素
let fallbackReason = '';
let lastStats = 0;
let path = '';                       // 本帧实际走的取像素路径，显示在界面上
let previousTimestamp;               // 上一帧的时间戳（微秒），用于估算掉帧
let minInterval = Infinity;          // 观察到的最小帧间隔，帧率未知时当作一帧的标准间隔

// Worker 启动即告诉主线程：本环境的 Worker 里有没有 MediaStreamTrackProcessor（Safari 只在 Worker 里有）。
self.postMessage({ type: 'caps', mstp: typeof self.MediaStreamTrackProcessor === 'function' });

// 按当前尺寸加载 JS 与全部 Wasm 引擎；尺寸没变就复用上次的。
async function prepareEngines(width, height) {
  if (engines?.width === width && engines?.height === height) return;
  const { processors, errors } = await loadAllWasm(new URL('../wasm/', import.meta.url), width, height);
  // 预先为所有可能的输出缓冲区创建 ImageData 视图：逐帧不分配、不复制到中间数组。
  // plain：“原始画面”模式和 JS 模式下存放输入像素的普通数组（Wasm 模式则直接写进 Wasm 输入区）。
  const plain = new Uint8Array(width * height * 4);
  const js = new JSProcessor(width, height);
  const views = [plain, js.a, js.b];
  for (const engine of Object.values(processors)) views.push(...engine.outputs.values());
  const images = new Map(views.map(view =>
    [view, new ImageData(new Uint8ClampedArray(view.buffer, view.byteOffset, view.length), width, height)]));
  engines = { width, height, plain, js, wasm: processors, errors, images };
}

// 把效果参数同时设到所有引擎上，切换实现时不用再设一次。
function applyEffect(id) {
  const effect = getEffect(id);
  for (const engine of [engines.js, ...Object.values(engines.wasm)]) engine.setEffect(effect);
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

// 处理一帧，分三段计时：取像素（copyIn）→ 跑效果（process）→ 画到 Canvas（output）。
// VideoFrame 占用的是解码器 / GPU 的显存，数量有限，用完必须 close()，否则视频流会卡住。
async function processFrame(frame) {
  const { mode, passes } = settings;
  const start = performance.now();
  const wasm = engines.wasm[mode];
  if (mode !== 'none' && mode !== 'js' && !wasm) {
    frame.close();
    throw new Error(`${IMPLEMENTATIONS[mode] ?? mode} 不可用：${engines.errors[mode] ?? '未知实现'}`);
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
  // 原始画面模式下 output 就是输入本身。
  let output = target;
  if (mode === 'js') output = engines.js.run(target, passes);
  else if (wasm) output = wasm.run(passes);
  const processed = performance.now();
  // 按结果缓冲区查出预先建好的 ImageData（它直接包着那块内存），画到 OffscreenCanvas 上，页面会自动显示。
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

// 主路径的取帧循环：从 ReadableStream 一帧帧读出 VideoFrame 并处理，处理完一帧才读下一帧。
// 流的缓冲只有 1 帧（maxBufferSize: 1），处理慢时浏览器会丢弃旧帧，所以永远处理“最新”的画面。
async function pump(readable, token) {
  // 每个会话持有自己的 reader；stop() 只推进会话号，循环看到会话号变化后自行退出并排空。
  const own = readable.getReader();
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
    await drain(own);
  }
}

// 会话结束后排空帧流：直接 cancel 会让流里排队的 VideoFrame 未经 close 就被丢弃。
// 主线程停止轨道后流会自然结束；超过 1 秒仍未结束才强制取消。
async function drain(own) {
  const timer = setTimeout(() => own.cancel().catch(() => {}), 1000);
  try {
    for (;;) {
      const { value, done } = await own.read();
      if (done) break;
      value.close();
    }
  } catch {
    // 被取消或出错时流已结束，没有可关闭的帧。
  } finally {
    clearTimeout(timer);
  }
}

// 只推进会话号；正在运行的 pump 会在下一次检查时自行退出。
function stop() {
  session++;
}

// 按消息类型分派，协议见文件开头。
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    canvas = data.canvas;
    context = canvas.getContext('2d');
  } else if (data.type === 'start') {
    // 先结束旧会话，再记下新会话号；之后每个 await 之后都要检查它是否仍然有效。
    stop();
    const token = session;
    const { width, height, passes, mode, frameRate, effect } = data;
    // 帧流已转交到这里；只要没有交给 pump，就必须取消它，否则其中缓存的 VideoFrame 不会被 close。
    let handed = false;
    const discard = () => {
      if (handed) return;
      data.track?.stop();
      if (data.readable) drain(data.readable.getReader());
    };
    try {
      validateConfig(width, height, passes);
      await prepareEngines(width, height);
      if (token !== session) { discard(); return; }
      applyEffect(effect);
      settings = { width, height, passes, mode, interval: frameRate > 0 ? 1e6 / frameRate : 0 };
      canvas.width = width;
      canvas.height = height;
      meter.reset();
      lastStats = performance.now();
      previousTimestamp = undefined;
      minInterval = Infinity;
      path = '';
      // 主线程要么直接给了 readable（Chrome），要么给了轨道（Safari），由这里创建处理器；
      // 两者都没有时 readable 为空，走逐帧转移的 frame 消息。
      let readable = data.readable;
      if (data.track) readable = new MediaStreamTrackProcessor({ track: data.track, maxBufferSize: 1 }).readable;
      self.postMessage({ type: 'started', available: Object.keys(engines.wasm), session: token });
      // 故意不 await：pump 是一个长期运行的循环，onmessage 要立刻返回以便接收后续的 mode / effect / stop。
      if (readable) { handed = true; pump(readable, token); }
    } catch (error) {
      discard();
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
    } else frame.close();  // 过期会话的帧：不处理，但仍须释放
    // 告诉主线程可以送下一帧了。
    self.postMessage({ type: 'ready', session: data.session });
  } else if (data.type === 'mode') {
    // 切换实现：下一帧起生效；统计清零，避免新旧实现的耗时混在一起。
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
