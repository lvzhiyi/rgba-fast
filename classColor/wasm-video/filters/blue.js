const blue = function (pixels) {
  // 原地清零 R、G，保留 B 和 Alpha，得到只含蓝色分量的画面。
  let d = pixels.data

  for (let i = 0; i < d.length; i += 4) {
    d[i] = 0
    d[i + 1] = 0
  }

  return pixels
}

export default blue
