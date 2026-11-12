export function validateConfig(width, height, passes) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 1920 || height > 1080 ||
      !Number.isInteger(passes) || passes < 1 || passes > 32) {
    throw new RangeError('尺寸须在 1920×1080 以内，处理轮数须为 1–32 的整数');
  }
}

// 与 C++ 完全相同的九点整数均值；复用输出内存，不在逐帧计算中分配 Canvas 或 ImageData。
export function blurJS(src, dst, width, height) {
  const stride = width * 4;
  const size = stride * height;
  dst.set(src.subarray(0, stride), 0);
  dst.set(src.subarray(size - stride), size - stride);
  for (let y = 1; y < height - 1; y++) {
    const row = y * stride;
    for (let c = 0; c < 4; c++) {
      dst[row + c] = src[row + c];
      dst[row + stride - 4 + c] = src[row + stride - 4 + c];
    }
    for (let x = 1; x < width - 1; x++) {
      const p = row + x * 4;
      for (let channel = 0; channel < 3; channel++) {
        const i = p + channel;
        dst[i] = ((src[i - stride - 4] + src[i - stride] + src[i - stride + 4] +
          src[i - 4] + src[i] + src[i + 4] +
          src[i + stride - 4] + src[i + stride] + src[i + stride + 4]) / 9) | 0;
      }
      dst[p + 3] = src[p + 3];
    }
  }
}

export class JSProcessor {
  constructor(width, height) {
    validateConfig(width, height, 1);
    this.width = width;
    this.height = height;
    this.a = new Uint8Array(width * height * 4);
    this.b = new Uint8Array(this.a.length);
  }

  run(input, passes) {
    validateConfig(this.width, this.height, passes);
    if (input.length !== this.a.length) throw new RangeError('RGBA 数据长度与尺寸不一致');
    let src = input;
    let dst = this.a;
    for (let i = 0; i < passes; i++) {
      blurJS(src, dst, this.width, this.height);
      src = dst;
      dst = dst === this.a ? this.b : this.a;
    }
    return src;
  }
}

export class WasmProcessor {
  constructor(instance, width, height) {
    validateConfig(width, height, 1);
    this.exports = instance.exports;
    this.width = width;
    this.height = height;
    this.size = width * height * 4;
    if (this.size > this.exports.get_capacity()) throw new RangeError('超出 Wasm 像素容量');
    this.memory = new Uint8Array(this.exports.memory.buffer);
    this.input = this.memory.subarray(this.exports.get_input(), this.exports.get_input() + this.size);
    this.outputs = new Map();
    // 预先取得两种轮数奇偶对应的输出视图，计时区内不创建视图。
    for (const passes of [1, 2]) {
      const offset = this.exports.process(width, height, passes);
      if (!offset) throw new Error('Wasm 初始化失败');
      this.outputs.set(passes % 2, this.memory.subarray(offset, offset + this.size));
    }
  }

  prepare(input) {
    if (input.length !== this.size) throw new RangeError('RGBA 数据长度与尺寸不一致');
    this.input.set(input);
  }

  run(passes) {
    validateConfig(this.width, this.height, passes);
    const offset = this.exports.process(this.width, this.height, passes);
    if (!offset) throw new Error('Wasm 拒绝了无效的处理参数');
    return this.outputs.get(passes % 2);
  }
}

export async function loadWasm(url, width, height) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Wasm 加载失败：HTTP ${response.status}`);
  // ArrayBuffer 实例化不依赖服务器的 .wasm MIME 配置。
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  return new WasmProcessor(instance, width, height);
}

export function comparePixels(expected, actual) {
  if (expected.length !== actual.length) throw new RangeError('结果长度不一致');
  let mismatches = 0;
  let maxError = 0;
  for (let i = 0; i < expected.length; i++) {
    const error = Math.abs(expected[i] - actual[i]);
    if (error) mismatches++;
    if (error > maxError) maxError = error;
  }
  return { mismatches, maxError, bytes: expected.length };
}

export function statistics(samples) {
  if (!samples.length || samples.some(value => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('计时样本无效');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
  };
}
