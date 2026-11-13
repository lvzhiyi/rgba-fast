import { useEffect, useRef, useState } from 'react';
import { getEffect } from './effects.ts';
import { WASM_BUILDS } from './kernels.ts';
import type { RefObject } from 'react';
import type { SetStatus } from './ui-types.ts';
import type { BenchmarkConfig, BenchmarkMessage, BenchmarkRecord, BenchmarkRequest } from './worker-protocol.ts';

/** 当前基准任务的界面快照，包含进度、最近结果和校验失败状态。 */
type BenchmarkRun = { progress: number; result: BenchmarkRecord | null; failed: boolean };

const emptyRun: BenchmarkRun = { progress: 0, result: null, failed: false };

// 每次基准测试独占一个 Worker。Hook 管理进度、最近结果和历史，像素计算在 Worker 内进行。
export function useBenchmark(outputCanvas: RefObject<HTMLCanvasElement | null>, setStatus: SetStatus) {
  const worker = useRef<Worker | null>(null);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState(emptyRun);
  const [history, setHistory] = useState<BenchmarkRecord[]>([]);

  useEffect(() => () => worker.current?.terminate(), []);

  // 成功、失败和取消都走同一个回收入口，立即释放当前 Worker。
  function finish(current: Worker) {
    current.terminate();
    worker.current = null;
    setRunning(false);
  }

  // 终止 Worker 可立即中断计算，本次采样不会写入历史。
  function cancel() {
    if (!worker.current) return;
    finish(worker.current);
    setRun(emptyRun);
    setStatus('已停止，本次未生成结果');
  }

  // 从固定帧创建测试任务，接收进度、校验和统计结果。
  function start(config: BenchmarkConfig, frame: ImageData | null, source: string, frameRevision: number) {
    if (worker.current || !frame) return;
    setRun(emptyRun);
    setStatus('加载计算模块与校验像素…');
    try {
      const current = new Worker(new URL('./benchmark-worker.ts', import.meta.url), { type: 'module' });
      worker.current = current;
      setRunning(true);
      current.onmessage = ({ data }: MessageEvent<BenchmarkMessage>) => {
        // 忽略已经取消或被替换的 Worker 消息。
        if (worker.current !== current) return;
        if (data.type === 'progress') {
          setStatus(`${data.phase} ${data.done} / ${data.total}`);
          // 进度条前 20% 留给预热，后 80% 对应采样。
          const fraction = data.done / data.total;
          setRun({ ...emptyRun, progress: data.phase === '预热' ? fraction * 20 : 20 + fraction * 80 });
          return;
        }
        finish(current);
        if (data.type === 'error') {
          setRun(previous => ({ ...previous, failed: true }));
          setStatus(data.message, true);
          return;
        }
        // 输出像素仅用于画布预览。导出和历史保留采样、环境、算法与输入帧来源。
        const { output, ...metrics } = data;
        const effect = getEffect(config.effect);
        const result: BenchmarkRecord = {
          ...metrics,
          timestamp: new Date().toISOString(),
          userAgent: navigator.userAgent,
          frameRevision,
          source,
          algorithm: { id: config.effect, ...effect, formula: 'clamp((sum + bias) >> shift, 0, 255); alpha preserved' },
          build: WASM_BUILDS.map(build => `${build.id}: ${build.source} -O3${build.simd ? ' SIMD128' : ''}`),
          timing: 'Worker; allocation, load, decode and Canvas excluded',
        };
        const canvas = outputCanvas.current!;
        canvas.width = config.width;
        canvas.height = config.height;
        canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(output), config.width, config.height), 0, 0);
        setRun({ ...emptyRun, progress: 100, result });
        setHistory(previous => [result, ...previous].slice(0, 8));
        setStatus('测试完成');
      };
      current.onerror = event => {
        if (worker.current !== current) return;
        finish(current);
        setStatus(`测试失败：${event.message}`, true);
      };
      // 只转移固定帧的副本，页面仍保留原始像素。
      const buffer = frame.data.slice().buffer;
      // 转移列表让 Worker 接管副本的 ArrayBuffer，消息传递时无需再次复制。
      current.postMessage({ ...config, buffer } satisfies BenchmarkRequest, [buffer]);
    } catch (error) {
      if (worker.current) finish(worker.current);
      setStatus(`测试失败：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  return { ...run, history, running, start, cancel, reset: () => setRun(emptyRun) };
}

// 把记录作为 JSON 下载，点击后延迟释放对象 URL。
export function exportResult(result: BenchmarkRecord) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `rgba-benchmark-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
