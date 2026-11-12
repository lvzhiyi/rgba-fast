// 调节透明通道
const alpha = function (pixels) {
  // 原地修改每个像素第 4 个通道，透明度固定为 155/255，RGB 不变。
  let d = pixels.data

  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = 155
  }

  return pixels
}

export default alpha
