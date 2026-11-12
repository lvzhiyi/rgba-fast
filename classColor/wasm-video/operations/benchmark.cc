#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

// 三块独立缓冲区：固定输入 + 两个交替输出，最多支持 1920x1080。
// 不依赖 C++ 标准库，可用 Clang 或 Emscripten 编译成无导入的 Wasm。
constexpr int CAPACITY = 1920 * 1080 * 4;
alignas(16) static unsigned char input[CAPACITY];
alignas(16) static unsigned char work_a[CAPACITY];
alignas(16) static unsigned char work_b[CAPACITY];

static void pixel(const unsigned char *src, unsigned char *dst, int p, int stride) {
  for (int channel = 0; channel < 3; ++channel) {
    const int i = p + channel;
    const unsigned sum = src[i - stride - 4] + src[i - stride] + src[i - stride + 4] +
                         src[i - 4] + src[i] + src[i + 4] +
                         src[i + stride - 4] + src[i + stride] + src[i + stride + 4];
    dst[i] = sum / 9;
  }
  dst[p + 3] = src[p + 3];
}

#ifdef __wasm_simd128__
static v128_t divide_nine(v128_t sum) {
  // 对 0..2295 的通道和，(sum * 7282) >> 16 与 floor(sum / 9) 完全一致。
  const v128_t multiplier = wasm_i32x4_splat(7282);
  const v128_t low = wasm_u32x4_shr(
      wasm_i32x4_mul(wasm_u32x4_extend_low_u16x8(sum), multiplier), 16);
  const v128_t high = wasm_u32x4_shr(
      wasm_i32x4_mul(wasm_u32x4_extend_high_u16x8(sum), multiplier), 16);
  return wasm_u16x8_narrow_i32x4(low, high);
}

static void four_pixels(const unsigned char *src, unsigned char *dst, int p, int stride) {
  v128_t low = wasm_i16x8_splat(0);
  v128_t high = wasm_i16x8_splat(0);
  // 每个向量一次处理四个 RGBA 像素，先扩展到 16 位，避免九点累加溢出。
  for (int row = -1; row <= 1; ++row) {
    for (int col = -1; col <= 1; ++col) {
      const v128_t value = wasm_v128_load(src + p + row * stride + col * 4);
      low = wasm_i16x8_add(low, wasm_u16x8_extend_low_u8x16(value));
      high = wasm_i16x8_add(high, wasm_u16x8_extend_high_u8x16(value));
    }
  }
  const v128_t rgb = wasm_u8x16_narrow_i16x8(divide_nine(low), divide_nine(high));
  const v128_t result = wasm_v128_bitselect(
      rgb, wasm_v128_load(src + p), wasm_i32x4_splat(0x00ffffff));
  wasm_v128_store(dst + p, result);
}
#endif

static void blur(const unsigned char *src, unsigned char *dst, int width, int height) {
  const int stride = width * 4;
  const int size = stride * height;
  // 两条实现都保留最外围一圈像素和所有 Alpha，内部 RGB 取整数九点均值。
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
    for (; x + 3 < width - 1; x += 4) four_pixels(src, dst, row + x * 4, stride);
#endif
    for (; x < width - 1; ++x) pixel(src, dst, row + x * 4, stride);
  }
}

extern "C" {
unsigned char *get_input() { return input; }
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
  if (width < 1 || height < 1 || width > 1920 || height > 1080 || passes < 1 || passes > 32)
    return nullptr;
  const unsigned char *src = input;
  unsigned char *dst = work_a;
  for (int pass = 0; pass < passes; ++pass) {
    blur(src, dst, width, height);
    src = dst;
    dst = dst == work_a ? work_b : work_a;
  }
  return const_cast<unsigned char *>(src);
}
}
