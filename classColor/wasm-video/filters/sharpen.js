import convolution from '../operations/convolution.js'

// 锐化
const operator = [0, -0.2, 0, -0.2, 1.8, -0.2, 0, -0.2, 0]
// 增强中心、减去上下左右邻居，权重总和为 1，以强化局部细节。
const sharpen = function (pixels) {

  return convolution(pixels, operator)
}

sharpen.kernel = operator;

export default sharpen
