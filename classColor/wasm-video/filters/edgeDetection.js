import convolution from '../operations/convolution.js'

// 边缘检测
const operator = [-1, -1, -1, -1, 8, -1, -1, -1, -1]
// 中心为 8、邻居为 -1：突出局部变化；负响应会被卷积函数截为 0。
const edgeDetection = function (pixels) {

  return convolution(pixels, operator)
}

edgeDetection.kernel = operator;

export default edgeDetection
