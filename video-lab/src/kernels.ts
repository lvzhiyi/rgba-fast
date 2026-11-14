// 计算核心：把“对一帧 RGBA 像素施加效果”封装成统一接口，供基准测试和实时管线共用。
//   JSProcessor   —— 纯 JavaScript 实现，作为正确性基准（其他实现都要和它逐字节一致）；
//   WasmProcessor —— 包装任意一个 Wasm 模块（C++ / AssemblyScript × 标量 / SIMD），四种构建导出相同的函数。
// 像素格式统一为 RGBA，每像素 4 字节，按行连续排列：第 (x, y) 个像素从下标 (y × width + x) × 4 开始。
import { DEFAULT_EFFECT, PARAM_COUNT, encodeEffect, getEffect, validateEffect } from './effects.ts';
import type { ColorEffect, ConvolutionEffect, Effect } from './effects.ts';

// 尺寸上限 1920×1080 来自 Wasm 侧预留的固定缓冲区大小；passes 是同一效果连续叠加的轮数。
export function validateConfig(width: number, height: number, passes: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 1 || height < 1 || width > 1920 || height > 1080 ||
      !Number.isInteger(passes) || passes < 1 || passes > 32) {
    throw new RangeError('尺寸须在 1920×1080 以内，处理轮数须为 1–32 的整数');
  }
}

// 把计算结果截到一个字节能表示的 0..255。
const clamp = (value: number) => value < 0 ? 0 : value > 255 ? 255 : value;

/** 滤镜可读取的 RGBA 字节视图，兼容 Canvas 的钳制数组和普通字节数组。 */
type PixelBytes = Uint8Array<ArrayBuffer> | Uint8ClampedArray<ArrayBuffer>;

// stride = 一行的字节数；src[i ± stride] 是正上 / 正下方同一通道，src[i ± 4] 是左 / 右邻像素同一通道。
// 与 C++ 完全相同的整数 3x3 卷积：保留最外围一圈像素和 Alpha；复用输出内存，逐帧不分配。
// 九个抽头手动展开、权重放进局部变量，JIT 才能生成与旧版专用模糊相当的代码；
// 九个权重全部相同时（均值模糊）先求和再乘一次。否则 JS 会被通用循环拖慢，虚增 Wasm 加速比。
function convolveJS(src: PixelBytes, dst: Uint8Array, width: number, height: number, effect: ConvolutionEffect) {
  const stride = width * 4;
  const size = stride * height;
  const { bias, shift } = effect;
  const [w0, w1, w2, w3, w4, w5, w6, w7, w8] = effect.weights;
  const uniform = effect.weights.every(value => value === w0);
  const up = -stride;
  const down = stride;
  // 第一行和最后一行缺少上 / 下邻居，原样复制。
  dst.set(src.subarray(0, stride), 0);
  dst.set(src.subarray(size - stride), size - stride);
  for (let y = 1; y < height - 1; y++) {
    const row = y * stride;
    // 每行最左、最右一个像素同样缺邻居，原样复制。
    for (let c = 0; c < 4; c++) {
      dst[row + c] = src[row + c];
      dst[row + stride - 4 + c] = src[row + stride - 4 + c];
    }
    // 分支提到像素循环外，内层循环保持单一形态。
    if (uniform) {
      for (let x = 1; x < width - 1; x++) {
        const p = row + x * 4;
        // i 依次指向 R、G、B 三个通道；Alpha（p + 3）不参与计算，最后单独复制。
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
// 每个输出通道 = 输入 R、G、B 的加权和 + 偏移，例如灰度就是三行相同的 0.3R + 0.59G + 0.11B（放大 256 倍取整）。
// 只看单个像素自己，不需要邻居，所以没有边界特殊处理。
function colorJS(src: PixelBytes, dst: Uint8Array, effect: ColorEffect) {
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

// 按效果类型分派到卷积或颜色矩阵；src 只读，结果写进 dst。
export function applyEffectJS(src: PixelBytes, dst: Uint8Array, width: number, height: number, effect: Effect) {
  if (effect.kind === 'convolution') convolveJS(src, dst, width, height, effect);
  else colorJS(src, dst, effect);
}

// JS 版处理器。a、b 是两块预分配的输出缓冲区，多轮处理时轮流当“输入 / 输出”（双缓冲、乒乓切换），
// 因为卷积不能原地进行：算某个像素时还要读它旁边尚未被改写的原值。
export class JSProcessor {
  readonly width: number;
  readonly height: number;
  readonly a: Uint8Array<ArrayBuffer>;
  readonly b: Uint8Array<ArrayBuffer>;
  private effect: Effect;

  constructor(width: number, height: number) {
    validateConfig(width, height, 1);
    this.width = width;
    this.height = height;
    this.a = new Uint8Array(width * height * 4);
    this.b = new Uint8Array(this.a.length);
    this.effect = getEffect(DEFAULT_EFFECT);
  }

  setEffect(effect: Effect) {
    this.effect = validateEffect(effect);
  }

  // 返回最后一轮结果所在的缓冲区（this.a 或 this.b），调用方不要长期持有：下次 run 会覆盖它。
  run(input: PixelBytes, passes: number) {
    validateConfig(this.width, this.height, passes);
    if (input.length !== this.a.length) throw new RangeError('RGBA 数据长度与尺寸不一致');
    // 第一轮读调用方的 input，之后每轮把上一轮的输出当输入，并换到另一块缓冲区写。
    let src: PixelBytes = input;
    let dst = this.a;
    for (let i = 0; i < passes; i++) {
      applyEffectJS(src, dst, this.width, this.height, this.effect);
      src = dst;
      dst = dst === this.a ? this.b : this.a;
    }
    return passes % 2 === 0 ? this.b : this.a;
  }
}

// Wasm 版处理器。Wasm 模块只有一块“线性内存”（一个大 ArrayBuffer），JS 和 Wasm 共享它：
//   get_input()  → 输入缓冲区在这块内存里的起始地址（字节偏移）
//   get_params() → 效果参数数组的地址
//   process(w, h, passes) → 处理完后返回结果所在地址，0 表示参数非法
// JS 侧在同一个 ArrayBuffer 上建 Uint8Array / Int32Array 视图，读写视图就是直接读写 Wasm 内存，没有额外复制。
// 使用顺序：setEffect（可选）→ prepare(像素) → run(passes) → 读返回的视图。
/** 四份 Wasm 模块共用的导出契约，包含线性内存、缓冲区地址查询和处理入口。 */
export type WasmExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  get_capacity(): number;
  get_input(): number;
  get_params(): number;
  get_simd(): number;
  process(width: number, height: number, passes: number): number;
};

export class WasmProcessor {
  readonly exports: WasmExports;
  readonly width: number;
  readonly height: number;
  readonly size: number;
  readonly memory: Uint8Array<ArrayBuffer>;
  readonly input: Uint8Array<ArrayBuffer>;
  readonly params: Int32Array<ArrayBuffer>;
  readonly outputs: Map<number, Uint8Array<ArrayBuffer>>;
  effect: Effect;

  constructor(instance: WebAssembly.Instance, width: number, height: number) {
    validateConfig(width, height, 1);
    this.exports = instance.exports as WasmExports;
    this.width = width;
    this.height = height;
    this.size = width * height * 4;
    if (this.size > this.exports.get_capacity()) throw new RangeError('超出 Wasm 像素容量');
    this.memory = new Uint8Array(this.exports.memory.buffer);
    this.input = this.memory.subarray(this.exports.get_input(), this.exports.get_input() + this.size);
    this.params = new Int32Array(this.exports.memory.buffer, this.exports.get_params(), PARAM_COUNT);
    this.effect = getEffect(DEFAULT_EFFECT);
    this.setEffect(this.effect);
    this.outputs = new Map();
    // Wasm 内部也是 work_a / work_b 双缓冲：奇数轮结果落在 work_a，偶数轮落在 work_b。
    // 预先各跑一次拿到两个地址，把对应视图缓存起来（键为 passes % 2），计时区内不创建视图。
    for (const passes of [1, 2]) {
      const offset = this.exports.process(width, height, passes);
      if (!offset) throw new Error('Wasm 初始化失败');
      this.outputs.set(passes % 2, this.memory.subarray(offset, offset + this.size));
    }
  }

  // 效果参数直接写进 Wasm 线性内存，下一次 process 生效。
  setEffect(effect: Effect) {
    this.params.set(encodeEffect(effect));
    this.effect = effect;
  }

  // “上传”：把 JS 侧的像素复制进 Wasm 的输入区。基准里单独计时为“输入复制”。
  // 实时管线里 VideoFrame.copyTo 直接写进 this.input，就不需要调用它。
  prepare(input: PixelBytes) {
    if (input.length !== this.size) throw new RangeError('RGBA 数据长度与尺寸不一致');
    this.input.set(input);
  }

  // 调用 Wasm 计算，返回指向结果的视图（仍在 Wasm 内存里，未复制）。
  run(passes: number) {
    validateConfig(this.width, this.height, passes);
    const offset = this.exports.process(this.width, this.height, passes);
    if (!offset) throw new Error('Wasm 拒绝了无效的处理参数');
    return this.outputs.get(passes % 2)!; // 构造时已缓存奇数、偶数两种结果视图。
  }
}

// 全部 Wasm 构建：两种源语言 × 是否启用 SIMD。required 为 true 的模块加载失败时直接报错，
// 其余加载失败（例如浏览器不支持 SIMD）时跳过并记录原因。
export const WASM_BUILDS = [
  { id: 'scalar', name: 'C++ · 标量', file: 'benchmark-scalar.wasm', source: 'C++', simd: false, required: true },
  { id: 'simd', name: 'C++ · SIMD128', file: 'benchmark-simd.wasm', source: 'C++', simd: true },
  { id: 'as-scalar', name: 'AS · 标量', file: 'assemblyscript-scalar.wasm', source: 'AssemblyScript', simd: false },
  { id: 'as-simd', name: 'AS · SIMD128', file: 'assemblyscript-simd.wasm', source: 'AssemblyScript', simd: true },
] as const;

/** 四种 Wasm 构建的标识，由构建清单推导。 */
export type WasmId = typeof WASM_BUILDS[number]['id'];
/** CPU 实现标识，包括 TypeScript 实现和四种 Wasm 构建。 */
export type ImplementationId = 'js' | WasmId;
/** 基准和实时对照可选的 CPU 或 GPU 实现。 */
export type GpuId = 'webgl2' | 'webgpu';
/** 可参与对照的 CPU 和 GPU 实现。 */
export type BackendId = ImplementationId | GpuId;

export function isGpu(id: string): id is GpuId {
  return id === 'webgl2' || id === 'webgpu';
}
/** 已加载的 Wasm 处理器，浏览器无法加载的可选实现没有对应条目。 */
export type WasmProcessors = Partial<Record<WasmId, WasmProcessor>>;
/** 按构建标识记录可选 Wasm 模块的加载失败原因。 */
export type WasmLoadErrors = Partial<Record<WasmId, string>>;

// 实现 id → 显示名，界面上的下拉框、表格行都由它生成。
export const IMPLEMENTATIONS = { js: 'JavaScript',
  ...Object.fromEntries(WASM_BUILDS.map(build => [build.id, build.name])), webgl2: 'WebGL2 · 片元着色器', webgpu: 'WebGPU · Compute' } as Record<BackendId, string>;

// 加载全部 Wasm 构建，返回 { processors: { id: WasmProcessor }, errors: { id: 原因 } }。
export async function loadAllWasm(urls: Record<WasmId, string>, width: number, height: number) {
  const results = await Promise.allSettled(WASM_BUILDS.map(build => loadWasm(urls[build.id], width, height)));
  // 并行加载，但按清单顺序登记，保证表格和下拉框顺序稳定。
  const processors: WasmProcessors = {};
  const errors: WasmLoadErrors = {};
  WASM_BUILDS.forEach((build, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') processors[build.id] = result.value;
    else if ('required' in build && build.required) throw result.reason;
    else errors[build.id] = result.reason instanceof Error ? result.reason.message : String(result.reason);
  });
  return { processors, errors };
}

// 下载 → 编译 → 实例化一个 .wasm 文件。模块不需要任何导入（不调用 JS 函数），所以 instantiate 不传第二个参数。
// 不支持 SIMD 的浏览器会在编译 SIMD 版本时抛错，由 loadAllWasm 记录后跳过。
export async function loadWasm(url: URL | string, width: number, height: number) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Wasm 加载失败：HTTP ${response.status}`);
  // ArrayBuffer 实例化不依赖服务器的 .wasm MIME 配置。
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer());
  return new WasmProcessor(instance, width, height);
}

// 逐字节比较两份结果：mismatches 为不同的字节数，maxError 为最大差值。本项目要求两者都为 0。
export function comparePixels(expected: Uint8Array, actual: Uint8Array) {
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

// 计时样本的统计量：
//   median 中位数 —— 排序后正中间的值，不受个别极慢样本影响，作为“典型耗时”；
//   p95           —— 95% 的样本不超过它，反映“偶尔卡一下”有多慢；
//   min           —— 最快一次，接近无干扰时的理论下限。
export function statistics(samples: readonly number[]) {
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
