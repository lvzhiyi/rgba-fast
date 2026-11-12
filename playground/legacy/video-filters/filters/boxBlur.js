import convolution from '../operations/convolution.js';

import wasmConvolution from '../operations/wasmConvolution.js';
const divider = 9;

// 3x3 均值核：九个权重都是 1/9，把邻域 RGB 平均后形成模糊效果。
const operator = [
  1 / divider,
  1 / divider,
  1 / divider,
  1 / divider,
  1 / divider,
  1 / divider,
  1 / divider,
  1 / divider,
  1 / divider,
];

const boxBlur = function (pixels, wasmCale) {
  // JS 路径显式传核；Wasm 路径使用 dip.js 初始化时写入的核，不会在这里更新。
  boxBlur.kernel = operator;

  if (wasmCale) {
    const _resData = wasmConvolution(pixels);
    return _resData;
  }
  const _resData = convolution(pixels, operator);
  return _resData;
};

boxBlur.kernel = operator;

export default boxBlur;
