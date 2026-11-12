// 未完成的字符串回传实验，保留原代码；当前还缺少 strchr 和宿主 getString 的声明。
void getStr(char *str) {
  // 覆盖传入地址，所以之前计算得到的 RGB 不会在这里被使用。
  str="rgb";

  char *e;
  int index;
  // "rgb" 不含 'e'，strchr 返回空指针，随后 e - str 属于未定义行为。
  e = strchr(str, 'e');
  index = (int)(e - str);
  // sizeof(str) 是指针大小，不是字符串长度；getString 意图调用 JS 宿主回调。
  getString(str, index, sizeof(str));
}

void averageImgData(int *data, int length, int averageSize) {
  // int* 的元素宽度与 JS Uint8Array 不同，需要先统一像素数据的内存布局。
  auto int i = 0;
  auto int count = 0;
  int r =0;
  int g =0;
  int b =0;

  // 递增后才读取，跳过首像素且末次可能越界；length 为 0 时后面的平均值会除以 0。
  while (i < length) {
    ++count;
    i = i + averageSize;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }

  r = (char)(r / count);
  g = (char)(g / count);
  b = (char)(b / count);

  // char* 是指针，这不是合法的 RGB 字符数组构造方式，也没有添加字符串结束符。
  char *str = {r,g,b};
  getStr(str);
}

int main(){
  return 1;
}
