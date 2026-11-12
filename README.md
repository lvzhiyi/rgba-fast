# WebAssembly 学习与实验

| 目录 | 说明 |
|---|---|
| [`video-lab/`](video-lab/) | **主项目**：JS / Wasm / SIMD 实时视频处理性能实验，后续扩展为 Worker 零拷贝视频管线 |
| [`playground/`](playground/) | 早期学习示例，保留作参考，不再维护 |

## playground 内容

| 目录 | 内容 |
|---|---|
| `fibonacci/` | 斐波那契：手写 WAT、C++ 编译与 JS 的耗时对比（`npm run fibonacci`） |
| `c2js/` | Emscripten 把 C 编译成单文件 JS 模块（`build.sh`） |
| `pass-array-to-c/` | JS 向 C 传递数组 |
| `image-colors/` | 读取图片颜色、在 Wasm 与 JS 之间传字符串 |
| `box-blur/` | 早期盒式模糊卷积 |
| `wasi/` | WASI：wasi-sdk 编译（`CC.sh`）与 Node 运行器（`node-runner.js`） |
| `rust-wasm/` | Rust + wasm-bindgen + webpack 示例 |
| `legacy/video-filters/` | video-lab 的前身：旧滤镜、卷积、边缘检测与音频代码 |
| `legacy/class-color-15/` | 早期单页示例 |
| `img/` | 示例图片 |

部分示例依赖 Emscripten、wasi-sdk 或 Rust 工具链，且为早期写法，未保证当前可直接运行。
