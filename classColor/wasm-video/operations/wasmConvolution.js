import { Unit8View, cppFilter, dataOffset } from '../dip.js';
// 与 dip.js 存在循环导入；这里只在函数调用时读取导出值，仍需等 Wasm 初始化完成。
function wasmConvolution(pixelData) {
  const { data, width, height } = pixelData;
  const arLen = pixelData.data.length;

  Unit8View.set(data, dataOffset);
  // 先把 JS 像素复制到 C++ data 数组，再传宽高让 C++ 就地处理。
  // C++ 源码的 data 固定为 921600 字节，调用前目前没有容量检查。
  cppFilter(width, height);

  // subarray 不复制数据；结果共享 Wasm 内存，下一帧计算时会被覆盖。
  return Unit8View.subarray(dataOffset, dataOffset + arLen);
}



export default wasmConvolution;
