// AssemblyScript 版效果引擎：语法是 TypeScript，编译成 Wasm。
// 与 native/benchmark.cc 保持完全相同的内存布局、导出函数和整数公式，
// 因此 kernels.js 的 WasmProcessor 可以不加区分地加载它，测试也要求逐字节一致。
//
// 读这份代码时只需记住三点：
//   1. i32 / u8 / usize 是具体的整数类型（usize 在 wasm32 上就是 32 位地址）；
//   2. load<T>(地址) / store<T>(地址, 值) 直接按字节地址读写线性内存，相当于 C++ 的指针；
//   3. ASC_FEATURE_SIMD 是编译期常量：用 --enable simd 编译时为 true，否则 if 分支整段被删掉。

const CAPACITY: i32 = 1920 * 1080 * 4;
// memory.data 在编译期预留静态内存，返回其起始地址（对齐到 16 字节以便 SIMD 读写）。
const input: usize = memory.data(CAPACITY, 16);
const workA: usize = memory.data(CAPACITY, 16);
const workB: usize = memory.data(CAPACITY, 16);

// 效果参数，布局与 C++ 相同：
//   [0] 类型：0 = 3x3 卷积，1 = 颜色矩阵；[1] 右移位数 shift
//   卷积：[2..10] 九个权重，[11] bias；颜色矩阵：[2..13] 三行 [r, g, b, bias]
// 默认是均值模糊：(sum × 7282) >> 16 与 floor(sum / 9) 完全一致。
const params: usize = memory.data<i32>([0, 16, 7282, 7282, 7282, 7282, 7282, 7282, 7282, 7282, 7282, 0, 0, 0, 0, 0]);

const KIND_CONVOLUTION: i32 = 0;
const KIND_COLOR: i32 = 1;
const WEIGHT_LIMIT: i64 = 32767;
const SUM_LIMIT: i64 = 2147483647;

// 卷积路径：与 C++ 相同的三档选择。
const UNIFORM: i32 = 0; // 非零权重全相同：先求和，最后乘一次
const SMALL: i32 = 1;   // |bias| + 255 × Σ|w| ≤ 32767：全程 16 位
const GENERAL: i32 = 2; // 其余：32 位累加

// 非零抽头表：最多 9 个字节偏移和权重。“抽头”指卷积核里一个参与计算的邻居位置。
// AssemblyScript 的 stub 运行时没有垃圾回收，不便用数组对象，所以直接在静态内存里放两段 i32。
const tapOffset: usize = memory.data(9 * 4, 4);
const tapWeight: usize = memory.data(9 * 4, 4);
let tapCount: i32 = 0;
let tapPath: i32 = GENERAL;

// 读 params[index]：每个 i32 占 4 字节，所以地址是 params + index × 4（<< 2 即 × 4）。
// @inline 让编译器把函数体直接展开到调用处，省掉函数调用开销。
@inline function param(index: i32): i32 {
  return load<i32>(params + (<usize>index << 2));
}

// 取绝对值并放大到 64 位，用于溢出估算时自身不会溢出（-2147483648 的绝对值放不进 i32）。
@inline function magnitude(value: i32): i64 {
  return value < 0 ? -(<i64>value) : <i64>value;
}

@inline function clamp(value: i32): u8 {
  return <u8>(value < 0 ? 0 : value > 255 ? 255 : value);
}

// 检查参数能否在 32 位整数内无溢出地累加；非法参数让 process 返回 0。
function validParams(): bool {
  const shift = param(1);
  if (shift < 0 || shift > 30) return false;
  if (param(0) == KIND_CONVOLUTION) {
    let total = magnitude(param(11));
    for (let i = 2; i < 11; i++) {
      if (magnitude(param(i)) > WEIGHT_LIMIT) return false;
      total += magnitude(param(i)) * 255;
    }
    return total <= SUM_LIMIT;
  }
  if (param(0) == KIND_COLOR) {
    for (let row = 0; row < 3; row++) {
      const base = 2 + row * 4;
      let total = magnitude(param(base + 3));
      for (let i = 0; i < 3; i++) {
        if (magnitude(param(base + i)) > WEIGHT_LIMIT) return false;
        total += magnitude(param(base + i)) * 255;
      }
      if (total > SUM_LIMIT) return false;
    }
    return true;
  }
  return false;
}

// 只保留非零权重的抽头，并按当前行宽换算成字节偏移；同时选出卷积路径。
function buildTaps(stride: i32): void {
  tapCount = 0;
  let total = magnitude(param(11));
  let uniform = true;
  for (let row = -1; row <= 1; row++) {
    for (let col = -1; col <= 1; col++) {
      const weight = param(2 + (row + 1) * 3 + (col + 1));
      if (weight == 0) continue;
      store<i32>(tapOffset + (<usize>tapCount << 2), row * stride + col * 4);
      store<i32>(tapWeight + (<usize>tapCount << 2), weight);
      if (weight != load<i32>(tapWeight)) uniform = false;
      total += magnitude(weight) * 255;
      tapCount++;
    }
  }
  tapPath = uniform && tapCount > 0 ? UNIFORM : total <= 32767 ? SMALL : GENERAL;
}

// 标量卷积：固定遍历九个邻居（零权重也算），与 C++ 标量版相同。
@inline function convolvePixel(src: usize, dst: usize, p: i32, stride: i32, bias: i32, shift: i32,
                               uniform: bool): void {
  const w0 = param(2), w1 = param(3), w2 = param(4), w3 = param(5), w4 = param(6);
  const w5 = param(7), w6 = param(8), w7 = param(9), w8 = param(10);
  for (let channel = 0; channel < 3; channel++) {
    const i = <usize>(p + channel);
    const up = src + i - <usize>stride;
    const mid = src + i;
    const down = src + i + <usize>stride;
    let sum: i32;
    if (uniform) {
      sum = (<i32>load<u8>(up - 4) + <i32>load<u8>(up) + <i32>load<u8>(up + 4) +
        <i32>load<u8>(mid - 4) + <i32>load<u8>(mid) + <i32>load<u8>(mid + 4) +
        <i32>load<u8>(down - 4) + <i32>load<u8>(down) + <i32>load<u8>(down + 4)) * w0 + bias;
    } else {
      sum = w0 * <i32>load<u8>(up - 4) + w1 * <i32>load<u8>(up) + w2 * <i32>load<u8>(up + 4) +
        w3 * <i32>load<u8>(mid - 4) + w4 * <i32>load<u8>(mid) + w5 * <i32>load<u8>(mid + 4) +
        w6 * <i32>load<u8>(down - 4) + w7 * <i32>load<u8>(down) + w8 * <i32>load<u8>(down + 4) + bias;
    }
    store<u8>(dst + i, clamp(sum >> shift));
  }
  store<u8>(dst + <usize>p + 3, load<u8>(src + <usize>p + 3));
}

// 标量颜色矩阵：处理地址 p 处的一个像素。
@inline function colorPixel(src: usize, dst: usize, p: usize, shift: i32): void {
  const r = <i32>load<u8>(src + p), g = <i32>load<u8>(src + p + 1), b = <i32>load<u8>(src + p + 2);
  for (let channel = 0; channel < 3; channel++) {
    const base = 2 + channel * 4;
    store<u8>(dst + p + channel,
      clamp((param(base) * r + param(base + 1) * g + param(base + 2) * b + param(base + 3)) >> shift));
  }
  store<u8>(dst + p + 3, load<u8>(src + p + 3));
}

// SIMD 卷积：一次处理四个 RGBA 像素（16 个通道），三条路径与 C++ 的 convolve_four 一一对应。
// v128 是 128 位向量寄存器，可以看成 16 个 u8、8 个 i16 或 4 个 i32；一条指令同时算其中每一格。
// 像素是 u8，但乘权重后会超出 0..255，所以先 extend 成 i16（16 字节拆成 low / high 两组各 8 个）再算。
// 注意 Alpha 通道也跟着算了，结果是无意义的值，最后用 bitselect 换回原 Alpha。
@inline function convolveFour(src: usize, dst: usize, p: usize, bias: i32, shift: i32): void {
  let rgb: v128;
  if (tapPath == SMALL) {
    let low = i16x8.splat(<i16>bias);
    let high = low;
    for (let t = 0; t < tapCount; t++) {
      const value = v128.load(src + p + <usize>load<i32>(tapOffset + (<usize>t << 2)));
      const weight = i16x8.splat(<i16>load<i32>(tapWeight + (<usize>t << 2)));
      low = i16x8.add(low, i16x8.mul(i16x8.extend_low_i8x16_u(value), weight));
      high = i16x8.add(high, i16x8.mul(i16x8.extend_high_i8x16_u(value), weight));
    }
    rgb = i8x16.narrow_i16x8_u(i16x8.shr_s(low, shift), i16x8.shr_s(high, shift));
  } else {
    let acc0: v128, acc1: v128, acc2: v128, acc3: v128;
    if (tapPath == UNIFORM) {
      let low = i16x8.splat(0);
      let high = low;
      for (let t = 0; t < tapCount; t++) {
        const value = v128.load(src + p + <usize>load<i32>(tapOffset + (<usize>t << 2)));
        low = i16x8.add(low, i16x8.extend_low_i8x16_u(value));
        high = i16x8.add(high, i16x8.extend_high_i8x16_u(value));
      }
      const weight = i16x8.splat(<i16>load<i32>(tapWeight));
      const offset = i32x4.splat(bias);
      acc0 = i32x4.add(offset, i32x4.extmul_low_i16x8_s(low, weight));
      acc1 = i32x4.add(offset, i32x4.extmul_high_i16x8_s(low, weight));
      acc2 = i32x4.add(offset, i32x4.extmul_low_i16x8_s(high, weight));
      acc3 = i32x4.add(offset, i32x4.extmul_high_i16x8_s(high, weight));
    } else {
      acc0 = i32x4.splat(bias);
      acc1 = acc0;
      acc2 = acc0;
      acc3 = acc0;
      for (let t = 0; t < tapCount; t++) {
        const value = v128.load(src + p + <usize>load<i32>(tapOffset + (<usize>t << 2)));
        const low = i16x8.extend_low_i8x16_u(value);
        const high = i16x8.extend_high_i8x16_u(value);
        const weight = i16x8.splat(<i16>load<i32>(tapWeight + (<usize>t << 2)));
        acc0 = i32x4.add(acc0, i32x4.extmul_low_i16x8_s(low, weight));
        acc1 = i32x4.add(acc1, i32x4.extmul_high_i16x8_s(low, weight));
        acc2 = i32x4.add(acc2, i32x4.extmul_low_i16x8_s(high, weight));
        acc3 = i32x4.add(acc3, i32x4.extmul_high_i16x8_s(high, weight));
      }
    }
    // 算术右移后两次饱和收窄（i32→i16→u8）恰好等价于截到 0..255。
    rgb = i8x16.narrow_i16x8_u(
      i16x8.narrow_i32x4_s(i32x4.shr_s(acc0, shift), i32x4.shr_s(acc1, shift)),
      i16x8.narrow_i32x4_s(i32x4.shr_s(acc2, shift), i32x4.shr_s(acc3, shift)));
  }
  // 低 24 位取计算结果，Alpha 字节保留原值。
  v128.store(dst + p, v128.bitselect(rgb, v128.load(src + p), i32x4.splat(0x00ffffff)));
}

// SIMD 颜色矩阵：把四个像素拆成 R / G / B 三个 i32x4，逐通道乘加后按字节拼回 RGBA。
@inline function colorFour(src: usize, dst: usize, p: usize, shift: i32): void {
  const value = v128.load(src + p);
  const zero = i32x4.splat(0);
  // shuffle 按下标从两个向量里挑字节：0..15 取 value，16 取 zero 的 0。
  // 例如 r 取第 0、4、8、12 字节（四个像素的 R），各自补三个 0，变成 4 个 i32。
  const r = i8x16.shuffle(value, zero, 0, 16, 16, 16, 4, 16, 16, 16, 8, 16, 16, 16, 12, 16, 16, 16);
  const g = i8x16.shuffle(value, zero, 1, 16, 16, 16, 5, 16, 16, 16, 9, 16, 16, 16, 13, 16, 16, 16);
  const b = i8x16.shuffle(value, zero, 2, 16, 16, 16, 6, 16, 16, 16, 10, 16, 16, 16, 14, 16, 16, 16);
  const max = i32x4.splat(255);
  // 先只保留每个像素的 Alpha 字节（小端序下 i32 的最高字节），R / G / B 再逐个“或”进来。
  let result = v128.and(value, i32x4.splat(0xff000000));
  for (let channel = 0; channel < 3; channel++) {
    const base = 2 + channel * 4;
    let sum = i32x4.splat(param(base + 3));
    sum = i32x4.add(sum, i32x4.mul(r, i32x4.splat(param(base))));
    sum = i32x4.add(sum, i32x4.mul(g, i32x4.splat(param(base + 1))));
    sum = i32x4.add(sum, i32x4.mul(b, i32x4.splat(param(base + 2))));
    sum = i32x4.min_s(i32x4.max_s(i32x4.shr_s(sum, shift), zero), max);
    result = v128.or(result, i32x4.shl(sum, channel * 8));
  }
  v128.store(dst + p, result);
}

function convolve(src: usize, dst: usize, width: i32, height: i32): void {
  const stride = width * 4;
  const size = stride * height;
  const bias = param(11);
  const shift = param(1);
  buildTaps(stride);
  const uniform = tapPath == UNIFORM && tapCount == 9;
  // 保留最外围一圈像素和所有 Alpha，内部 RGB 做 3x3 整数卷积。
  memory.copy(dst, src, <usize>stride);
  memory.copy(dst + <usize>(size - stride), src + <usize>(size - stride), <usize>stride);
  for (let y = 1; y < height - 1; y++) {
    const row = y * stride;
    store<u32>(dst + <usize>row, load<u32>(src + <usize>row));
    store<u32>(dst + <usize>(row + stride - 4), load<u32>(src + <usize>(row + stride - 4)));
    let x = 1;
    // 先用 SIMD 每次推进 4 个像素，剩下凑不满 4 个的尾巴交给标量逐个处理。
    if (ASC_FEATURE_SIMD) {
      for (; x + 3 < width - 1; x += 4) convolveFour(src, dst, <usize>(row + x * 4), bias, shift);
    }
    for (; x < width - 1; x++) convolvePixel(src, dst, row + x * 4, stride, bias, shift, uniform);
  }
}

function color(src: usize, dst: usize, width: i32, height: i32): void {
  const size = <usize>(width * height * 4);
  const shift = param(1);
  let p: usize = 0;
  if (ASC_FEATURE_SIMD) {
    for (; p + 16 <= size; p += 16) colorFour(src, dst, p, shift);
  }
  for (; p < size; p += 4) colorPixel(src, dst, p, shift);
}

// ---- 导出给 JS 的接口（名字与 C++ 版完全相同）----
// 前四个只是告诉 JS 各缓冲区在线性内存里的地址和能力，真正干活的是 process。
export function get_input(): usize { return input; }
export function get_params(): usize { return params; }
export function get_capacity(): i32 { return CAPACITY; }
export function get_simd(): i32 { return ASC_FEATURE_SIMD ? 1 : 0; }

export function process(width: i32, height: i32, passes: i32): usize {
  // 在相乘前限制尺寸，避免整数溢出；支持小图和非四倍数宽度。
  if (width < 1 || height < 1 || width > 1920 || height > 1080 || passes < 1 || passes > 32 ||
      !validParams()) return 0;
  // 双缓冲：第一轮 input → workA，第二轮 workA → workB，第三轮 workB → workA……input 本身从不被改写。
  let src = input;
  let dst = workA;
  for (let pass = 0; pass < passes; pass++) {
    if (param(0) == KIND_CONVOLUTION) convolve(src, dst, width, height);
    else color(src, dst, width, height);
    src = dst;
    dst = dst == workA ? workB : workA;
  }
  return src;
}
