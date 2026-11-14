import { useCallback, useEffect, useRef, useState } from 'react';
import sampleImage from '../assets/sample.jpg';
import { BenchmarkControls, BenchmarkHistory, BenchmarkResults } from './components/BenchmarkPanel.tsx';
import { VideoPreview } from './components/VideoPreview.tsx';
import { DEFAULT_EFFECT, getEffect } from './effects.ts';
import { isGpu } from './kernels.ts';
import { createLiveVideo } from './live-video.ts';
import { useBenchmark } from './useBenchmark.ts';
import { useFixedFrame } from './useFixedFrame.ts';
import type { ChangeOption, LabOptions, LiveView, Status } from './ui-types.ts';
import type { LiveConfig } from './worker-protocol.ts';

const defaults: LabOptions = {
  resolution: '1280x720', passes: 4, samples: 30, effect: DEFAULT_EFFECT,
  source: 'file', pipeline: 'worker', mode: 'simd',
};

// 把下拉框的分辨率转成 Canvas、Worker 和 Wasm 共用的数值尺寸。
function getConfig({ resolution, ...options }: LabOptions) {
  const [width, height] = resolution.split('x').map(Number);
  return { ...options, width, height };
}

// 串联固定帧基准与实时预览。React 管理控件和展示状态，像素缓冲区及媒体资源由各自模块管理。
export default function App() {
  const input = useRef<HTMLCanvasElement>(null);
  const output = useRef<HTMLCanvasElement>(null);
  const worker = useRef<HTMLCanvasElement>(null);
  const gpu = useRef<HTMLCanvasElement>(null);
  const webgpu = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const liveVideo = useRef<ReturnType<typeof createLiveVideo>>(null);
  // 用版本号丢弃过期的图片解码结果。示例图加载完成时读取最新分辨率。
  const uploadRevision = useRef(0);
  const resolution = useRef(defaults.resolution);

  const [options, setOptions] = useState(defaults);
  const [live, setLive] = useState<LiveView>({ phase: 'idle' });
  const [workerCanvasKey, setWorkerCanvasKey] = useState(0);
  const [loadingImage, setLoadingImage] = useState(false);
  const [status, updateStatus] = useState<Status>({ text: '正在加载图像…' });
  const setStatus = useCallback((text: string, error = false) => updateStatus({ text, error }), []);

  const benchmark = useBenchmark(output, setStatus);
  const frame = useFixedFrame(input, output);
  const { fixedFrame, setImage } = frame;
  const busy = loadingImage || benchmark.running;

  // DOM 就绪后把 Canvas 和 video 交给实时控制器，卸载时释放帧回调、媒体轨道和 Worker。
  useEffect(() => {
    let mounted = true;
    const controller = createLiveVideo({
      video: video.current!,
      inputCanvas: input.current!,
      outputCanvas: output.current!,
      getWorkerCanvas: () => worker.current!,
      getGpuCanvas: () => gpu.current!,
      getWebgpuCanvas: () => webgpu.current!,
      replaceWorkerCanvas: () => setWorkerCanvasKey(key => key + 1),
      onChange({ mode, ...state }) {
        if (!mounted) return;
        if (mode) setOptions(previous => ({ ...previous, mode }));
        else setLive(previous => ({ ...previous, ...state }));
      },
      onError: message => setStatus(message, true),
      // 主线程实时管线会改写输入画布，停止时恢复基准测试使用的固定帧。
      restoreInput() {
        if (fixedFrame.current) input.current?.getContext('2d')?.putImageData(fixedFrame.current, 0, 0);
      },
    });
    liveVideo.current = controller;
    return () => {
      mounted = false;
      controller.dispose();
      liveVideo.current = null;
    };
  }, [fixedFrame, setStatus]);

  // 页面打开时异步加载示例图。期间若已选择本地图片，保留用户选择。
  useEffect(() => {
    let cancelled = false;
    const token = uploadRevision.current;
    const image = new Image();
    image.src = sampleImage;
    image.decode().then(() => {
      if (cancelled || token !== uploadRevision.current) return;
      setImage(image, '示例图片', getConfig({ ...defaults, resolution: resolution.current }));
      setStatus('就绪');
    }).catch(() => {
      if (!cancelled && token === uploadRevision.current) setStatus('示例图片加载失败，可以选择本地图片', true);
    });
    return () => {
      cancelled = true;
      uploadRevision.current++;
    };
  }, [setImage, setStatus]);

  useEffect(() => {
    // 浏览器会限制后台页面的调度，切到后台时结束采样和实时处理。
    function onVisibilityChange() {
      if (!document.hidden) return;
      benchmark.cancel();
      liveVideo.current?.stop();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [benchmark.cancel]);

  // 效果和实时实现可以热切换。输入源、管线或尺寸变更需要结束当前会话。
  const changeOption: ChangeOption = (field, value) => {
    const next = { ...options, [field]: value };
    if (next.pipeline === 'main' && isGpu(next.mode)) next.mode = 'simd';
    setOptions(next);
    if (field === 'mode' || field === 'effect') {
      liveVideo.current?.update(field === 'mode'
        ? { type: 'mode', mode: next.mode }
        : { type: 'effect', effect: next.effect });
      if (field === 'effect') {
        benchmark.reset();
        setStatus(`效果：${getEffect(next.effect).name}`);
      }
      return;
    }
    liveVideo.current?.stop();
    if (field === 'source' || field === 'pipeline') return;
    if (field === 'resolution') {
      resolution.current = next.resolution;
      frame.resize(getConfig(next));
    }
    benchmark.reset();
    setStatus('参数已更新');
  };

  // 解码本地图片后替换固定帧，并在成功或失败时释放临时对象 URL。
  async function uploadImage(file: File | undefined) {
    if (!file || busy) return;
    const token = ++uploadRevision.current;
    liveVideo.current?.stop();
    setLoadingImage(true);
    setStatus('正在读取图片…');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (token !== uploadRevision.current) return;
      setImage(image, file.name, getConfig(options));
      benchmark.reset();
      setStatus('图片已载入');
    } catch {
      if (token === uploadRevision.current) setStatus('图片读取失败，请选择有效的图片文件', true);
    } finally {
      URL.revokeObjectURL(url);
      if (token === uploadRevision.current) setLoadingImage(false);
    }
  }

  // 实时预览可独立启动。固定帧尚未就绪时，先为实时画布设置目标尺寸。
  function toggleLive() {
    if (live.phase === 'playing') liveVideo.current?.stop();
    else {
      const config = getConfig(options);
      if (!frame.hasFrame) {
        input.current!.width = output.current!.width = config.width;
        input.current!.height = output.current!.height = config.height;
      }
      liveVideo.current?.start(config);
    }
  }

  // 截帧按钮和播放时启动基准共用此流程：保存当前画面、停止视频、清空旧结果。
  function captureFrame(config: LiveConfig) {
    const name = frame.capture(video.current!, config);
    liveVideo.current?.stop();
    benchmark.reset();
    return name;
  }

  // 播放时取当前视频画面，否则取已保存的固定帧。同步传入来源和版本，供结果追溯。
  function startBenchmark() {
    const config = getConfig(options);
    let source = frame.sourceName;
    if (live.phase === 'playing') source = captureFrame(config);
    else liveVideo.current?.stop();
    benchmark.start(
      { width: config.width, height: config.height, passes: config.passes, samples: config.samples, effect: config.effect },
      fixedFrame.current, source, frame.revision.current,
    );
  }

  const effect = getEffect(options.effect);
  let previewMeta = '等待测试';
  if (live.phase === 'playing') previewMeta = `${effect.name} · ${live.kind === 'worker' ? 'Worker' : '主线程'}`;
  else if (benchmark.result) previewMeta = `${effect.name} ${benchmark.result.config.passes} 轮 · ${benchmark.result.rows.length} 种实现输出一致`;

  return (
    <>
      <header>
        <div className="brand"><span className="brand-mark">RGBA</span><h1>像素性能实验室</h1></div>
        <span className="platform">JavaScript / C++ · AssemblyScript → WebAssembly / SIMD128 · WebGL2 · WebGPU</span>
      </header>
      <main>
        <BenchmarkControls options={options} onOption={changeOption} benchmark={benchmark} busy={busy}
          hasFrame={frame.hasFrame} status={status} onStart={startBenchmark} />
        <BenchmarkResults benchmark={benchmark} effectId={options.effect} />
        <VideoPreview options={options} live={live} media={{ input, output, worker, gpu, webgpu, video }} workerCanvasKey={workerCanvasKey}
          sourceName={frame.sourceName} previewMeta={previewMeta} busy={busy} onOption={changeOption}
          onUpload={uploadImage} onToggle={toggleLive} onCapture={() => {
            captureFrame(getConfig(options));
            setStatus('已截取固定帧');
          }} />
        <BenchmarkHistory history={benchmark.history} />
      </main>
    </>
  );
}
