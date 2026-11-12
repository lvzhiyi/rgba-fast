#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

// 三块独立缓冲区：固定输入 + 两个交替输出，最多支持 1920x1080。
// 不依赖 C++ 标准库，可用 Clang 或 Emscripten 编译成无导入的 Wasm。
constexpr int CAPACITY = 1920 * 1080 * 4;
alignas(16) static unsigned char input[CAPACITY];
alignas(16) static unsigned char work_a[CAPACITY];
alignas(16) static unsigned char work_b[CAPACITY];

// 效果参数（全部为整数，保证 JS / 标量 / SIMD 三条实现逐字节一致）：
//   params[0] 类型：0 = 3x3 卷积，1 = 颜色矩阵
//   params[1] 右移位数 shift，结果 = clamp((加权和 + bias) >> shift, 0, 255)，>> 为算术右移（向下取整）
//   卷积：params[2..10] 九个权重（行优先），params[11] bias；保留最外围一圈像素
//   颜色矩阵：params[2..13] 三行 [r, g, b, bias]，逐像素作用于全部像素
//   Alpha 始终保持不变。
constexpr int KIND_CONVOLUTION = 0;
constexpr int KIND_COLOR = 1;
constexpr int PARAM_COUNT = 16;
constexpr int WEIGHT_LIMIT = 32767;  // SIMD 卷积以 16 位有符号数参与乘法
constexpr long long SUM_LIMIT = 2147483647;
// 默认是均值模糊：对 0..2295 的九点和，(sum * 7282) >> 16 与 floor(sum / 9) 完全一致。
static int params[PARAM_COUNT] = {KIND_CONVOLUTION, 16,
                                  7282, 7282, 7282, 7282, 7282, 7282, 7282, 7282, 7282, 0};

// 卷积按参数选择最快且仍然精确的路径：
//   UNIFORM：非零权重全部相同 → 先把像素加起来，最后只乘一次（均值模糊）
//   SMALL：  |bias| + 255 × Σ|w| ≤ 32767 → 整个累加都放得进 16 位，SIMD 一次处理 8 个通道
//   GENERAL：其余情况用 32 位累加
enum Path { UNIFORM, SMALL, GENERAL };

struct Taps {
  int count;
  int offset[9];
  int weight[9];
  Path path;
};

static long long magnitude(int value) { return value < 0 ? -(long long)value : value; }

// 检查参数能否在 32 位整数内无溢出地累加；非法参数让 process 返回空指针。
static bool valid_params() {
  const int shift = params[1];
  if (shift < 0 || shift > 30) return false;
  if (params[0] == KIND_CONVOLUTION) {
    long long total = magnitude(params[11]);
    for (int i = 2; i < 11; ++i) {
      if (magnitude(params[i]) > WEIGHT_LIMIT) return false;
      total += magnitude(params[i]) * 255;
    }
    return total <= SUM_LIMIT;
  }
  if (params[0] == KIND_COLOR) {
    for (int row = 0; row < 3; ++row) {
      const int *m = params + 2 + row * 4;
      long long total = magnitude(m[3]);
      for (int i = 0; i < 3; ++i) {
        if (magnitude(m[i]) > WEIGHT_LIMIT) return false;
        total += magnitude(m[i]) * 255;
      }
      if (total > SUM_LIMIT) return false;
    }
    return true;
  }
  return false;
}

static inline unsigned char clamp(int value) {
  return value < 0 ? 0 : value > 255 ? 255 : (unsigned char)value;
}

// 只保留非零权重的抽头，并按当前行宽换算成字节偏移。
static Taps build_taps(int stride) {
  Taps taps{};
  for (int row = -1; row <= 1; ++row) {
    for (int col = -1; col <= 1; ++col) {
      const int weight = params[2 + (row + 1) * 3 + (col + 1)];
      if (!weight) continue;
      taps.offset[taps.count] = row * stride + col * 4;
      taps.weight[taps.count] = weight;
      ++taps.count;
    }
  }
  long long total = magnitude(params[11]);
  bool uniform = taps.count > 0;
  for (int t = 0; t < taps.count; ++t) {
    total += magnitude(taps.weight[t]) * 255;
    uniform = uniform && taps.weight[t] == taps.weight[0];
  }
  // 等权重时像素和最大 9 × 255 = 2295，乘以权重后再判断能否沿用 32 位以内。
  taps.path = uniform ? UNIFORM : total <= 32767 ? SMALL : GENERAL;
  return taps;
}

// 标量路径固定遍历九个邻居（零权重也算），循环次数是常量，编译器可以完全展开。
static void convolve_pixel(const unsigned char *src, unsigned char *dst, int p, const Taps &taps,
                           const int *weights, const int *offsets, int bias, int shift) {
  for (int channel = 0; channel < 3; ++channel) {
    const int i = p + channel;
    int sum = 0;
    if (taps.path == UNIFORM && taps.count == 9) {
      for (int t = 0; t < 9; ++t) sum += src[i + offsets[t]];
      sum = sum * taps.weight[0] + bias;
    } else {
      sum = bias;
      for (int t = 0; t < 9; ++t) sum += weights[t] * src[i + offsets[t]];
    }
    dst[i] = clamp(sum >> shift);
  }
  dst[p + 3] = src[p + 3];
}

static void color_pixel(const unsigned char *src, unsigned char *dst, int p, int shift) {
  const int r = src[p], g = src[p + 1], b = src[p + 2];
  for (int channel = 0; channel < 3; ++channel) {
    const int *m = params + 2 + channel * 4;
    dst[p + channel] = clamp((m[0] * r + m[1] * g + m[2] * b + m[3]) >> shift);
  }
  dst[p + 3] = src[p + 3];
}

#ifdef __wasm_simd128__
// 一次处理四个 RGBA 像素（16 个通道），先把 u8 扩展到 16 位。
static v128_t finish_alpha(v128_t rgb, const unsigned char *src, int p) {
  return wasm_v128_bitselect(rgb, wasm_v128_load(src + p), wasm_i32x4_splat(0x00ffffff));
}

static void convolve_four(const unsigned char *src, unsigned char *dst, int p, const Taps &taps,
                          int bias, int shift) {
  if (taps.path == SMALL) {
    // 16 位乘加：8 个通道一组，任何中间和都不超过 ±32767，算术右移后饱和收窄即为截断。
    v128_t low = wasm_i16x8_splat((short)bias), high = low;
    for (int t = 0; t < taps.count; ++t) {
      const v128_t value = wasm_v128_load(src + p + taps.offset[t]);
      const v128_t weight = wasm_i16x8_splat((short)taps.weight[t]);
      low = wasm_i16x8_add(low, wasm_i16x8_mul(wasm_u16x8_extend_low_u8x16(value), weight));
      high = wasm_i16x8_add(high, wasm_i16x8_mul(wasm_u16x8_extend_high_u8x16(value), weight));
    }
    wasm_v128_store(dst + p, finish_alpha(wasm_u8x16_narrow_i16x8(
        wasm_i16x8_shr(low, shift), wasm_i16x8_shr(high, shift)), src, p));
    return;
  }
  v128_t acc0, acc1, acc2, acc3;
  if (taps.path == UNIFORM) {
    // 先在 16 位里求像素和（最大 2295），再一次扩展乘法到 32 位。
    v128_t low = wasm_i16x8_splat(0), high = low;
    for (int t = 0; t < taps.count; ++t) {
      const v128_t value = wasm_v128_load(src + p + taps.offset[t]);
      low = wasm_i16x8_add(low, wasm_u16x8_extend_low_u8x16(value));
      high = wasm_i16x8_add(high, wasm_u16x8_extend_high_u8x16(value));
    }
    const v128_t weight = wasm_i16x8_splat((short)taps.weight[0]);
    const v128_t offset = wasm_i32x4_splat(bias);
    acc0 = wasm_i32x4_add(offset, wasm_i32x4_extmul_low_i16x8(low, weight));
    acc1 = wasm_i32x4_add(offset, wasm_i32x4_extmul_high_i16x8(low, weight));
    acc2 = wasm_i32x4_add(offset, wasm_i32x4_extmul_low_i16x8(high, weight));
    acc3 = wasm_i32x4_add(offset, wasm_i32x4_extmul_high_i16x8(high, weight));
  } else {
    // 通用路径：与 i16 权重做扩展乘法累加到 i32，避免溢出。
    acc0 = acc1 = acc2 = acc3 = wasm_i32x4_splat(bias);
    for (int t = 0; t < taps.count; ++t) {
      const v128_t value = wasm_v128_load(src + p + taps.offset[t]);
      const v128_t low = wasm_u16x8_extend_low_u8x16(value);
      const v128_t high = wasm_u16x8_extend_high_u8x16(value);
      const v128_t weight = wasm_i16x8_splat((short)taps.weight[t]);
      acc0 = wasm_i32x4_add(acc0, wasm_i32x4_extmul_low_i16x8(low, weight));
      acc1 = wasm_i32x4_add(acc1, wasm_i32x4_extmul_high_i16x8(low, weight));
      acc2 = wasm_i32x4_add(acc2, wasm_i32x4_extmul_low_i16x8(high, weight));
      acc3 = wasm_i32x4_add(acc3, wasm_i32x4_extmul_high_i16x8(high, weight));
    }
  }
  // 算术右移后，两次饱和收窄（i32→i16→u8）恰好等价于截到 0..255。
  const v128_t rgb = wasm_u8x16_narrow_i16x8(
      wasm_i16x8_narrow_i32x4(wasm_i32x4_shr(acc0, shift), wasm_i32x4_shr(acc1, shift)),
      wasm_i16x8_narrow_i32x4(wasm_i32x4_shr(acc2, shift), wasm_i32x4_shr(acc3, shift)));
  wasm_v128_store(dst + p, finish_alpha(rgb, src, p));
}

// 颜色矩阵：把四个像素拆成 R/G/B 三个 i32x4，逐通道乘加后再按字节拼回 RGBA。
static void color_four(const unsigned char *src, unsigned char *dst, int p, int shift) {
  const v128_t value = wasm_v128_load(src + p);
  const v128_t zero = wasm_i32x4_splat(0);
  const v128_t r = wasm_i8x16_shuffle(value, zero, 0, 16, 16, 16, 4, 16, 16, 16, 8, 16, 16, 16, 12, 16, 16, 16);
  const v128_t g = wasm_i8x16_shuffle(value, zero, 1, 16, 16, 16, 5, 16, 16, 16, 9, 16, 16, 16, 13, 16, 16, 16);
  const v128_t b = wasm_i8x16_shuffle(value, zero, 2, 16, 16, 16, 6, 16, 16, 16, 10, 16, 16, 16, 14, 16, 16, 16);
  const v128_t max = wasm_i32x4_splat(255);
  v128_t result = wasm_v128_and(value, wasm_i32x4_splat((int)0xff000000));
  for (int channel = 0; channel < 3; ++channel) {
    const int *m = params + 2 + channel * 4;
    v128_t sum = wasm_i32x4_splat(m[3]);
    sum = wasm_i32x4_add(sum, wasm_i32x4_mul(r, wasm_i32x4_splat(m[0])));
    sum = wasm_i32x4_add(sum, wasm_i32x4_mul(g, wasm_i32x4_splat(m[1])));
    sum = wasm_i32x4_add(sum, wasm_i32x4_mul(b, wasm_i32x4_splat(m[2])));
    sum = wasm_i32x4_min(wasm_i32x4_max(wasm_i32x4_shr(sum, shift), zero), max);
    result = wasm_v128_or(result, wasm_i32x4_shl(sum, channel * 8));
  }
  wasm_v128_store(dst + p, result);
}
#endif

static void convolve(const unsigned char *src, unsigned char *dst, int width, int height) {
  const int stride = width * 4;
  const int size = stride * height;
  const int bias = params[11];
  const int shift = params[1];
  const Taps taps = build_taps(stride);
  const int *weights = params + 2;
  const int offsets[9] = {-stride - 4, -stride, -stride + 4, -4, 0, 4, stride - 4, stride, stride + 4};
  // 保留最外围一圈像素和所有 Alpha，内部 RGB 做 3x3 整数卷积。
  for (int i = 0; i < stride; ++i) {
    dst[i] = src[i];
    dst[size - stride + i] = src[size - stride + i];
  }
  for (int y = 1; y < height - 1; ++y) {
    const int row = y * stride;
    for (int c = 0; c < 4; ++c) {
      dst[row + c] = src[row + c];
      dst[row + stride - 4 + c] = src[row + stride - 4 + c];
    }
    int x = 1;
#ifdef __wasm_simd128__
    for (; x + 3 < width - 1; x += 4) convolve_four(src, dst, row + x * 4, taps, bias, shift);
#endif
    for (; x < width - 1; ++x) convolve_pixel(src, dst, row + x * 4, taps, weights, offsets, bias, shift);
  }
}

static void color(const unsigned char *src, unsigned char *dst, int width, int height) {
  const int size = width * height * 4;
  const int shift = params[1];
  int p = 0;
#ifdef __wasm_simd128__
  for (; p + 16 <= size; p += 16) color_four(src, dst, p, shift);
#endif
  for (; p < size; p += 4) color_pixel(src, dst, p, shift);
}

extern "C" {
unsigned char *get_input() { return input; }
int *get_params() { return params; }
int get_capacity() { return CAPACITY; }
int get_simd() {
#ifdef __wasm_simd128__
  return 1;
#else
  return 0;
#endif
}

unsigned char *process(int width, int height, int passes) {
  // 在相乘前限制尺寸，避免整数溢出；支持小图和非四倍数宽度。
  if (width < 1 || height < 1 || width > 1920 || height > 1080 || passes < 1 || passes > 32 ||
      !valid_params())
    return nullptr;
  const unsigned char *src = input;
  unsigned char *dst = work_a;
  for (int pass = 0; pass < passes; ++pass) {
    if (params[0] == KIND_CONVOLUTION) convolve(src, dst, width, height);
    else color(src, dst, width, height);
    src = dst;
    dst = dst == work_a ? work_b : work_a;
  }
  return const_cast<unsigned char *>(src);
}
}
