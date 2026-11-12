
void averageImgData(int *data, int length, int averageSize) {
  // C 平均色实验：累加 RGB，再通过宿主导入函数 getRgb 回传给 JS。
  // int* 通常每项 4 字节，与 Uint8Array 的 RGBA 字节布局不一致，需要统一传参布局。
  auto int i = 0;
  auto int count = 0;
  int r =0;
  int g =0;
  int b =0;

  // 先检查再递增，跳过首像素且末次可能越界；length 为 0 时后面还会除以 0。
  while (i < length) {
    ++count;
    i = i + averageSize;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }

  // char 的有符号性可能导致 128~255 的颜色值转成负数。
  r = (char)(r / count);
  g = (char)(g / count);
  b = (char)(b / count);

  // 需要提供函数声明，并在编译/链接时配置对应 JS 的 env.getRgb 导入。
  getRgb(r,g,b);
}

int main(){
  return 1;
}
