import { JSProcessor, loadWasm, comparePixels, statistics, validateConfig } from './kernels.js';

const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const WARMUP = 12;

self.onmessage = async ({ data }) => {
  try {
    const { width, height, passes, samples, buffer } = data;
    validateConfig(width, height, passes);
    if (!Number.isInteger(samples) || samples < 10 || samples > 100) throw new Error('样本数无效');
    const source = new Uint8Array(buffer);
    if (source.length !== width * height * 4) throw new Error('帧数据不完整');
    const js = new JSProcessor(width, height);
    const scalar = await loadWasm('./operations/benchmark-scalar.wasm', width, height);
    const engines = [{ id: 'js', processor: js }, { id: 'scalar', processor: scalar }];
    let simdError = '';
    try {
      const simd = await loadWasm('./operations/benchmark-simd.wasm', width, height);
      engines.push({ id: 'simd', processor: simd });
    } catch (error) {
      simdError = error.message;
    }
    const expected = js.run(source, passes).slice();
    const checks = {};
    for (const engine of engines) {
      engine.readback = new Uint8Array(source.length);
      engine.times = { compute: [], upload: [], download: [], total: [] };
      if (engine.id !== 'js') engine.processor.prepare(source);
      const actual = engine.id === 'js' ? js.run(source, passes) : engine.processor.run(passes);
      checks[engine.id] = comparePixels(expected, actual);
      if (checks[engine.id].mismatches) throw new Error(`${engine.id} 结果校验失败，停止性能比较`);
    }
    // 三条路径各自预热；初始化、编译和正确性校验均不进入计时。
    self.postMessage({ type: 'progress', phase: '预热', done: 0, total: WARMUP });
    for (let i = 0; i < WARMUP; i++) {
      for (const engine of engines) {
        if (engine.id === 'js') js.run(source, passes);
        else engine.processor.run(passes);
      }
      self.postMessage({ type: 'progress', phase: '预热', done: i + 1, total: WARMUP });
      await pause();
    }
    // 小图的 SIMD 耗时可能接近浏览器时钟精度；同样批量执行三条路径后报告单次均值。
    let fastest = Infinity;
    for (const engine of engines) {
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
          // 三条路径都复制到同类型的 JS 结果数组，供后续显示使用。
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
      self.postMessage({ type: 'progress', phase: '采样', done: i + 1, total: samples });
      await pause();
    }
    // 末次采样后再次校验，确保计时结果对应真实、正确的输出。
    const rows = engines.map(engine => {
      const check = comparePixels(expected, engine.readback);
      if (check.mismatches) throw new Error('采样后结果不一致，停止报告');
      return { id: engine.id, check, rawSamples: engine.times, ...Object.fromEntries(
        Object.entries(engine.times).map(([key, values]) => [key, statistics(values)])) };
    });
    self.postMessage({ type: 'result', rows, simdError, warmup: WARMUP, batchSize,
      config: { width, height, passes, samples }, output: expected.buffer }, [expected.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message });
  }
};
