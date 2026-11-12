import isDiagonal from '../utils/diagonal.js';


const gray = function (pixels) {
  // 局部灰度实验：命中区域的 R、G 直接取 B，不是常见的加权亮度灰度算法。
  // i 是 RGBA 字节索引，而 isDiagonal 按像素序号计算坐标，当前区域判断存在单位不一致。
  for (let i = 0; i < pixels.data.length; i += 4) {
    let r = pixels.data[i]
    let g = pixels.data[i + 1]
    let b = pixels.data[i + 2]

    const bottomLeft = isDiagonal(pixels.width, pixels.height, i, 'bottomLeft');
    if(bottomLeft){
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2]
    }
  }

  return pixels
}

export default gray
