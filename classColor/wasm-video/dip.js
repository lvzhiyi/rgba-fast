import { JSProcessor, loadWasm } from './kernels.js';

const $ = id => document.getElementById(id);
const inputCanvas = $('input-canvas');
const outputCanvas = $('output-canvas');
const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true });
const outputContext = outputCanvas.getContext('2d');
const video = $('video');
const names = { js: 'JavaScript', scalar: 'Wasm · 标量', simd: 'Wasm · SIMD128' };
let sourceImage, frame, worker, liveEngines, liveOutput, previousTime, lastResult;
let busy = false;
let playing = false;
let animation;
let liveRecords = [];
let liveToken = 0;
let sourceToken = 0;
let frameRevision = 0;
const history = [];

function config() {
  const [width, height] = $('resolution').value.split('x').map(Number);
  return { width, height, passes: Number($('passes').value), samples: Number($('samples').value) };
}

function status(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}

function setBusy(value) {
  busy = value;
  $('run').disabled = value || !frame;
  $('cancel').hidden = !value;
  for (const id of ['resolution', 'passes', 'samples', 'upload', 'capture', 'video-toggle', 'live-mode']) {
    $(id).disabled = value || (id === 'capture' && !playing);
  }
  document.querySelector('.file-button').classList.toggle('disabled', value);
}

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

function resetResults() {
  lastResult = undefined;
  $('export').disabled = true;
  for (const id of ['compute-ratio', 'total-ratio']) $(id).textContent = '--';
  $('compute-detail').textContent = $('total-detail').textContent = '等待采样';
  $('validation').textContent = '待校验';
  $('validation-detail').textContent = '逐字节比较';
  $('preview-meta').textContent = '等待测试';
  $('progress').style.width = '0%';
  $('test-meta').textContent = '3×3 均值模糊 · 保留边界与 Alpha';
  $('bars').replaceChildren();
  $('result-rows').innerHTML = Object.entries(names).map(([id, name]) =>
    `<tr><td><span class="dot ${id}"></span>${name}</td><td colspan="6" class="empty">等待测试</td></tr>`).join('');
}

function stopVideo() {
  playing = false;
  liveToken++;
  cancelAnimationFrame(animation);
  video.pause();
  video.hidden = true;
  inputCanvas.hidden = false;
  // 实时视频会改写输入 Canvas；暂停后还原固定截图，避免预览与基准输入不一致。
  if (frame) inputContext.putImageData(frame, 0, 0);
  $('video-toggle').innerHTML = '<i data-lucide="video"></i>播放视频';
  $('capture').disabled = true;
  $('video-toggle').disabled = busy;
  $('live-state').textContent = '视频已暂停';
  previousTime = undefined;
  liveRecords = [];
  window.lucide?.createIcons();
}

function showResult(result) {
  lastResult = { ...result, timestamp: new Date().toISOString(), userAgent: navigator.userAgent,
    frameRevision, source: $('source-name').textContent,
    algorithm: '3x3 integer box blur; preserve border and alpha',
    build: 'Clang -O3; scalar / explicit SIMD128',
    timing: 'Worker; allocation, load, decode and Canvas excluded' };
  delete lastResult.output;
  const js = result.rows.find(row => row.id === 'js');
  const simd = result.rows.find(row => row.id === 'simd');
  const ms = value => `${value.toFixed(3)} ms`;
  $('result-rows').innerHTML = result.rows.map(row => `<tr><td><span class="dot ${row.id}"></span>${names[row.id]}</td>
    <td>${ms(row.compute.median)}</td><td>${row.id === 'js' ? '—' : ms(row.upload.median)}</td>
    <td>${ms(row.download.median)}</td><td><b>${ms(row.total.median)}</b></td>
    <td>${ms(row.total.p95)}</td><td class="pass">完全一致</td></tr>`).join('');
  if (result.simdError) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.textContent = `SIMD 不可用：${result.simdError}`;
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
  $('test-meta').textContent = `${width} × ${height} · ${passes} 轮 · ${samples} 批 × ${result.batchSize} 次 · 预热 ${result.warmup} 次`;
  $('result-note').textContent = '耗时为每批的单次均值，P95 为批均值 P95。总耗时含输入复制、计算和输出复制；分项中位数之和不一定等于总中位数。加速比小于 1 表示 Wasm 更慢。';
  const max = Math.max(...result.rows.map(row => row.total.median));
  $('bars').innerHTML = result.rows.map(row => `<div class="bar-row"><span>${names[row.id]}</span><div class="bar-track"><div class="bar-fill ${row.id}" style="width:${row.total.median / max * 100}%"></div></div><span class="bar-value">${ms(row.total.median)}</span></div>`).join('');
  outputContext.putImageData(new ImageData(new Uint8ClampedArray(result.output), width, height), 0, 0);
  $('preview-meta').textContent = `${passes} 轮模糊 · ${simd ? '三种' : '两种'}输出一致`;
  history.unshift({ time: new Date().toLocaleTimeString(), width, height, passes, computeRatio, totalRatio, result: lastResult });
  history.splice(8);
  $('history').innerHTML = history.map((row, index) => `<tr><td>${row.time}</td><td>${row.width} × ${row.height}</td><td>${row.passes}</td><td>${row.computeRatio?.toFixed(2) ?? '--'}×</td><td>${row.totalRatio?.toFixed(2) ?? '--'}×</td><td class="pass">通过</td><td><button class="icon-button" data-history="${index}" title="导出这次测试的原始数据" aria-label="导出 ${row.time} 的原始数据"><i data-lucide="download"></i></button></td></tr>`).join('');
  window.lucide?.createIcons();
  $('export').disabled = false;
  status('测试完成');
}

$('run').addEventListener('click', () => {
  if (busy || !frame) return;
  stopVideo();
  resetResults();
  setBusy(true);
  status('加载计算模块与校验像素…');
  // 只把截图的副本转移到 Worker，保留主线程中的原始预览。
  const buffer = frame.data.slice().buffer;
  worker = new Worker(new URL('./benchmark-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
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
  worker.postMessage({ ...config(), buffer }, [buffer]);
});

$('cancel').addEventListener('click', () => {
  sourceToken++;
  worker?.terminate();
  worker = undefined;
  setBusy(false);
  status('已停止，本次未生成结果');
  $('progress').style.width = '0%';
});

for (const id of ['resolution', 'passes', 'samples']) {
  $(id).addEventListener('change', () => {
    stopVideo();
    if (id === 'resolution' && sourceImage) fitSource(sourceImage);
    resetResults();
    liveEngines = undefined;
    status('参数已更新');
  });
}

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
document.querySelector('.file-button').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!busy) $('upload').click(); }
});

async function prepareLive(token) {
  const { width, height } = config();
  if (liveEngines?.width === width && liveEngines?.height === height) return true;
  const scalar = await loadWasm(new URL('./operations/benchmark-scalar.wasm', import.meta.url), width, height);
  if (token !== liveToken) return false;
  let simd;
  try {
    simd = await loadWasm(new URL('./operations/benchmark-simd.wasm', import.meta.url), width, height);
  } catch {
    if (token === liveToken && $('live-mode').value === 'simd') $('live-mode').value = 'scalar';
  }
  // 所有资源就绪后才提交，过期请求不能覆盖新尺寸的引擎。
  if (token !== liveToken) return false;
  liveEngines = { width, height, js: new JSProcessor(width, height), scalar, simd };
  liveOutput = outputContext.createImageData(width, height);
  return true;
}

function drawVideo(now) {
  if (!playing) return;
  const start = performance.now();
  const { width, height, passes } = config();
  inputContext.drawImage(video, 0, 0, width, height);
  const pixels = inputContext.getImageData(0, 0, width, height);
  const filterStart = performance.now();
  const mode = $('live-mode').value;
  const engine = liveEngines[mode];
  if (mode === 'none') liveOutput.data.set(pixels.data);
  else if (mode === 'js') liveOutput.data.set(engine.run(pixels.data, passes));
  else {
    if (!engine) { stopVideo(); status('当前浏览器无法使用 SIMD，请选择标量模式', true); return; }
    engine.prepare(pixels.data);
    liveOutput.data.set(engine.run(passes));
  }
  const filterEnd = performance.now();
  outputContext.putImageData(liveOutput, 0, 0);
  const end = performance.now();
  // 实际 FPS 使用相邻回调间隔，另列滤镜耗时及包含 Canvas 操作的整帧耗时。
  liveRecords.push({ filter: filterEnd - filterStart, frame: end - start,
    interval: previousTime === undefined ? null : now - previousTime });
  previousTime = now;
  if (liveRecords.length >= 15) {
    const mean = key => liveRecords.reduce((sum, row) => sum + row[key], 0) / liveRecords.length;
    const intervals = liveRecords.filter(row => row.interval !== null);
    $('live-filter').textContent = mean('filter').toFixed(2);
    $('live-frame').textContent = mean('frame').toFixed(2);
    $('live-fps').textContent = intervals.length ? (1000 * intervals.length / intervals.reduce((sum, row) => sum + row.interval, 0)).toFixed(1) : '--';
    liveRecords = [];
  }
  animation = requestAnimationFrame(drawVideo);
}

$('video-toggle').addEventListener('click', async () => {
  if (playing) { stopVideo(); return; }
  const token = ++liveToken;
  $('video-toggle').disabled = true;
  try {
    if (!await prepareLive(token)) return;
    await video.play();
    if (token !== liveToken || busy) return;
    playing = true;
    video.hidden = false;
    inputCanvas.hidden = true;
    $('video-toggle').innerHTML = '<i data-lucide="pause"></i>暂停视频';
    $('capture').disabled = false;
    $('live-state').textContent = '视频播放中';
    $('preview-meta').textContent = '实时滤镜';
    animation = requestAnimationFrame(drawVideo);
    window.lucide?.createIcons();
  } catch (error) {
    if (token === liveToken) {
      status(`视频启动失败：${error.message}`, true);
      stopVideo();
    }
  } finally {
    if (token === liveToken) $('video-toggle').disabled = busy;
  }
});

$('live-mode').addEventListener('change', () => {
  previousTime = undefined;
  liveRecords = [];
  for (const id of ['live-filter', 'live-frame', 'live-fps']) $(id).textContent = '--';
});

$('capture').addEventListener('click', () => {
  if (!playing) return;
  fitSource(video);
  stopVideo();
  // 同步保留截图，避免异步图片解码期间发生参数切换。
  const snapshot = document.createElement('canvas');
  snapshot.width = inputCanvas.width;
  snapshot.height = inputCanvas.height;
  snapshot.getContext('2d').drawImage(inputCanvas, 0, 0);
  sourceImage = snapshot;
  resetResults();
  $('source-name').textContent = `视频截帧 ${video.currentTime.toFixed(2)}s`;
  status('已截取固定帧');
});

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

try {
  const token = sourceToken;
  const image = new Image();
  image.src = new URL('../../img/1.jpg', import.meta.url).href;
  await image.decode();
  if (token !== sourceToken) throw new Error('initial-load-superseded');
  sourceImage = image;
  fitSource(sourceImage);
  status('就绪');
  window.lucide?.createIcons();
} catch (error) {
  if (error.message !== 'initial-load-superseded' && !busy) status('示例图片加载失败，可以选择本地图片', true);
}
