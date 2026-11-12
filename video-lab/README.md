# video-lab：前端实时视频处理性能实验

对同一帧 RGBA 图像执行 3×3 整数均值模糊，比较 **JavaScript / 标量 Wasm / SIMD128 Wasm** 三条路径的性能，
并支持视频 / 摄像头逐帧实时滤镜：默认走 Worker 端 VideoFrame 管线，可切换到主线程 Canvas 管线作对照。

## 启动

```sh
cd /Users/lv/work/stady/wasm/video-lab
npm run dev
```

打开 <http://127.0.0.1:5500/>（可用 `PORT=xxxx npm run dev` 换端口）。`serve.mjs` 无第三方依赖，
返回正确的 `.wasm` / 视频 MIME、支持 Range，并开启跨源隔离（COOP/COEP）。
仓库已附带编译好的 Wasm，正常使用无需编译工具；可上传本地图片或截取视频帧。

## 目录

```
video-lab/
├── index.html / style.css    页面
├── serve.mjs                 本地静态服务
├── build.mjs                 编译 native/ → wasm/
├── src/
│   ├── app.js                界面、视频实时滤镜、历史与导出
│   ├── kernels.js            JS 实现、Wasm 包装、校验与统计
│   ├── benchmark-worker.js   在 Worker 中执行基准测量
│   ├── pipeline-worker.js    实时管线：VideoFrame → Wasm 内存 → 滤镜 → OffscreenCanvas
│   └── live-stats.js         实时分段计量、掉帧估算、cover 裁剪
├── native/benchmark.cc       C++ 计算核心（标量 + SIMD128）
├── wasm/                     编译产物 benchmark-{scalar,simd}.wasm
├── assets/                   示例图片、视频、图标库
└── tests/                    node:test 单元测试
```

## 测量口径

- JS、标量 Wasm、SIMD Wasm 对同一份固定 RGBA 输入执行相同轮数的 3×3 整数均值模糊。
- 每轮保留边界和 Alpha；使用独立输入与交替输出，避免就地修改造成结果差异。
- 模块加载、编译、缓冲区分配和像素校验均在计时前完成。
- 每条路径预热 12 次，在独立 Worker 中轮换测试顺序，报告中位数和最近秩法 P95。
- 自动选择相同的批量次数（1–32），降低短耗时的计时误差；各样本为每批的单次均值，P95 也是批均值的 P95，不代表逐帧延迟 P95。
- 计算耗时仅包含算法调用；总耗时还包括 Wasm 输入复制、以及所有实现复制到 JS 结果数组。
- JS 不需要跨 Wasm 内存输入复制，因此该列显示空值；这种差异保留在总耗时里。
- 总耗时不包含视频解码和 Canvas 绘制，视频模式另列实际回调 FPS、滤镜和整帧耗时。
- 所有已加载实现的输出必须逐字节一致才能生成性能报告；SIMD 不可用时仍可测标量。
- 导出的 JSON 包含参数、浏览器、校验、每次原始采样和统计；加速比小于 1 表示 Wasm 更慢。
- 模糊轮数对三条路径同时生效，代表连续多轮处理，不是只给 JS 增加工作量。

## 实时管线

| 管线 | 帧来源 | 取帧 | 输出 |
|---|---|---|---|
| Worker · VideoFrame（默认） | `MediaStreamTrackProcessor`（主线程创建后转移 ReadableStream；仅 Worker 提供时转移轨道）；都不可用时主线程按 `requestVideoFrameCallback` 逐帧转移 `VideoFrame` | 尺寸一致：`VideoFrame.copyTo({ format: 'RGBA' })` 直接写入 Wasm 输入区；尺寸不同：`createImageBitmap` 裁剪缩放后再 `copyTo`；不支持 RGBA 转换时回退 Canvas 读像素 | 预建在 Wasm 输出区上的 `ImageData`，`putImageData` 到 `OffscreenCanvas` |
| 主线程 · Canvas（对照） | `requestVideoFrameCallback`（不支持时 rAF） | `drawImage` + `getImageData` + 复制进 Wasm | `putImageData` |

- 输入源可选示例视频（`captureStream`）或摄像头（`getUserMedia`，按所选分辨率请求）。
- 分段统计：取帧 / 处理 / 输出 / 整帧（均值与 P95）、处理帧率、累计掉帧与掉帧率；页面显示实际取帧路径与帧来源。
- 掉帧口径：`MediaStreamTrackProcessor` 路径按相邻帧时间戳间隔与标称帧间隔（轨道 `frameRate`，缺失时取观测最小间隔）估算；
  逐帧转移与主线程路径按 `presentedFrames` 跳号及 Worker 忙时跳过的帧精确计数。
- “零拷贝”指不经过中间 JS 缓冲区：`copyTo` 本身仍有一次 GPU/解码器 → Wasm 内存的读回与格式转换，`putImageData` 仍有一次写入画布。
- 页面不可见或被浏览器节流时，视频帧回调会降频，主线程与逐帧转移路径的帧率和掉帧不代表真实性能。

## 编译与测试

```sh
npm run build   # 重新编译 wasm/
npm test
```

`build.mjs` 使用支持 wasm32 的 Clang 和 `wasm-ld`，可通过 `CLANG`、`WASM_LD` 指定路径，
也能使用本机 Rust 工具链随附的 `rust-lld`。两份模块均以 `-O3` 编译，SIMD 版额外启用
`-msimd128`，不依赖 Emscripten 运行时、WASI 导入或系统标准库。

优化后的 JS 也会被 JIT 优化；SIMD 和数据量可以放大可并行计算的收益，但不保证每台设备都加速。

## 增强路线

1. ✅ **零拷贝实时管线**：`MediaStreamTrackProcessor` / `VideoFrame` + `OffscreenCanvas`，整条管线移入 Worker；
   `VideoFrame.copyTo()` 直接写入 Wasm 内存；增加摄像头输入；按取帧 / 处理 / 输出分段统计与掉帧率。
2. **GPU 对照**：WebGL2 shader（可选 WebGPU compute），给出 CPU SIMD 与 GPU 的取舍结论。
3. **贴近直播**：`captureStream` + `MediaRecorder` / WebRTC 模拟推拉流；美白、双边滤波磨皮、绿幕抠像；Canvas 弹幕层。
4. **多设备报告**：Mac、安卓中端机、iPhone 实测数据汇总。
