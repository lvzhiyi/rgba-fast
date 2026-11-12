// 命中对角像素 type: topRight | bottomLeft;
const isDiagonal = function (width, height, i, type) {
  // 将线性像素序号换成坐标，再判断位于对角线哪侧；RGBA 字节索引应先除以 4。

  // 斜率
  const rate = width / height;

  // 当前坐标位置
  const x = i % width;

  const y = Math.floor(i / width) + 1;
  // 临界值
  const boundary = y * rate;

  return type === 'topRight' ? x >= boundary : x <= boundary;
}

export default isDiagonal
