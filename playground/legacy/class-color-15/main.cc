#include <iostream>
#include <emscripten.h>

// 独立的 Emscripten 入门示例：导出 add，main 输出 add(10,20)，不参与视频滤镜。
// 同目录 main.js、main.html、main.wasm 为生成产物，注释应维护在本源码中。
extern "C" {
  EMSCRIPTEN_KEEPALIVE
  int add(int x, int y) {
  return x + y;
  }
}

int main(int argc, char **argv) {
  std::cout << add(10, 20) << std::endl;
  return 0;
}
