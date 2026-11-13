import { getEffect } from './effects.ts';
import { IMPLEMENTATIONS, JSProcessor, loadAllWasm } from './kernels.ts';
import { coverRect, LiveMeter } from './live-stats.ts';
import { wasmUrls } from './wasm-assets.ts';
import type { ImplementationId, WasmProcessors } from './kernels.ts';
import type { CaptureVideoElement, TrackProcessorScope } from './media-types.ts';
import type { LiveView } from './ui-types.ts';
import type { LiveConfig, LiveMode, LiveStats, PipelineKind, PipelineMessage, PipelineRequest, PipelineStart, PipelineStarted } from './worker-protocol.ts';

/** 实时控制器依赖的媒体元素和界面回调，负责获取画布、回报状态及恢复静态预览。 */
type LiveVideoOptions = {
  /** 播放示例视频或摄像头画面，也是主线程取帧和截帧的来源。 */
  video: CaptureVideoElement;
  /** 显示原始固定帧。主线程实时管线也在这里绘制视频并读回 RGBA 像素。 */
  inputCanvas: HTMLCanvasElement;
  /** 显示主线程滤镜结果，与固定帧基准共用。 */
  outputCanvas: HTMLCanvasElement;
  /** 获取当前 Worker 输出画布，用于转成 OffscreenCanvas 并交给 Worker。 */
  getWorkerCanvas: () => HTMLCanvasElement;
  /** Worker 出错后请 React 创建新画布。已转移过的画布无法再次转移。 */
  replaceWorkerCanvas: () => void;
  /** 停止实时处理时，将保存的固定帧重新绘制到输入画布。 */
  restoreInput: () => void;
  /** 通知页面合并播放状态或统计更新。回退到其他滤镜实现时用 mode 同步下拉框。 */
  onChange: (state: Partial<LiveView> & { mode?: LiveMode }) => void;
  /** 将启动或处理错误的文案交给页面状态栏。 */
  onError: (message: string) => void;
};

/** 一次实时播放的资源和统计状态。会话身份用于识别过期异步操作。 */
type Session = {
  /** 本次播放使用的管线，main 在主线程处理，worker 在实时 Worker 中处理。 */
  kind: PipelineKind;
  /** 本次会话的阶段，starting 表示准备中，playing 表示已开始处理。 */
  phase: 'starting' | 'playing';
  /** 上次视频帧回调的累计已呈现帧数，用于估算两次回调间跳过的帧。 */
  lastPresented?: number;
  /** 主线程管线最近一次上报或重置统计的 performance.now() 时间，单位为毫秒。 */
  lastReport: number;
  /** 自上次重置统计以来累计处理的帧数，用于计算掉帧率。 */
  frames: number;
  /** 自上次重置统计以来累计掉帧数，与 frames 一起计算掉帧率。 */
  dropped: number;
  /** 通过 getUserMedia 打开的摄像头流，停止会话时关闭其中的轨道。 */
  camera?: MediaStream;
  /** 从示例视频元素捕获的流，用于向 Worker 供帧，停止会话时关闭其中的轨道。 */
  capture?: MediaStream;
  /** 仍由主线程持有的轨道副本。直接转移轨道成功后清空，由 Worker 接管释放。 */
  track?: MediaStreamTrack;
  /** Worker 确认启动时返回的编号，用来匹配发出的帧和收到的回执。 */
  workerSession?: number;
  /** 取消下一次已预约的视频帧或动画帧回调，由停止会话时调用。 */
  cancelFrame?: () => void;
  /** 逐帧转移时，上一帧已发送且仍在等待 Worker 的 ready 回执。 */
  inFlight?: boolean;
};

/** 可跨会话复用的实时 Worker，保存能力探测结果和等待中的启动回执。 */
type Pipeline = {
  worker: Worker;
  caps: Promise<{ mstp: boolean }>;
  pending?: { resolve: (data: PipelineStarted) => void; reject: (error: Error) => void };
};

/** 主线程管线按宽高缓存的滤镜实现，包含 TypeScript 和已加载的 Wasm 处理器。 */
type MainEngines = WasmProcessors & { width: number; height: number; js: JSProcessor };

// 协调主线程 Canvas 和 Worker VideoFrame 两条实时管线。
// 帧处理留在各自管线内，React 只接收会话状态和定期汇总。
export function createLiveVideo({ video, inputCanvas, outputCanvas, getWorkerCanvas, onChange, onError, restoreInput, replaceWorkerCanvas }: LiveVideoOptions) {
  const meter = new LiveMeter();
  let pipeline: Pipeline | undefined;
  // 用会话对象的身份校验异步结果，防止旧的权限请求或 Worker 消息影响新会话。
  let active: Session | undefined;
  // 主线程引擎按分辨率缓存，输出 ImageData 逐帧复用。
  let engines: MainEngines | undefined;
  let output: ImageData;
  let settings: LiveConfig;

  // 开始播放或切换效果、实现时重新统计，避免混入上一配置的耗时。
  function resetStats(session: Session) {
    meter.reset();
    session.lastPresented = undefined;
    session.lastReport = performance.now();
    session.frames = session.dropped = 0;
    onChange({ stats: null });
  }

  // 分段耗时按窗口汇报，掉帧率按上次重置以来的总帧数计算。
  function report(session: Session, summary: LiveStats) {
    session.frames += summary.frames;
    session.dropped += summary.dropped;
    onChange({ stats: { ...summary, dropped: session.dropped,
      dropRate: session.dropped / (session.frames + session.dropped) } });
  }

  // 先使会话失效，再取消帧回调、停止媒体轨道并恢复固定帧预览。
  function stop() {
    const session = active;
    if (!session) return;
    active = undefined;
    session.cancelFrame?.();
    if (pipeline) {
      // Worker 可能仍在准备引擎。主动结束等待，旧启动流程即可退出。
      pipeline.pending?.reject(new Error('实时处理已停止'));
      pipeline.pending = undefined;
      pipeline.worker.postMessage({ type: 'stop' } satisfies PipelineRequest);
    }
    for (const stream of [session.camera, session.capture]) stream?.getTracks().forEach(track => track.stop());
    // 成功转移给 Worker 的轨道由 Worker 释放。
    session.track?.stop();
    video.pause();
    video.srcObject = null;
    restoreInput();
    onChange({ phase: 'idle' });
  }

  // 实时管线遇到错误时先释放当前会话，再由页面显示错误信息。
  function fail(error: string) {
    stop();
    onError(error);
  }

  // 优先使用视频帧回调获取 presentedFrames。旧浏览器回退到动画帧回调。
  function schedule(session: Session, callback: (now: number, metadata?: VideoFrameCallbackMetadata) => void) {
    if (video.requestVideoFrameCallback) {
      const id = video.requestVideoFrameCallback(callback);
      session.cancelFrame = () => video.cancelVideoFrameCallback(id);
    } else {
      const id = requestAnimationFrame(callback);
      session.cancelFrame = () => cancelAnimationFrame(id);
    }
  }

  // 相邻两次回调之间跳过的已呈现帧记为掉帧。
  function missedFrames(session: Session, metadata?: VideoFrameCallbackMetadata) {
    const presented = metadata?.presentedFrames;
    const previous = session.lastPresented;
    session.lastPresented = presented;
    return presented !== undefined && previous !== undefined ? Math.max(0, presented - previous - 1) : 0;
  }

  // 尺寸变化时重建 JS / Wasm 引擎和输出缓冲区，并将效果应用到所有实现。
  async function prepareMain(session: Session) {
    const { width, height } = settings;
    if (engines?.width !== width || engines?.height !== height) {
      const { processors } = await loadAllWasm(wasmUrls, width, height);
      if (active !== session) return;
      engines = { width, height, js: new JSProcessor(width, height), ...processors };
      output = outputCanvas.getContext('2d')!.createImageData(width, height);
    }
    applyMainEffect();
    if (settings.mode !== 'none' && !engines?.[settings.mode]) selectMode('scalar');
  }

  // 同步更新主线程全部引擎，切换实现时可以直接沿用当前效果。
  function applyMainEffect() {
    const effect = getEffect(settings.effect);
    for (const id of Object.keys(IMPLEMENTATIONS) as ImplementationId[]) engines?.[id]?.setEffect(effect);
  }

  // 主线程对照管线：裁剪、读像素、应用滤镜、写回 Canvas，再预约下一帧。
  function runMain(session: Session) {
    const current = engines!;
    const inputContext = inputCanvas.getContext('2d', { willReadFrequently: true })!;
    const outputContext = outputCanvas.getContext('2d')!;
    const draw = (_now: number, metadata?: VideoFrameCallbackMetadata) => {
      if (active !== session) return;
      meter.drop(missedFrames(session, metadata));
      const { width, height, passes, mode } = settings;
      const start = performance.now();
      const rect = coverRect(video.videoWidth, video.videoHeight, width, height);
      inputContext.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height);
      const pixels = inputContext.getImageData(0, 0, width, height);
      // 取帧计时包含 drawImage 和 getImageData。此后进入处理阶段，主线程的 Wasm 输入复制计入这一阶段。
      const copied = performance.now();
      if (mode === 'none') output.data.set(pixels.data);
      else if (mode === 'js') output.data.set(current.js.run(pixels.data, passes));
      else {
        const engine = current[mode];
        if (!engine) { fail(`${IMPLEMENTATIONS[mode]} 不可用，请选择其他实现`); return; }
        engine.prepare(pixels.data);
        output.data.set(engine.run(passes));
      }
      // 处理与输出的分界。输出阶段只计 putImageData。
      const processed = performance.now();
      outputContext.putImageData(output, 0, 0);
      const end = performance.now();
      meter.add({ copyIn: copied - start, process: processed - copied, output: end - processed, total: end - start });
      // 每 500 ms 才向页面报告一次，帧回调无需逐帧触发 React 渲染。
      if (end - session.lastReport >= 500) {
        session.lastReport = end;
        const summary = meter.summary();
        if (summary) report(session, { ...summary, path: '主线程 Canvas' });
        meter.next();
      }
      schedule(session, draw);
    };
    schedule(session, draw);
  }

  // 按需创建并复用 Worker。OffscreenCanvas 转移后，输出像素由 Worker 绘制。
  function getPipeline() {
    if (pipeline) return pipeline;
    const canvas = getWorkerCanvas();
    if (!canvas.transferControlToOffscreen) throw new Error('当前浏览器不支持 OffscreenCanvas');
    const worker = new Worker(new URL('./pipeline-worker.ts', import.meta.url), { type: 'module' });
    const current: Pipeline = { worker, caps: new Promise((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<PipelineMessage>) => {
        // caps 用于能力探测，started/error 结束启动等待，ready/stats 只作用于对应会话。
        if (data.type === 'caps') resolve(data);
        else if (data.type === 'started' || (data.type === 'error' && current.pending)) {
          const pending = current.pending;
          current.pending = undefined;
          if (data.type === 'started') pending?.resolve(data);
          else pending?.reject(new Error(data.message));
        } else if (active?.phase === 'playing' && active.workerSession === data.session) {
          if (data.type === 'ready') active.inFlight = false;
          else if (data.type === 'stats') report(active, data);
          else if (data.type === 'error') fail(`实时管线错误：${data.message}`);
        }
      };
      worker.onerror = event => {
        const error = new Error(event.message || '无法加载实时 Worker');
        reject(error);
        current.pending?.reject(error);
        worker.terminate();
        pipeline = undefined;
        // 转移过的 Canvas 无法绑定新 Worker，故障时让 React 创建新的画布。
        replaceWorkerCanvas();
        if (active?.kind === 'worker') fail(`实时管线错误：${error.message}`);
      };
    }) };
    try {
      const offscreen = canvas.transferControlToOffscreen();
      worker.postMessage({ type: 'init', canvas: offscreen } satisfies PipelineRequest, [offscreen]);
    } catch (error) {
      worker.terminate();
      replaceWorkerCanvas();
      throw error;
    }
    pipeline = current;
    return current;
  }

  // 发送启动配置和可转移资源，等待 Worker 返回会话号和可用实现。
  function startWorker(current: Pipeline, session: Session, message: PipelineStart, transfer: Transferable[]) {
    return new Promise<PipelineStarted>((resolve, reject) => {
      current.worker.postMessage(message, transfer);
      if (message.track) session.track = undefined;
      current.pending = { resolve, reject };
    });
  }

  // 无帧流时逐帧转移。上一帧仍在 Worker 处理时，直接跳过当前帧。
  function sendFrames(session: Session, worker: Worker, workerSession: number) {
    let missed = 0;
    const step = (_now: number, metadata?: VideoFrameCallbackMetadata) => {
      if (active !== session) return;
      missed += missedFrames(session, metadata);
      if (session.inFlight) missed++;
      else {
        let frame: VideoFrame | undefined;
        try {
          frame = new VideoFrame(video);
          session.inFlight = true;
          // 发送成功后由 Worker 关闭帧，转移失败时由发送方关闭。
          worker.postMessage({ type: 'frame', frame, session: workerSession, missed } satisfies PipelineRequest, [frame]);
        } catch (error) {
          frame?.close();
          fail(`实时管线错误：${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        missed = 0;
      }
      schedule(session, step);
    };
    schedule(session, step);
  }

  // 按浏览器能力选择取帧方式：优先转移帧流，其次转移轨道，最后回退到逐帧转移 VideoFrame。
  async function runWorker(session: Session) {
    const current = getPipeline();
    const { mstp } = await current.caps;
    if (active !== session) return;
    // 摄像头已有媒体流，示例视频则从 video 元素捕获一条流。
    if (!session.camera) session.capture = video.captureStream?.() || video.mozCaptureStream?.();
    const track = (session.camera || session.capture)?.getVideoTracks()[0];
    const { width, height, passes, mode, effect } = settings;
    const message: PipelineStart = { type: 'start', width, height, passes, mode, effect, frameRate: track?.getSettings().frameRate };
    let transfer: Transferable[] = [];
    let sourcePath = '逐帧转移 VideoFrame';
    const TrackProcessor = (window as Window & TrackProcessorScope).MediaStreamTrackProcessor;

		// 优先使用 MediaStreamTrackProcessor，如果浏览器支持，则使用 MediaStreamTrackProcessor（Worker）
    if (track && TrackProcessor) {
      session.track = track.clone();
      message.readable = new TrackProcessor({ track: session.track, maxBufferSize: 1 }).readable;
      transfer = [message.readable];
      sourcePath = 'MediaStreamTrackProcessor';
    } else if (track && mstp) {
      session.track = track.clone();
      message.track = session.track;
      transfer = [session.track];
      sourcePath = 'MediaStreamTrackProcessor（Worker）';
    }

    let started;
    try {
      started = await startWorker(current, session, message, transfer);
    } catch (error) {
      if (active !== session) return;
      if (!(error instanceof DOMException) || error.name !== 'DataCloneError' || !message.track) throw error;
      session.track?.stop();
      session.track = undefined;
      delete message.track;
      sourcePath = '逐帧转移 VideoFrame';
      started = await startWorker(current, session, message, []);
    }
    if (active !== session) return;
    session.workerSession = started.session;
    // 选中的 Wasm 构建不可用时回退到 C++ 标量版。
    if (settings.mode !== 'js' && settings.mode !== 'none' && !started.available.includes(settings.mode)) selectMode('scalar');
    if (settings.mode !== mode) current.worker.postMessage({ type: 'mode', mode: settings.mode } satisfies PipelineRequest);
    if (settings.effect !== effect) current.worker.postMessage({ type: 'effect', effect: settings.effect } satisfies PipelineRequest);
    if (sourcePath === '逐帧转移 VideoFrame') sendFrames(session, current.worker, started.session);
    return sourcePath;
  }

  // 准备引擎、打开输入源并启动所选管线。每次异步等待后检查会话是否仍有效。
  async function start(config: LiveConfig) {
    if (active) return;
    settings = config;
    const session: Session = { kind: config.pipeline, phase: 'starting', lastReport: 0, frames: 0, dropped: 0 };
    active = session;
    onChange({ phase: 'starting', kind: session.kind });
    try {
      if (session.kind === 'main') await prepareMain(session);
      if (active !== session) return;
      if (config.source === 'camera') {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持摄像头');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
          video: { width: { ideal: config.width }, height: { ideal: config.height }, frameRate: { ideal: 30 } } });
        if (active !== session) { stream.getTracks().forEach(track => track.stop()); return; }
        session.camera = stream;
        video.srcObject = stream;
      }
      await video.play();
      if (active !== session) return;
      resetStats(session);
      const sourcePath = session.kind === 'worker' ? await runWorker(session)
        : typeof video.requestVideoFrameCallback === 'function' ? 'requestVideoFrameCallback' : 'requestAnimationFrame';
      if (active !== session) return;
      session.phase = 'playing';
      onChange({ phase: 'playing', sourcePath });
      if (session.kind === 'main') runMain(session);
    } catch (error) {
      if (active === session) fail(`实时处理启动失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 管线回退到可用实现时，同时同步页面下拉框。
  function selectMode(mode: LiveMode) {
    settings = { ...settings, mode };
    onChange({ mode });
  }

  // 运行中切换效果或实现。Worker 接收配置消息，主线程在下一帧读取最新配置。
  function update(change: Extract<PipelineRequest, { type: 'effect' | 'mode' }>) {
    if (!active) return;
    if (change.type === 'effect') {
      settings = { ...settings, effect: change.effect };
      if (active.kind === 'main' && engines) applyMainEffect();
    } else {
      settings = { ...settings, mode: change.mode };
    }
    if (active.phase !== 'playing') return;
    if (active.kind === 'worker') pipeline?.worker.postMessage(change);
    resetStats(active);
  }

  return {
    start, stop, update,
    // 页面卸载时结束会话并销毁复用的 Worker。
    dispose() {
      stop();
      pipeline?.worker.terminate();
    },
  };
}
