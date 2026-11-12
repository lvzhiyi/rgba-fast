import convolution from '../operations/convolution.js';

import wasmConvolution from '../operations/wasmConvolution.js';
const divider = 9;

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
