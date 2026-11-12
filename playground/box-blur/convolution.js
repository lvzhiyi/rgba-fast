const convolution = function (pixels, kernel, outputData) {
  // 卷积核矩阵长度(单边长度)
  let side = Math.round(Math.sqrt(kernel.length))

  let halfSide = Math.floor(side / 2)

  let src = pixels.data
  let canvasWidth = pixels.width
  let canvasHeight = pixels.height

  // 循环图像行
  for (let y = 0; y < canvasHeight; y++) {

    // 循环图像列
    for (let x = 0; x < canvasWidth; x++) {

      // 循环单元，每 4 个为一组
      let dstOff = (y * canvasWidth + x) * 4,
        sumReds = 0,
        sumGreens = 0,
        sumBlues = 0

      // 循环卷积核
      for (let kernelY = 0; kernelY < side; kernelY++) {
        for (let kernelX = 0; kernelX < side; kernelX++) {

          // 忽略超出的边界值，移动卷积核，卷积核中心与当前像素对齐
          let currentKernelY = y + kernelY - halfSide;
          let currentKernelX = x + kernelX - halfSide

          if (
            currentKernelY >= 0 &&
            currentKernelY < canvasHeight &&
            currentKernelX >= 0 &&
            currentKernelX < canvasWidth
          ) {

            // 实际偏移位置
            let offset = (currentKernelY * canvasWidth + currentKernelX) * 4;

            // 权重值 （=第 Y 行 + 第 X 个）；
            let weight = kernel[kernelY * side + kernelX];
            // 累计求和
            sumReds += src[offset] * weight
            sumGreens += src[offset + 1] * weight
            sumBlues += src[offset + 2] * weight
          }
        }
      }
      outputData.data[dstOff] = sumReds > 255 ? 255 : sumReds < 0 ? 0 : sumReds;
      outputData.data[dstOff + 1] = sumGreens > 255 ? 255 : sumGreens < 0 ? 0 : sumGreens;
      outputData.data[dstOff + 2] = sumBlues > 255 ? 255 : sumBlues < 0 ? 0 : sumBlues;
      outputData.data[dstOff + 3] = 255
    }
  }
  return outputData
}

