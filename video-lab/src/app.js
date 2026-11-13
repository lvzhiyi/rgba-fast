// 页面主线程脚本：负责界面交互，计算本身交给 Worker 或 kernels.js。
// 页面有两大功能：
//   1. 基准测试（“开始测试”）：把一张固定帧交给 benchmark-worker.js，对所有实现计时并展示结果；
//   2. 实时处理（“开始实时”）：视频 / 摄像头逐帧施加效果，两种管线可选：
//      - 主线程管线 drawVideo：简单直观，但会和页面抢主线程，作为对照；
//      - Worker 管线：把帧交给 pipeline-worker.js 处理并直接画到 OffscreenCanvas，主线程不碰像素。
// 文件结构：全局状态 → 基准测试 → 控件事件 → 实时处理（主线程 / Worker）→ 截帧、导出 → 启动时加载示例图。
import { IMPLEMENTATIONS, JSProcessor, WASM_BUILDS, loadAllWasm } from './kernels.js';
import { LiveMeter, coverRect } from './live-stats.js';
import { EFFECTS, getEffect } from './effects.js';

const $ = id => document.getElementById(id);
const inputCanvas = $('input-canvas');     // 左侧：原始画面
const outputCanvas = $('output-canvas');   // 右侧：处理结果（主线程管线和基准测试用）
// willReadFrequently 提示浏览器把这块 Canvas 放在 CPU 内存里，频繁 getImageData 更快。
const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true });
const outputContext = outputCanvas.getContext('2d');
const video = $('video');
const names = IMPLEMENTATIONS;
// ---- 全局状态 ----
// sourceImage 当前图片源（示例图 / 上传图 / 视频截图），尺寸变化时用它重新绘制
// frame       基准测试使用的固定帧（ImageData）
// worker      正在运行的基准测试 Worker
// liveEngines 主线程管线用的引擎（JS + 各 Wasm），按尺寸缓存
// liveOutput  主线程管线的输出 ImageData，逐帧复用
// lastResult  最近一次测试结果，供“导出”使用
let sourceImage, frame, worker, liveEngines, liveOutput, lastResult;
// pipeline      Worker 管线对象 { worker, session, inFlight, ... }，整个页面只建一次
// liveStream    摄像头流；captureStream 从 <video> 捕获的流；workerTrack 转给 Worker 的轨道副本
// cancelFrame   取消下一次帧回调的函数；lastPresented 上次回调时视频已显示的帧数；liveKind 'main' | 'worker'
let pipeline, liveStream, captureStream, workerTrack, cancelFrame, lastPresented, liveKind;
let busy = false;      // 基准测试进行中（期间禁用大部分控件）
let playing = false;   // 实时处理进行中
let lastLiveStats = 0;
let liveTotals = { frames: 0, dropped: 0 };  // 本次实时处理累计帧数 / 掉帧数
const liveMeter = new LiveMeter();           // 主线程管线的计量器（Worker 管线有自己的）
// 两个“令牌”与 Worker 里的会话号同理：异步操作开始时记下当前值，
// 完成后若值已变（用户又点了别的），就丢弃这次结果，防止旧操作覆盖新状态。
let liveToken = 0;     // 实时处理的启动 / 停止
let sourceToken = 0;   // 图片加载、测试取消
let frameRevision = 0; // 固定帧每换一次加一，写进导出数据便于追溯
const history = [];    // 最近 8 次测试记录

// 读取界面上的测试参数。分辨率下拉框的值形如 "640x360"。
function config() {
  const [width, height] = $('resolution').value.split('x').map(Number);
  return { width, height, passes: Number($('passes').value), samples: Number($('samples').value), effect: $('effect').value };
}

// 底部状态栏文字；error 为 true 时显示为红色。
function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

// 进入 / 退出“测试中”状态：测试期间禁用会改变输入的控件，只留“停止”按钮。
function setBusy(value) {
  busy = value;
  $('run').disabled = value || !frame;
  $('cancel').hidden = !value;
  for (const id of ['resolution', 'passes', 'samples', 'effect', 'upload', 'capture', 'video-toggle', 'live-mode', 'live-source', 'live-pipeline']) {
    $(id).disabled = value || (id === 'capture' && !playing);
  }
  document.querySelector('.file-button').classList.toggle('disabled', value);
}

// 把图片 / 视频按当前分辨率居中裁剪画到输入 Canvas，再读出像素作为固定帧 frame。
function fitSource(source) {
  const { width, height } = config();
  inputCanvas.width = outputCanvas.width = width;
  inputCanvas.height = outputCanvas.height = height;
  // 截图和像素读取统一使用 Canvas 尺寸，避免原版缩放后仍读取原始视频尺寸。
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.max(width / sw, height / sh);
  inputContext.drawImage(source, (width - sw * scale) / 2, (height - sh * scale) / 2, sw * scale, sh * scale);
  frame = inputContext.getImageData(0, 0, width, height);
  outputContext.putImageData(frame, 0, 0);
  frameRevision++;
  $('run').disabled = busy;
}

function effectMeta(effect) {
  return `${effect.name} · ${effect.kind === 'convolution' ? '3×3 卷积 · 保留边界与 Alpha' : '颜色矩阵 · 保留 Alpha'}`;
}

// 清空结果区，回到“等待测试”。参数、效果或输入帧一变就调用，避免旧结果被误读。
function resetResults() {
  lastResult = undefined;
  $('export').disabled = true;
  for (const id of ['compute-ratio', 'total-ratio']) $(id).textContent = '--';
  $('compute-detail').textContent = $('total-detail').textContent = '等待采样';
  $('validation').textContent = '待校验';
  $('validation-detail').textContent = '逐字节比较';
  $('preview-meta').textContent = '等待测试';
  $('progress').style.width = '0%';
  $('test-meta').textContent = effectMeta(getEffect($('effect').value));
  $('bars').replaceChildren();
  $('result-note').textContent = '计时不包含模块加载与编译、视频解码和 Canvas 绘制。';
  $('result-rows').innerHTML = Object.entries(names).map(([id, name]) =>
    `<tr><td><span class="dot ${id}"></span>${name}</td><td colspan="6" class="empty">等待测试</td></tr>`).join('');
}

// 停止实时处理并把界面恢复到静态画面。可以重复调用，没在播放时调用也安全。
function stopVideo() {
  playing = false;
  liveToken++;  // 让还在进行中的启动流程失效
  cancelFrame?.();
  cancelFrame = undefined;
  if (pipeline) {
    pipeline.worker.postMessage({ type: 'stop' });
    pipeline.session = undefined;
  }
  // 释放本次打开的摄像头、captureStream 轨道和转给 Worker 的轨道副本。
  for (const stream of [liveStream, captureStream]) stream?.getTracks().forEach(track => track.stop());
  workerTrack?.stop();
  liveStream = captureStream = workerTrack = undefined;
  video.pause();
  video.srcObject = null;
  video.hidden = true;
  inputCanvas.hidden = false;
  outputCanvas.hidden = false;
  $('live-canvas').hidden = true;
  // 实时视频会改写输入 Canvas；暂停后还原固定截图，避免预览与基准输入不一致。
  if (frame) inputContext.putImageData(frame, 0, 0);
  $('video-toggle').innerHTML = '<i data-lucide="video"></i>开始实时';
  $('capture').disabled = true;
  $('video-toggle').disabled = busy;
  $('live-state').textContent = '实时处理已停止';
  window.lucide?.createIcons();
}

// 渲染基准测试结果：表格、加速比卡片、柱状图、输出预览和历史记录。
// result 来自 benchmark-worker.js，rows 为每种实现的统计（compute / upload / download / total 各含 median、p95、min）。
function showResult(result) {
  // 导出用的完整记录：附带时间、浏览器、算法和构建信息，方便日后对比不同机器的结果。
  lastResult = { ...result, timestamp: new Date().toISOString(), userAgent: navigator.userAgent,
    frameRevision, source: $('source-name').textContent,
    algorithm: { id: result.config.effect, ...getEffect(result.config.effect),
      formula: 'clamp((sum + bias) >> shift, 0, 255); alpha preserved' },
    build: WASM_BUILDS.map(build => `${build.id}: ${build.source} -O3${build.simd ? ' SIMD128' : ''}`),
    timing: 'Worker; allocation, load, decode and Canvas excluded' };
  delete lastResult.output;  // 输出像素太大，不写进导出的 JSON
  // 顶部的加速比卡片固定比较 JavaScript 与 C++ SIMD。
  const js = result.rows.find(row => row.id === 'js');
  const simd = result.rows.find(row => row.id === 'simd');
  const ms = value => `${value.toFixed(3)} ms`;
  $('result-rows').innerHTML = result.rows.map(row => `<tr><td><span class="dot ${row.id}"></span>${names[row.id]}</td>
    <td>${ms(row.compute.median)}</td><td>${row.id === 'js' ? '—' : ms(row.upload.median)}</td>
    <td>${ms(row.download.median)}</td><td><b>${ms(row.total.median)}</b></td>
    <td>${ms(row.total.p95)}</td><td class="pass">完全一致</td></tr>`).join('');
  for (const [id, message] of Object.entries(result.loadErrors)) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = `${names[id]} 不可用：${message}`;
    tr.append(td);
    $('result-rows').append(tr);
  }
  const computeRatio = simd ? js.compute.median / simd.compute.median : null;
  const totalRatio = simd ? js.total.median / simd.total.median : null;
  $('compute-ratio').textContent = computeRatio ? `${computeRatio.toFixed(2)}×` : '不可用';
  $('total-ratio').textContent = totalRatio ? `${totalRatio.toFixed(2)}×` : '不可用';
  $('compute-detail').textContent = simd ? `${ms(js.compute.median)} → ${ms(simd.compute.median)}` : 'SIMD 模块未加载';
  $('total-detail').textContent = simd ? `${ms(js.total.median)} → ${ms(simd.total.median)}` : '标量结果见下表';
  $('validation').textContent = '完全一致';
  $('validation-detail').textContent = `${(js.check.bytes / 4).toLocaleString()} 像素 · 最大通道误差 0`;
  const { width, height, passes, samples } = result.config;
  const effect = getEffect(result.config.effect);
  $('test-meta').textContent = `${effect.name} · ${width} × ${height} · ${passes} 轮 · ${samples} 批 × ${result.batchSize} 次 · 预热 ${result.warmup} 次`;
  // 同一算法、同一内存布局下，两种源语言编译器的差距：AssemblyScript 耗时 ÷ C++ 耗时。
  const pair = (as, cpp) => {
    const a = result.rows.find(row => row.id === as);
    const c = result.rows.find(row => row.id === cpp);
    return a && c ? (a.compute.median / c.compute.median).toFixed(2) : '--';
  };
  $('result-note').textContent = `AssemblyScript ÷ C++ 计算耗时：标量 ${pair('as-scalar', 'scalar')}×，SIMD ${pair('as-simd', 'simd')}×（大于 1 表示 AS 更慢）。` +
    '耗时为每批的单次均值，P95 为批均值 P95。总耗时含输入复制、计算和输出复制；分项中位数之和不一定等于总中位数。加速比小于 1 表示 Wasm 更慢。';
  const max = Math.max(...result.rows.map(row => row.total.median));
  $('bars').innerHTML = result.rows.map(row => `<div class="bar-row"><span>${names[row.id]}</span><div class="bar-track"><div class="bar-fill ${row.id}" style="width:${row.total.median / max * 100}%"></div></div><span class="bar-value">${ms(row.total.median)}</span></div>`).join('');
  outputContext.putImageData(new ImageData(new Uint8ClampedArray(result.output), width, height), 0, 0);
  $('preview-meta').textContent = `${effect.name} ${passes} 轮 · ${result.rows.length} 种实现输出一致`;
  history.unshift({ time: new Date().toLocaleTimeString(), effect: effect.name, width, height, passes, computeRatio, totalRatio, result: lastResult });
  history.splice(8);
  $('history').innerHTML = history.map((row, index) => `<tr><td>${row.time}</td><td>${row.effect}</td><td>${row.width} × ${row.height}</td><td>${row.passes}</td><td>${row.computeRatio?.toFixed(2) ?? '--'}×</td><td>${row.totalRatio?.toFixed(2) ?? '--'}×</td><td class="pass">通过</td><td><button class="icon-button" data-history="${index}" title="导出这次测试的原始数据" aria-label="导出 ${row.time} 的原始数据"><i data-lucide="download"></i></button></td></tr>`).join('');
  window.lucide?.createIcons();
  $('export').disabled = false;
  status('测试完成');
}

// ---- 基准测试 ----
// “开始测试”：新建 benchmark-worker，把固定帧发过去，接收进度和结果。
$('run').addEventListener('click', () => {
  if (busy || !frame) return;
  // 视频正在播放时，测的是此刻画面，而不是之前的示例图片或旧截图。
  if (playing) captureVideoFrame();
  else stopVideo();
  resetResults();
  setBusy(true);
  status('加载计算模块与校验像素…');
  // 只把截图的副本转移到 Worker，保留主线程中的原始预览。
  const buffer = frame.data.slice().buffer;
  worker = new Worker(new URL('./benchmark-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      // 进度条：预热占前 20%，采样占后 80%。
      status(`${data.phase} ${data.done} / ${data.total}`);
      const progress = data.phase === '预热' ? data.done / data.total * 20 : 20 + data.done / data.total * 80;
      $('progress').style.width = `${progress}%`;
    } else {
      worker.terminate();
      worker = undefined;
      setBusy(false);
      if (data.type === 'error') {
        status(data.message, true);
        $('validation').textContent = '未通过';
      } else showResult(data);
    }
  };
  worker.onerror = event => {
    worker?.terminate();
    worker = undefined;
    setBusy(false);
    status(`测试失败：${event.message}`, true);
  };
  // [buffer] 表示转移所有权：像素直接移交给 Worker，不复制，主线程这边的 buffer 随即变为空。
  worker.postMessage({ ...config(), buffer }, [buffer]);
});

// “停止”：直接终止 Worker，计算立即中断。
$('cancel').addEventListener('click', () => {
  sourceToken++;
  worker?.terminate();
  worker = undefined;
  setBusy(false);
  status('已停止，本次未生成结果');
  $('progress').style.width = '0%';
});

// 实时实现下拉框与基准表格都由实现清单生成，新增一种 Wasm 构建只需改 kernels.js。
$('live-mode').innerHTML = '<option value="none">原始画面</option>' + Object.entries(names).map(([id, name]) =>
  `<option value="${id}"${id === 'simd' ? ' selected' : ''}>${name}</option>`).join('');

// 效果下拉框由效果表生成；切换效果不打断实时处理，直接下发给正在运行的管线。
$('effect').innerHTML = Object.entries(EFFECTS).map(([id, effect]) =>
  `<option value="${id}" title="${effect.note}">${effect.name}</option>`).join('');
resetResults();
$('effect').addEventListener('change', () => {
  resetResults();
  const effect = getEffect($('effect').value);
  if (liveEngines) for (const id of Object.keys(names)) liveEngines[id]?.setEffect(effect);
  if (playing && liveKind === 'worker') pipeline.worker.postMessage({ type: 'effect', effect: $('effect').value });
  if (playing) {
    resetLiveStats();
    lastLiveStats = performance.now();
    $('preview-meta').textContent = `${effect.name} · ${liveKind === 'worker' ? 'Worker' : '主线程'}`;
  }
  status(`效果：${effect.name}`);
});

// 分辨率 / 轮数 / 样本数变化：停止实时、按新尺寸重画输入，主线程引擎下次按新尺寸重建。
for (const id of ['resolution', 'passes', 'samples']) {
  $(id).addEventListener('change', () => {
    stopVideo();
    if (id === 'resolution' && sourceImage) fitSource(sourceImage);
    resetResults();
    liveEngines = undefined;
    status('参数已更新');
  });
}

// 上传本地图片作为固定帧。
$('upload').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || busy) return;
  const token = ++sourceToken;
  stopVideo();
  setBusy(true);
  status('正在读取图片…');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (token !== sourceToken) return;
    sourceImage = image;
    fitSource(image);
    resetResults();
    $('source-name').textContent = file.name;
    status('图片已载入');
  } catch {
    if (token === sourceToken) status('图片读取失败，请选择有效的图片文件', true);
  } finally {
    URL.revokeObjectURL(url);
    event.target.value = '';
    if (token === sourceToken) setBusy(false);
  }
});
// 上传按钮是 <label>，补上键盘回车 / 空格触发，方便无鼠标操作。
document.querySelector('.file-button').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!busy) $('upload').click(); }
});

// ---- 实时处理：主线程管线 ----
// 为主线程管线准备引擎（尺寸不变则复用）。返回 false 表示期间用户已取消。
async function prepareLive(token) {
  const { width, height } = config();
  if (liveEngines?.width === width && liveEngines?.height === height) return true;
  const { processors } = await loadAllWasm(new URL('../wasm/', import.meta.url), width, height);
  // 所有资源就绪后才提交，过期请求不能覆盖新尺寸的引擎。
  if (token !== liveToken) return false;
  if (!processors[$('live-mode').value] && $('live-mode').value !== 'js' && $('live-mode').value !== 'none') {
    $('live-mode').value = 'scalar';
  }
  liveEngines = { width, height, js: new JSProcessor(width, height), ...processors };
  for (const id of Object.keys(names)) liveEngines[id]?.setEffect(getEffect($('effect').value));
  liveOutput = outputContext.createImageData(width, height);
  return true;
}

// 优先按视频帧回调调度（可得到精确的 presentedFrames），不支持时退回 rAF。
function scheduleFrame(callback) {
  if (video.requestVideoFrameCallback) {
    const id = video.requestVideoFrameCallback(callback);
    return () => video.cancelVideoFrameCallback(id);
  }
  const id = requestAnimationFrame(callback);
  return () => cancelAnimationFrame(id);
}

// 视频帧回调相邻两次之间跳过的帧数即为掉帧。
function missedFrames(metadata) {
  const presented = metadata?.presentedFrames;
  const missed = presented !== undefined && lastPresented !== undefined ? Math.max(0, presented - lastPresented - 1) : 0;
  lastPresented = presented;
  return missed;
}

// 把一次统计汇总显示到实时面板（主线程管线和 Worker 管线共用）。
function renderLive(summary) {
  liveTotals.frames += summary.frames;
  liveTotals.dropped += summary.dropped;
  const ms = segment => segment.mean.toFixed(2);
  $('live-copy').textContent = ms(summary.copyIn);
  $('live-process').textContent = ms(summary.process);
  $('live-output').textContent = ms(summary.output);
  $('live-total').textContent = ms(summary.total);
  $('live-p95').textContent = summary.total.p95.toFixed(2);
  $('live-fps').textContent = summary.fps?.toFixed(1) ?? '--';
  const rate = liveTotals.dropped / (liveTotals.frames + liveTotals.dropped);
  $('live-drop').textContent = `${liveTotals.dropped} · ${(rate * 100).toFixed(1)}%`;
  $('live-path').textContent = summary.path;
  if (summary.fallbackReason) $('live-path').title = summary.fallbackReason;
}

function resetLiveStats() {
  liveMeter.reset();
  liveTotals = { frames: 0, dropped: 0 };
  lastPresented = undefined;
  for (const id of ['live-copy', 'live-process', 'live-output', 'live-total', 'live-p95', 'live-fps', 'live-drop', 'live-path']) {
    $(id).textContent = '--';
  }
  $('live-path').removeAttribute('title');
}

// 主线程对照管线：drawImage → getImageData → 滤镜 → putImageData，全部占用主线程。
function drawVideo(now, metadata) {
  if (!playing) return;
  liveMeter.drop(missedFrames(metadata));
  const { width, height, passes } = config();
  const start = performance.now();
  const rect = coverRect(video.videoWidth, video.videoHeight, width, height);
  inputContext.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
  const pixels = inputContext.getImageData(0, 0, width, height);
  const copied = performance.now();
  const mode = $('live-mode').value;
  const engine = liveEngines[mode];
  if (mode === 'none') liveOutput.data.set(pixels.data);
  else if (mode === 'js') liveOutput.data.set(engine.run(pixels.data, passes));
  else {
    if (!engine) { stopVideo(); status(`${names[mode]} 不可用，请选择其他实现`, true); return; }
    engine.prepare(pixels.data);
    liveOutput.data.set(engine.run(passes));
  }
  const processed = performance.now();
  outputContext.putImageData(liveOutput, 0, 0);
  const end = performance.now();
  liveMeter.add({ copyIn: copied - start, process: processed - copied, output: end - processed, total: end - start });
  if (end - lastLiveStats >= 500) {
    lastLiveStats = end;
    renderLive({ ...liveMeter.summary(), path: '主线程 Canvas' });
    liveMeter.next();
  }
  // 预约下一帧，形成循环；stopVideo 通过 cancelFrame 打断它。
  cancelFrame = scheduleFrame(drawVideo);
}

// ---- 实时处理：Worker 管线 ----
// 处理 pipeline-worker 发来的消息（协议见 pipeline-worker.js 开头）。
function onPipelineMessage({ data }) {
  if (data.type === 'caps') pipeline.resolveCaps(data);
  else if (data.type === 'started' || (data.type === 'error' && pipeline.pending)) {
    pipeline.pending?.(data);
    pipeline.pending = undefined;
  } else if (data.type === 'ready') {
    if (data.session === pipeline.session) pipeline.inFlight = false;
  } else if (data.type === 'stats') {
    if (playing && liveKind === 'worker') renderLive(data);
  } else if (data.type === 'error' && playing) {
    stopVideo();
    status(`实时管线错误：${data.message}`, true);
  }
}

// Worker 管线只创建一次：输出 Canvas 转为 OffscreenCanvas 后，主线程不再触碰像素。
function getPipeline() {
  if (pipeline) return pipeline;
  const worker = new Worker(new URL('./pipeline-worker.js', import.meta.url), { type: 'module' });
  pipeline = { worker, inFlight: false };
  pipeline.caps = new Promise(resolve => { pipeline.resolveCaps = resolve; });
  worker.onmessage = onPipelineMessage;
  worker.onerror = event => {
    if (playing) { stopVideo(); status(`实时管线错误：${event.message}`, true); }
  };
  const offscreen = $('live-canvas').transferControlToOffscreen();
  worker.postMessage({ type: 'init', canvas: offscreen }, [offscreen]);
  return pipeline;
}

// 发送 start 并等待 Worker 回复 started（成功）或 error（失败），把回复包装成 Promise。
function startPipeline(message, transfer) {
  return new Promise((resolve, reject) => {
    pipeline.pending = data => data.type === 'started' ? resolve(data) : reject(new Error(data.message));
    pipeline.worker.postMessage(message, transfer);
  });
}

// 回退路径：浏览器没有 MediaStreamTrackProcessor 时，主线程按视频帧回调构造 VideoFrame 并转移给 Worker，
// Worker 未处理完时直接跳过当前帧，掉帧数随下一帧带过去。
function sendFrames(token, session) {
  let missed = 0;
  const step = (now, metadata) => {
    if (token !== liveToken) return;
    missed += missedFrames(metadata);
    if (pipeline.inFlight) missed++;
    else {
      const frame = new VideoFrame(video);
      pipeline.inFlight = true;
      pipeline.worker.postMessage({ type: 'frame', frame, session, missed }, [frame]);
      missed = 0;
    }
    cancelFrame = scheduleFrame(step);
  };
  cancelFrame = scheduleFrame(step);
}

// 启动 Worker 管线。按浏览器能力选择帧来源，优先级：
//   1. 主线程有 MediaStreamTrackProcessor（Chrome）→ 在主线程建好帧流，转移给 Worker；
//   2. 只有 Worker 里有（Safari）→ 转移视频轨道，由 Worker 创建；
//   3. 都没有或轨道无法转移 → 主线程逐帧 new VideoFrame(video) 发过去（sendFrames）。
async function startWorkerPipeline(token) {
  const { width, height, passes } = config();
  const { mstp } = await getPipeline().caps;
  // 摄像头用 getUserMedia 的流；播放视频文件时用 captureStream() 把 <video> 变成一路媒体流。
  const stream = liveStream || video.captureStream?.() || video.mozCaptureStream?.();
  if (!liveStream && stream) captureStream = stream;
  const track = stream?.getVideoTracks()[0];
  const message = { type: 'start', width, height, passes, mode: $('live-mode').value, effect: $('effect').value,
    frameRate: track?.getSettings().frameRate };
  let source = 'frames';
  let transfer = [];
  if (track && window.MediaStreamTrackProcessor) {
    // Chrome：主线程创建处理器，只把 ReadableStream<VideoFrame> 转移给 Worker。
    workerTrack = track.clone();
    message.readable = new MediaStreamTrackProcessor({ track: workerTrack, maxBufferSize: 1 }).readable;
    transfer = [message.readable];
    source = 'MediaStreamTrackProcessor';
  } else if (track && mstp) {
    // Safari 等只在 Worker 中提供处理器：把轨道副本转移过去，在 Worker 内创建。
    workerTrack = track.clone();
    message.track = workerTrack;
    transfer = [workerTrack];
    source = 'MediaStreamTrackProcessor（Worker）';
  }
  let started;
  try {
    started = await startPipeline(message, transfer);
  } catch (error) {
    if (!message.track || error.name !== 'DataCloneError') throw error;
    // 轨道不可转移时退回逐帧转移。
    delete message.track;
    source = 'frames';
    started = await startPipeline(message, []);
  }
  if (token !== liveToken) return false;
  pipeline.session = started.session;
  pipeline.inFlight = false;
  // 选中的 Wasm 构建在本浏览器加载失败时（例如不支持 SIMD），退回 C++ 标量版。
  const mode = $('live-mode').value;
  if (mode !== 'js' && mode !== 'none' && !started.available.includes(mode)) {
    $('live-mode').value = 'scalar';
    pipeline.worker.postMessage({ type: 'mode', mode: 'scalar' });
  }
  if (source === 'frames') sendFrames(token, started.session);
  $('live-source-path').textContent = source === 'frames' ? '逐帧转移 VideoFrame' : source;
  return true;
}

// 打开实时画面来源：摄像头，或页面自带的示例视频（<video> 默认的 src）。
async function openSource(token) {
  if ($('live-source').value === 'camera') {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持摄像头');
    const { width, height } = config();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } } });
    if (token !== liveToken) { stream.getTracks().forEach(track => track.stop()); return false; }
    liveStream = stream;
    video.srcObject = stream;
  } else {
    video.srcObject = null;
  }
  await video.play();
  return token === liveToken;
}

// “开始实时 / 停止实时”按钮。启动顺序：准备引擎 → 打开画面源 → 启动所选管线 → 切换界面。
// 每个 await 之后都可能已被用户取消，所以各步骤都带 token 检查，失效即返回。
$('video-toggle').addEventListener('click', async () => {
  if (playing) { stopVideo(); return; }
  const token = ++liveToken;
  $('video-toggle').disabled = true;
  try {
    liveKind = $('live-pipeline').value;
    if (liveKind === 'main' && !await prepareLive(token)) return;
    if (!await openSource(token) || busy) return;
    resetLiveStats();
    lastLiveStats = performance.now();
    if (liveKind === 'worker') {
      if (!await startWorkerPipeline(token)) return;
      outputCanvas.hidden = true;
      $('live-canvas').hidden = false;
    } else {
      $('live-source-path').textContent = 'requestVideoFrameCallback';
    }
    playing = true;
    video.hidden = false;
    inputCanvas.hidden = true;
    $('video-toggle').innerHTML = '<i data-lucide="pause"></i>停止实时';
    $('capture').disabled = false;
    $('live-state').textContent = $('live-source').value === 'camera' ? '摄像头实时处理中' : '视频实时处理中';
    $('preview-meta').textContent = `${getEffect($('effect').value).name} · ${liveKind === 'worker' ? 'Worker' : '主线程'}`;
    if (liveKind === 'main') cancelFrame = scheduleFrame(drawVideo);
    window.lucide?.createIcons();
  } catch (error) {
    if (token === liveToken) {
      status(`实时处理启动失败：${error.message}`, true);
      stopVideo();
    }
  } finally {
    if (token === liveToken) $('video-toggle').disabled = busy;
  }
});

// 运行中切换实现：Worker 管线发消息通知；主线程管线下一帧会自己读下拉框的新值。
$('live-mode').addEventListener('change', () => {
  if (playing && liveKind === 'worker') pipeline.worker.postMessage({ type: 'mode', mode: $('live-mode').value });
  resetLiveStats();
  lastLiveStats = performance.now();
});

// 换画面来源或换管线需要重新启动，这里只负责停下。
for (const id of ['live-source', 'live-pipeline']) {
  $(id).addEventListener('change', () => { if (playing) stopVideo(); });
}

// 截取视频当前画面作为固定帧，并停止实时处理；“截取当前帧”和“开始测试”共用。
function captureVideoFrame() {
  const label = video.srcObject ? '摄像头截帧' : `视频截帧 ${video.currentTime.toFixed(2)}s`;
  fitSource(video);
  stopVideo();
  // 同步保留截图，避免异步图片解码期间发生参数切换。
  const snapshot = document.createElement('canvas');
  snapshot.width = inputCanvas.width;
  snapshot.height = inputCanvas.height;
  snapshot.getContext('2d').drawImage(inputCanvas, 0, 0);
  sourceImage = snapshot;
  resetResults();
  $('source-name').textContent = label;
}

$('capture').addEventListener('click', () => {
  if (!playing) return;
  captureVideoFrame();
  status('已截取固定帧');
});

// ---- 导出 ----
// 把测试记录存成 JSON 文件下载：生成临时 Blob 链接，模拟点击，稍后释放。
function exportResult(result) {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rgba-benchmark-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export').addEventListener('click', () => exportResult(lastResult));
$('history').addEventListener('click', event => {
  const button = event.target.closest('[data-history]');
  if (button) exportResult(history[Number(button.dataset.history)].result);
});

document.addEventListener('visibilitychange', () => {
  // 后台调度会污染性能样本，切到后台时停止测试和视频。
  if (document.hidden && busy) $('cancel').click();
  if (document.hidden && playing) stopVideo();
});

// ---- 启动 ----
// 页面打开时加载示例图片作为默认固定帧（模块脚本支持顶层 await）。
// 若加载期间用户已上传了自己的图片（sourceToken 变了），就不要用示例图覆盖它。
try {
  const token = sourceToken;
  const image = new Image();
  image.src = new URL('../assets/sample.jpg', import.meta.url).href;
  await image.decode();
  if (token !== sourceToken) throw new Error('initial-load-superseded');
  sourceImage = image;
  fitSource(sourceImage);
  status('就绪');
  window.lucide?.createIcons();
} catch (error) {
  if (error.message !== 'initial-load-superseded' && !busy) status('示例图片加载失败，可以选择本地图片', true);
}
