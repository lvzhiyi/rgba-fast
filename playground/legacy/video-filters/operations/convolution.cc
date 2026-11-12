#include <emscripten.h>
#include <cmath>

#define SIDE 3

// 当前实现只支持 3x3 核；JS 初始化时将浮点权重写入 kernel。
float kernel[9];
// 固定像素区：921600 字节可容纳 230400 个 RGBA 像素（例如 640x360）。
// 宽 * 高 * 4 超过此值会越界，当前导出函数没有检查。
unsigned char data[921600];

extern "C"
{
  // C 链接名便于 JS 查找导出；KEEPALIVE 要求 Emscripten 保留这些入口。
  EMSCRIPTEN_KEEPALIVE auto *cppGetkernelPtr() { return kernel; }
  EMSCRIPTEN_KEEPALIVE auto *cppGetDataPtr() { return data; }
  EMSCRIPTEN_KEEPALIVE void cppConvFilter(
      int canvasWidth,
      int canvasHeight)
  {
    const int halfSide = std::floor(SIDE / 2);
    const int side = SIDE;
    for (int y = 0; y < canvasHeight; ++y)
    {
      for (int x = 0; x < canvasWidth; ++x)
      {
        int dstOff = (y * canvasWidth + x) * 4;
        // 权重为 float、累加器却是 int，每次 += 都会截去小数，与 JS 浮点累加不同。
        int sumReds = 0, sumGreens = 0, sumBlues = 0;

        for (int kernelY = 0; kernelY < side; ++kernelY)
        {
          for (int kernelX = 0; kernelX < side; ++kernelX)
          {
            int currentKernelY = y + kernelY - halfSide;
            int currentKernelX = x + kernelX - halfSide;

            if (
                currentKernelY >= 0 &&
                currentKernelY < canvasHeight &&
                currentKernelX >= 0 &&
                currentKernelX < canvasWidth)
            {
              int offset = (currentKernelY * canvasWidth + currentKernelX) * 4;
              float weight = kernel[kernelY * SIDE + kernelX];

              sumReds += data[offset] * weight;
              sumGreens += data[offset + 1] * weight;
              sumBlues += data[offset + 2] * weight;
            }
          }
        }

        // 就地写回：后续像素会读到已经修改的邻居，与 JS 独立输出缓冲区的结果不同。
        // 因此当前示例能比较耗时，但不能假定两种实现输出完全一致。
        data[dstOff] = sumReds > 255 ? 255 : sumReds < 0 ? 0 : sumReds;
        data[dstOff + 1] = sumGreens > 255 ? 255 : sumGreens < 0 ? 0 : sumGreens;
        data[dstOff + 2] = sumBlues > 255 ? 255 : sumBlues < 0 ? 0 : sumBlues;
        data[dstOff + 3] = 255;
      }
    }
  }
}
