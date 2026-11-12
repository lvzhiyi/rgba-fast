#include <emscripten.h>
#include <cmath>

#define KH 3
#define KW 3

// 另一份卷积实验草稿：char 整数核 + divisor，与 operations/convolution.cc 的浮点核不同。
// 当前 dip.js 加载的是 operations/convolution.wasm，不直接引用这份源码。
char kernel[KH][KW];
unsigned char data[921600];
// 同样使用固定容量、就地修改像素；只遍历内部区域，边缘保留输入值，divisor 不能为 0。

extern "C" {
  EMSCRIPTEN_KEEPALIVE auto* cppGetkernelPtr() { return kernel; }
  EMSCRIPTEN_KEEPALIVE auto* cppGetDataPtr() { return data; }
  EMSCRIPTEN_KEEPALIVE void cppConvFilter(
    int width,
    int height,
    int divisor) {
    const int half = std::floor(KH / 2);
    for (int y = half; y < height - half; ++y) {
      for (int x = half; x < width - half; ++x) {
        int px = (y * width + x) * 4;
        int r = 0, g = 0, b = 0;
        for (int cy = 0; cy < KH; ++cy) {
          for (int cx = 0; cx < KW; ++cx) {
            const int cpx = ((y + (cy - half)) * width + (x + (cx - half))) * 4;
            r += data[cpx + 0] * kernel[cy][cx];
            g += data[cpx + 1] * kernel[cy][cx];
            b += data[cpx + 2] * kernel[cy][cx];
          }
        }
        data[px + 0] =  ((r / divisor) > 255) ? 255 : ((r / divisor) < 0) ? 0 : r / divisor;
        data[px + 1] =  ((g / divisor) > 255) ? 255 : ((g / divisor) < 0) ? 0 : g / divisor;
        data[px + 2] =  ((b / divisor) > 255) ? 255 : ((b / divisor) < 0) ? 0 : b / divisor;
      }
    }
  }
}
