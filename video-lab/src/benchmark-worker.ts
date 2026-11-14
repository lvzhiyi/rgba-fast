// 基准测试 Worker：在后台线程里对同一帧像素跑所有实现并计时，不卡住页面。
// 主线程每次点“开始测试”都新建一个本 Worker，收到 result / error 后立即销毁它。
// 流程：校验参数 → 加载全部 Wasm → 正确性校验 → 预热 → 采样计时 → 再次校验 → 汇总回传。
// 发回主线程的消息：progress（进度）、result（结果）、error（失败原因）。
import { JSProcessor, loadAllWasm, comparePixels, statistics, validateConfig } from './kernels.ts';
import { getEffect } from './effects.ts';
import { WebGPUProcessor } from './webgpu.ts';
import { WebGLProcessor } from './webgl.ts';
import { wasmUrls } from './wasm-assets.ts';
import type { GpuId, WasmId, WasmProcessor } from './kernels.ts';
import type { BenchmarkMessage, BenchmarkRequest, BenchmarkResult, BenchmarkRow, BenchmarkSamples } from './worker-protocol.ts';

const worker = self as unknown as DedicatedWorkerGlobalScope;
function post(message: BenchmarkMessage, transfer: Transferable[] = []) {
  worker.postMessage(message, transfer);
}

/** 基准 Worker 的一个参测实现，持有独立的结果读回缓冲和分段样本。 */
type Samples = { readback: Uint8Array<ArrayBuffer>; times: BenchmarkSamples };
/** CPU 实现直接返回结果视图，GPU 实现另行读回。 */
type Engine = Samples & ({ id: 'js'; processor: JSProcessor } | { id: WasmId; processor: WasmProcessor } |
  { id: GpuId; processor: WebGLProcessor | WebGPUProcessor; failed?: boolean });

/** 支持可选 GPU 计时和读回的参测实现。 */
type GpuEngine = Extract<Engine, { id: GpuId }>;

function isGpuEngine(engine: Engine): engine is GpuEngine {
  return engine.id === 'webgl2' || engine.id === 'webgpu';
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// 让出一次事件循环，使进度消息能及时发出去，也让“停止”能尽快生效。
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
// 预热次数：前几次运行要触发 JIT 编译、分配缓存等，速度不代表稳定状态，不计入结果。
const WARMUP = 12;

// data 来自主线程：{ width, height, passes, samples, effect, buffer }，buffer 是被转移过来的像素 ArrayBuffer。
worker.onmessage = async ({ data }: MessageEvent<BenchmarkRequest>) => {
  const gpus: (WebGLProcessor | WebGPUProcessor)[] = [];
  try {
    const { width, height, passes, samples, buffer } = data;
    const effect = getEffect(data.effect);
    validateConfig(width, height, passes);
    if (!Number.isInteger(samples) || samples < 10 || samples > 100) throw new Error('样本数无效');
    const source = new Uint8Array(buffer);
    if (source.length !== width * height * 4) throw new Error('帧数据不完整');
    const js = new JSProcessor(width, height);
    // 加载全部 Wasm 构建（C++ / AssemblyScript × 标量 / SIMD），不可用的记录原因后跳过。
    const { processors, errors: loadErrors } = await loadAllWasm(wasmUrls, width, height);
    const errors: BenchmarkResult['loadErrors'] = { ...loadErrors };
    const buffers = (): Samples => ({
      readback: new Uint8Array(source.length),
      times: { compute: [], upload: [], download: [], total: [] },
    });
    const engines: Engine[] = [{ id: 'js', processor: js, ...buffers() },
      ...Object.entries(processors).map(([id, processor]) => ({ id: id as WasmId, processor, ...buffers() }))];
    for (const [id, create] of [
      ['webgl2', () => new WebGLProcessor(new OffscreenCanvas(width, height), width, height)],
      ['webgpu', () => WebGPUProcessor.create(width, height)],
    ] as const) {
      try {
        const processor = await create();
        gpus.push(processor);
        processor.setEffect(effect);
        engines.push({ id, processor, ...buffers() });
      } catch (error) {
        errors[id] = message(error);
      }
    }
    for (const engine of engines) {
      if (!isGpuEngine(engine)) engine.processor.setEffect(effect);
    }
    // 运行错误仅禁用对应 GPU；像素不一致仍中止报告。
    async function runGpu(engine: GpuEngine, task: () => void | Promise<void>) {
      if (engine.failed) return false;
      try {
        await task();
        engine.processor.assertHealthy();
        return true;
      } catch (error) {
        engine.failed = true;
        errors[engine.id] = message(error);
        return false;
      }
    }

    // 以 JS 结果为标准答案；.slice() 复制一份，因为 js.run 的返回缓冲区下次运行会被覆盖。
    const expected = js.run(source, passes).slice();
    for (const engine of engines) {
      let actual: Uint8Array;
      if (isGpuEngine(engine)) {
        const done = await runGpu(engine, async () => {
          engine.processor.prepare(source);
          engine.processor.run(passes);
          await engine.processor.readback(engine.readback);
        });
        if (!done) continue;
        actual = engine.readback;
      } else if (engine.id === 'js') actual = js.run(source, passes);
      else {
        engine.processor.prepare(source);
        actual = engine.processor.run(passes);
      }
      const check = comparePixels(expected, actual);
      if (check.mismatches) throw new Error(`${engine.id} 结果校验失败，停止性能比较`);
    }
    // 每条路径各自预热；初始化、编译和正确性校验均不进入计时。
    post({ type: 'progress', phase: '预热', done: 0, total: WARMUP });
    for (let i = 0; i < WARMUP; i++) {
      for (const engine of engines) {
        if (engine.id === 'js') js.run(source, passes);
        else if (isGpuEngine(engine)) {
          await runGpu(engine, async () => {
            engine.processor.run(passes);
            await engine.processor.readback(engine.readback);
          });
        } else engine.processor.run(passes);
      }
      post({ type: 'progress', phase: '预热', done: i + 1, total: WARMUP });
      await pause();
    }
    // 小图的 SIMD 耗时可能接近浏览器时钟精度；同样批量执行所有路径后报告单次均值。
    // 浏览器为了安全会降低 performance.now() 的精度（常见 0.1 ms 甚至更粗），单次 0.02 ms 量不准。
    // 所以先测出最快实现的单次耗时，选一个批量大小让每批约 4 ms，每批连跑 batchSize 次再取平均。
    let fastest = Infinity;
    for (const engine of engines) {
      if (isGpuEngine(engine)) continue;
      const start = performance.now();
      if (engine.id === 'js') js.run(source, passes);
      else engine.processor.run(passes);
      fastest = Math.min(fastest, performance.now() - start);
    }
    const batchSize = Math.min(32, Math.max(1, Math.ceil(4 / Math.max(fastest, 0.05))));
    for (let i = 0; i < samples; i++) {
      // 每个样本轮换起跑顺序，降低固定先后顺序和温度变化带来的偏差。
      for (let j = 0; j < engines.length; j++) {
        const engine = engines[(i + j) % engines.length];
        if (isGpuEngine(engine)) {
          await runGpu(engine, () => measureGpu(engine.processor, source, engine.readback, passes, batchSize, engine.times));
          continue;
        }
        let upload = 0;
        let compute = 0;
        let download = 0;
        const batchStart = performance.now();
        for (let repeat = 0; repeat < batchSize; repeat++) {
          const start = performance.now();
          if (engine.id !== 'js') engine.processor.prepare(source);
          const uploaded = performance.now();
          const output = engine.id === 'js' ? js.run(source, passes) : engine.processor.run(passes);
          const computed = performance.now();
          // 所有路径都复制到同类型的 JS 结果数组，供后续显示使用。
          engine.readback.set(output);
          const end = performance.now();
          upload += uploaded - start;
          compute += computed - uploaded;
          download += end - computed;
        }
        engine.times.total.push((performance.now() - batchStart) / batchSize);
        engine.times.upload.push(upload / batchSize);
        engine.times.compute.push(compute / batchSize);
        engine.times.download.push(download / batchSize);
      }
      post({ type: 'progress', phase: '采样', done: i + 1, total: samples });
      await pause();
    }
    // 末次采样后再次校验，确保计时结果对应真实、正确的输出。
    const rows = engines.filter(engine => !isGpuEngine(engine) || !engine.failed).map((engine): BenchmarkRow => {
      const check = comparePixels(expected, engine.readback);
      if (check.mismatches) throw new Error('采样后结果不一致，停止报告');
      const { compute, upload, download, total } = engine.times;
      return { id: engine.id, check, rawSamples: engine.times,
        clock: isGpuEngine(engine) ? 'gpu-query' : 'cpu-wall',
        compute: compute.length ? statistics(compute) : null,
        upload: statistics(upload), download: statistics(download), total: statistics(total) };
    });
    // 最后一个参数是“转移列表”：expected.buffer 的所有权直接交给主线程，不复制（Worker 侧随后不可再用）。
    post({ type: 'result', rows, loadErrors: errors,
      gpuReadbackFormat: errors.webgl2 ? undefined : gpus.find(gpu => gpu instanceof WebGLProcessor)?.readbackFormat,
      webgpuReadbackFormat: errors.webgpu ? undefined : gpus.find(gpu => gpu instanceof WebGPUProcessor)?.readbackFormat, warmup: WARMUP, batchSize,
      config: { width, height, passes, samples, effect: data.effect }, output: expected.buffer }, [expected.buffer]);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    for (const gpu of gpus) gpu.dispose();
  }
};

// GPU 查询单独对已上传的输入计时。总时间按 CPU 墙钟计量，读回包含 GPU 完成等待。
async function measureGpu(gpu: WebGLProcessor | WebGPUProcessor, source: Uint8Array<ArrayBuffer>, output: Uint8Array<ArrayBuffer>,
  passes: number, batchSize: number, times: BenchmarkSamples) {
  if (gpu instanceof WebGPUProcessor) {
    if (gpu.supportsGpuTiming) {
      gpu.run(passes, batchSize, true);
      const elapsed = await gpu.timerResult();
      if (elapsed !== null) times.compute.push(elapsed / batchSize);
    }
  } else {
    const query = gpu.startTimer();
    if (query) {
      for (let i = 0; i < batchSize; i++) gpu.run(passes);
      gpu.stopTimer(query);
      await gpu.readback(output);
      const elapsed = await gpu.timerResult(query);
      if (elapsed !== null) times.compute.push(elapsed / batchSize);
    }
  }

  let upload = 0;
  let download = 0;
  const start = performance.now();
  for (let i = 0; i < batchSize; i++) {
    const beforeUpload = performance.now();
    gpu.prepare(source);
    upload += performance.now() - beforeUpload;
    gpu.run(passes);
    const beforeReadback = performance.now();
    await gpu.readback(output);
    download += performance.now() - beforeReadback;
  }
  times.total.push((performance.now() - start) / batchSize);
  times.upload.push(upload / batchSize);
  times.download.push(download / batchSize);
}
