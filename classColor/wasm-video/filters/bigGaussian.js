import convolution from '../operations/convolution.js';
import wasmConvolution from '../operations/wasmConvolution.js';

// double高斯模糊
const divider = 159;
const operator = [
  2 / divider,
  4 / divider,
  5 / divider,
  4 / divider,
  2 / divider,
  4 / divider,
  9 / divider,
  12 / divider,
  9 / divider,
  4 / divider,
  5 / divider,
  12 / divider,
  15 / divider,
  12 / divider,
  5 / divider,
  4 / divider,
  9 / divider,
  12 / divider,
  9 / divider,
  4 / divider,
  2 / divider,
  4 / divider,
  5 / divider,
  4 / divider,
  2 / divider,
];

const bigGaussian = function (pixels, wasmCale) {
  // JS 使用上面的 5x5 权重；当前 C++ 仅支持 3x3，且 Wasm 包装器不会同步此核。
  // 所以 wasmCale=true 不能直接得到与这个 JS 滤镜相同的高斯模糊。
  if (wasmCale) {
    const _resData = wasmConvolution(pixels);
    return _resData;
  }
  const _resData = convolution(pixels, operator);
  return _resData;
};

bigGaussian.kernel = operator;

export default bigGaussian;
