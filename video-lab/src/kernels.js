import { DEFAULT_EFFECT, PARAM_COUNT, encodeEffect, getEffect, validateEffect } from './effects.js';

export function validateConfig(width, height, passes) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 1920 || height > 1080 ||
      !Number.isInteger(passes) || passes < 1 || passes > 32) {
    throw new RangeError('尺寸须在 1920×1080 以内，处理轮数须为 1–32 的整数');
  }
}

const clamp = value => value < 0 ? 0 : value > 255 ? 255 : value;

// 与 C++ 完全相同的整数 3x3 卷积：保留最外围一圈像素和 Alpha；复用输出内存，逐帧不分配。
// 九个抽头手动展开、权重放进局部变量，JIT 才能生成与旧版专用模糊相当的代码；
// 九个权重全部相同时（均值模糊）先求和再乘一次。否则 JS 会被通用循环拖慢，虚增 Wasm 加速比。
function convolveJS(src, dst, width, height, effect) {
  const stride = width * 4;
  const size = stride * height;
  const { bias, shift } = effect;
  const [w0, w1, w2, w3, w4, w5, w6, w7, w8] = effect.weights;
  const uniform = effect.weights.every(value => value === w0);
  const up = -stride;
  const down = stride;
  dst.set(src.subarray(0, stride), 0);
  dst.set(src.subarray(size - stride), size - stride);
  for (let y = 1; y < height - 1; y++) {
    const row = y * stride;
    for (let c = 0; c < 4; c++) {
      dst[row + c] = src[row + c];
      dst[row + stride - 4 + c] = src[row + stride - 4 + c];
    }
    // 分支提到像素循环外，内层循环保持单一形态。
    if (uniform) {
      for (let x = 1; x < width - 1; x++) {
        const p = row + x * 4;
        for (let i = p; i < p + 3; i++) {
          const sum = (src[i + up - 4] + src[i + up] + src[i + up + 4] + src[i - 4] + src[i] + src[i + 4] +
            src[i + down - 4] + src[i + down] + src[i + down + 4]) * w0 + bias;
          dst[i] = clamp(sum >> shift);
        }
        dst[p + 3] = src[p + 3];
      }
    } else {
      for (let x = 1; x < width - 1; x++) {
        const p = row + x * 4;
        for (let i = p; i < p + 3; i++) {
          const sum = w0 * src[i + up - 4] + w1 * src[i + up] + w2 * src[i + up + 4] +
            w3 * src[i - 4] + w4 * src[i] + w5 * src[i + 4] +
            w6 * src[i + down - 4] + w7 * src[i + down] + w8 * src[i + down + 4] + bias;
          dst[i] = clamp(sum >> shift);
        }
        dst[p + 3] = src[p + 3];
      }
    }
  }
}

// 颜色矩阵逐像素作用于全部像素，Alpha 不变。
function colorJS(src, dst, effect) {
  const m = effect.matrix;
  const { shift } = effect;
  for (let p = 0; p < src.length; p += 4) {
    const r = src[p], g = src[p + 1], b = src[p + 2];
    dst[p] = clamp((m[0] * r + m[1] * g + m[2] * b + m[3]) >> shift);
    dst[p + 1] = clamp((m[4] * r + m[5] * g + m[6] * b + m[7]) >> shift);
    dst[p + 2] = clamp((m[8] * r + m[9] * g + m[10] * b + m[11]) >> shift);
    dst[p + 3] = src[p + 3];
  }
}

export function applyEffectJS(src, dst, width, height, effect) {
  if (effect.kind === 'convolution') convolveJS(src, dst, width, height, effect);
  else colorJS(src, dst, effect);
}

export class JSProcessor {
  constructor(width, height) {
    validateConfig(width, height, 1);
    this.width = width;
    this.height = height;
    this.a = new Uint8Array(width * height * 4);
    this.b = new Uint8Array(this.a.length);
    this.effect = getEffect(DEFAULT_EFFECT);
  }

  setEffect(effect) {
    this.effect = validateEffect(effect);
  }

  run(input, passes) {
    validateConfig(this.width, this.height, passes);
    if (input.length !== this.a.length) throw new RangeError('RGBA 数据长度与尺寸不一致');
    let src = input;
    let dst = this.a;
    for (let i = 0; i < passes; i++) {
      applyEffectJS(src, dst, this.width, this.height, this.effect);
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
    this.params = new Int32Array(this.exports.memory.buffer, this.exports.get_params(), PARAM_COUNT);
    this.setEffect(getEffect(DEFAULT_EFFECT));
    this.outputs = new Map();
    // 预先取得两种轮数奇偶对应的输出视图，计时区内不创建视图。
    for (const passes of [1, 2]) {
      const offset = this.exports.process(width, height, passes);
      if (!offset) throw new Error('Wasm 初始化失败');
      this.outputs.set(passes % 2, this.memory.subarray(offset, offset + this.size));
    }
  }

  // 效果参数直接写进 Wasm 线性内存，下一次 process 生效。
  setEffect(effect) {
    this.params.set(encodeEffect(effect));
    this.effect = effect;
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
