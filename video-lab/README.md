# video-lab：前端实时视频处理性能实验

对同一帧 RGBA 图像执行同一种整数图像效果（3×3 卷积或颜色矩阵，共 9 种），比较 **JavaScript**、四个 Wasm 构建（**C++ / AssemblyScript** × **标量 / SIMD128**）以及 **WebGL2 片元着色器**和 **WebGPU compute** 的性能。
实时预览使用视频或摄像头，支持在 Worker 内切换 CPU 滤镜与两种 GPU 实现直接出画，也可用主线程 Canvas 作对照。

## 启动

```sh
npm ci
npm run dev
```

打开 <http://127.0.0.1:5500/>，可用 `PORT=xxxx npm run dev` 换端口。需要 Node.js 22.13+（22.x）或 23.5+，测试和 Wasm 构建脚本由 Node.js 直接运行 TypeScript。
仓库已附带编译好的 Wasm，启动页面无需安装 Wasm 编译工具。

`npm run typecheck` 单独执行严格类型检查，`npm run build` 先检查类型再生成 `dist/`，`npm run preview` 可在本地预览。Vite 的开发和预览服务都配置了跨源隔离响应头。将 `dist/` 部署到其他静态服务器时，需同步配置 `vite.config.ts` 中的 COOP/COEP 响应头。

## 目录

```
video-lab/
├── index.html / style.css    HTML 入口和页面样式
├── vite.config.ts            React 插件、开发和预览服务配置
├── build.ts                 编译 native/ 与 assembly/ → wasm/
├── src/
│   ├── main.tsx / App.tsx    React 入口、页面状态与交互
│   ├── components/          基准面板、测试历史和视频预览
│   ├── useBenchmark.ts      基准 Worker 生命周期、历史和导出
│   ├── useFixedFrame.ts     固定帧、图片与视频截图
│   ├── live-video.ts        媒体会话、帧调度、主线程处理和实时 Worker 调用
│   ├── worker-protocol.ts   主线程与 Worker 共用的消息类型
│   ├── wasm-assets.ts       Vite 构建产物中的 Wasm URL
│   ├── effects.ts            效果表：卷积核 / 颜色矩阵的整数参数、校验与编码
│   ├── kernels.ts            JS 实现、Wasm 包装、校验与统计
│   ├── benchmark-worker.ts   在 Worker 中执行基准测量
│   ├── webgl.ts              WebGL2 整数片元滤镜、GPU 计时和画布输出
│   ├── webgpu.ts             WebGPU 整数计算滤镜、GPU 计时和画布输出
│   ├── pipeline-worker.ts    Worker 视频帧调度及 CPU / WebGL2 出画
│   └── live-stats.ts         实时分段计量、掉帧估算、cover 裁剪
├── native/benchmark.cc       C++ 计算核心（标量 + SIMD128）
├── assembly/effects.ts       AssemblyScript 计算核心（与 C++ 同一算法、同一内存布局）
├── wasm/                     编译产物 benchmark-{scalar,simd}.wasm（C++）、
│                             assemblyscript-{scalar,simd}.wasm（AssemblyScript）
├── assets/                   示例图片和视频
└── tests/                    Node 单元测试和浏览器 WebGL2 像素回归
```

## 测量口径

- 各实现对同一份固定 RGBA 输入执行相同效果、相同轮数的整数处理。
- 每轮保留边界和 Alpha；使用独立输入与交替输出，避免就地修改造成结果差异。
- 模块加载、编译、缓冲区分配和像素校验均在计时前完成。
- 每条路径预热 12 次，在独立 Worker 中轮换测试顺序，报告中位数和最近秩法 P95。
- 自动选择相同的批量次数（1–32），降低短耗时的计时误差；各样本为每批的单次均值，P95 也是批均值的 P95，不代表逐帧延迟 P95。
- CPU 计算列计算法调用。两条 GPU 路径使用独立的异步硬件查询，计已上传纹理上的滤镜执行。扩展缺失或查询无有效结果时，这一列显示空值。
- 固定帧总耗时从 JS RGBA 输入计到拿回 JS RGBA 输出。GPU 输入列计主机上传调用，输出列含 GPU 等待与读回。WebGL2 将 readPixels 的结果写入复用的 PBO，等待 fenceSync 后用 getBufferSubData 取回，WebGPU 复制纹理到对齐的读回缓冲区后使用 mapAsync，GPU 查询结果与这些分项独立采样。
- 总耗时不包含视频解码和 Canvas 绘制，视频模式另列实际回调 FPS、滤镜和整帧耗时。
- 所有参测实现都要通过采样前和采样后的逐字节校验。任一 GPU 实现不可用时，其他实现照常测试并显示原因。
- 导出的 JSON 包含参数、浏览器、校验、每次原始采样和统计，以及可用时的 GPU 读回格式。表下对两条 GPU 路径分别以 C++ SIMD 为基准给出含读回总耗时比。
- 处理轮数对所有路径同时生效，代表连续多轮处理，不是只给 JS 增加工作量。

## 效果

所有效果都用整数参数描述，结果统一为 `clamp((加权和 + bias) >> shift, 0, 255)`（`>>` 为算术右移，即向下取整），
Alpha 始终不变，因此所有实现可以逐字节一致。参数表在 [`src/effects.ts`](src/effects.ts)，通过 `get_params()` 写进 Wasm 内存，
切换效果不需要重新编译或重启实时管线。

| 类型 | 效果 | 参数 |
|---|---|---|
| 3×3 卷积（保留最外围一圈像素） | 均值模糊 | 九个 7282，`>> 16`（与 `floor(sum / 9)` 完全一致） |
| | 高斯模糊 | `1 2 1 / 2 4 2 / 1 2 1`，`>> 4` |
| | 锐化 | `0 -1 0 / -1 5 -1 / 0 -1 0` |
| | 边缘检测 | 中心 8、其余 -1 |
| | 浮雕 | `-2 -1 0 / -1 1 1 / 0 1 2`，bias 128 |
| 颜色矩阵（逐像素） | 灰度、怀旧、暖色提亮、反色 | 3 × 4 矩阵 `[r g b bias]`，`>> 8` |

参数约束（JS、C++、AssemblyScript 同时检查）：`shift` 为 0–30，权重绝对值 ≤ 32767，`|bias| + 255 × Σ|w|` 不超过 32 位有符号整数。

SIMD 卷积按参数自动选路径：非零权重全部相同（均值模糊）时先在 16 位里求和再乘一次；`|bias| + 255 × Σ|w| ≤ 32767` 时全程 16 位乘加，
一次处理 8 个通道（高斯、锐化、边缘、浮雕）；其余情况用 32 位扩展乘法累加。颜色矩阵把 4 个像素拆成 R/G/B 三个 i32x4 计算。
通用化后，均值模糊在 1280×720 × 4 轮下比改造前的专用实现慢约 10%（SIMD）、15%（标量）、20%（JS），三者的相对比例基本不变。

## 实时管线

| 管线 | 帧来源 | 取帧 | 输出 |
|---|---|---|---|
| Worker · VideoFrame（默认） | `MediaStreamTrackProcessor`（主线程创建后转移 ReadableStream；仅 Worker 提供时转移轨道）；都不可用时主线程按 `requestVideoFrameCallback` 逐帧转移 `VideoFrame` | 尺寸一致：`VideoFrame.copyTo({ format: 'RGBA' })` 直接写入 Wasm 输入区；尺寸不同：`createImageBitmap` 裁剪缩放后再 `copyTo`；不支持 RGBA 转换时回退 Canvas 读像素 | 预建在 Wasm 输出区上的 `ImageData`，`putImageData` 到 `OffscreenCanvas` |
| Worker · WebGL2 | 与 Worker · VideoFrame 共用取帧方式 | 尺寸一致时尝试直接上传 VideoFrame，尺寸不同时先按相同规则裁剪缩放 | 整数滤镜输出纹理绘制到 WebGL2 OffscreenCanvas，无逐帧 JS 像素读回 |
| Worker · WebGPU compute | 同一 Worker 取帧方式 | 视频帧上传到纹理，尺寸不同时先按同一规则裁剪缩放 | WGSL 计算着色器交替写入整数纹理，再由渲染管线出画，无逐帧 JS 像素读回 |
| 主线程 · Canvas（对照） | `requestVideoFrameCallback`（不支持时 rAF） | `drawImage` + `getImageData` + 复制进 Wasm | `putImageData` |

- 输入源可选示例视频（`captureStream`）或摄像头（`getUserMedia`，按所选分辨率请求）。
- 在 Worker 管线的「实时实现」中切换 C++ SIMD128、WebGL2 片元着色器和 WebGPU compute。GPU 不可用时自动选择可用的 CPU 实现。
- GPU 处理段计提交，输出段含等待 GPU 完成，整帧以 GPU 完成为止，页面合成不在计时内。每次最多一帧 GPU 在途，GPU 滤镜时间来自可用的硬件查询。
- 分段统计：取帧 / 处理 / 输出 / 整帧（均值与 P95）、处理帧率、累计掉帧与掉帧率；页面显示实际取帧路径与帧来源。
- 掉帧口径：`MediaStreamTrackProcessor` 路径按相邻帧时间戳间隔与标称帧间隔（轨道 `frameRate`，缺失时取观测最小间隔）估算；
  逐帧转移与主线程路径按 `presentedFrames` 跳号及 Worker 忙时跳过的帧精确计数。
- “零拷贝”指不经过中间 JS 缓冲区：`copyTo` 本身仍有一次 GPU/解码器 → Wasm 内存的读回与格式转换，`putImageData` 仍有一次写入画布。
- 页面不可见或被浏览器节流时，视频帧回调会降频，主线程与逐帧转移路径的帧率和掉帧不代表真实性能。

## GPU 对照实测

WebGL2 固定帧读回采用 `PIXEL_PACK_BUFFER → fenceSync → getBufferSubData`。每次读回等待 GPU 完成后才访问缓冲区，PBO 在预热和后续样本之间复用。WebGPU 采用 `copyTextureToBuffer → mapAsync`。两种实现均按完整一帧拿回 JS 像素计总耗时。

2026-11-14，Apple M5 Pro、Chrome 157 无头模式、生产构建，同一份合成 RGBA 输入。每组预热 12 次并采集 15 批。下表为含读回总耗时中位数，单位 ms。

| 场景 | C++ SIMD128 | WebGL2 异步 PBO | WebGPU compute |
|---|---:|---:|---:|
| 360p 灰度 × 1 | 0.156 | 5.742 | 0.925 |
| 720p 均值模糊 × 4 | 3.265 | 6.827 | 2.942 |
| 1080p 浮雕 × 12 | 19.805 | 8.550 | 3.885 |

当前 WebGL2 通过事件循环轮询完成信号，小图总耗时容易受调度开销影响。1080p 多轮场景中，两种 GPU 实现的含读回总耗时都低于 SIMD。以上数据同时反映着色器、传输、同步和浏览器实现的影响。

实时 1080p 浮雕 × 12，六个约 500 ms 窗口的整帧 P95 中位数分别为 SIMD 26.35 ms、WebGL2 11.91 ms、WebGPU 10.67 ms。三者均约 25 FPS，观察窗口累计掉帧均为 0。实时出画直接使用纹理，PBO 读回用于固定帧基准及像素校验。

## 两种 Wasm 源语言

同一套效果引擎分别用 C++（[`native/benchmark.cc`](native/benchmark.cc)）和 AssemblyScript（[`assembly/effects.ts`](assembly/effects.ts)）实现。
两者的导出函数（`get_input` / `get_params` / `get_capacity` / `get_simd` / `process`）、内存布局、整数公式和 SIMD 路径选择完全相同，
所以 [`kernels.ts`](src/kernels.ts) 的 `WasmProcessor` 不加区分地加载它们，构建清单 `WASM_BUILDS` 新增一项即可接入第五、第六种实现。

AssemblyScript 的语法就是带具体整数类型的 TypeScript：`load<u8>(地址)` / `store<u8>(地址, 值)` 相当于 C++ 的指针读写，
`v128` 系列内置函数与 `wasm_simd128.h` 一一对应；编译期常量 `ASC_FEATURE_SIMD` 相当于 C++ 的 `#ifdef __wasm_simd128__`。
两个模块都无任何导入，体积约 1.7 KB（标量）和 2.6 KB（SIMD）。

Node 24 / Apple Silicon 上 1280×720 × 4 轮的计算耗时（ms，中位数）：

| 效果 | C++ 标量 | AS 标量 | C++ SIMD | AS SIMD |
|---|---|---|---|---|
| 均值模糊 | 11.6 | 16.2 | 3.6 | 3.9 |
| 锐化 | 14.6 | 17.7 | 2.3 | 2.7 |
| 灰度 | 6.5 | 8.0 | 2.0 | 3.0 |

同一算法、同一写法下，AssemblyScript 标量约慢 20–40%，SIMD 卷积约慢 10–25%，SIMD 颜色矩阵约慢 50%：
差距主要来自编译器优化（Clang/LLVM 对比 Binaryen），例如循环内参数读取的外提。页面基准表下方会实时给出两种语言的耗时比。

## 编译与测试

```sh
npm ci
npm run build:wasm  # 重新编译 wasm/；ONLY=cpp 或 ONLY=as 只编其中一种
npm test
```

AssemblyScript 用 `asc -O3 --noAssert --runtime stub` 编译，内存固定 512 页（32 MiB），SIMD 版加 `--enable simd`。
C++ 部分：支持 wasm32 的 Clang 和 `wasm-ld`，可通过 `CLANG`、`WASM_LD` 指定路径，
也能使用本机 Rust 工具链随附的 `rust-lld`。两份模块均以 `-O3` 编译，SIMD 版额外启用
`-msimd128`，不依赖 Emscripten 运行时、WASI 导入或系统标准库。

开发服务器启动后，打开 `/tests/webgl-browser.html` 运行 144 组 WebGL2 像素回归，打开 `/tests/webgl-browser.html?webgpu` 为 WebGPU 跑同一组用例，覆盖 9 种效果、窄图、奇数尺寸、Alpha 和多轮输出。浏览器结果与 Node 测试共用同一份独立参考实现。

优化后的 JS 也会被 JIT 优化；SIMD 和数据量可以放大可并行计算的收益，但不保证每台设备都加速。

## 增强路线

1. ✅ **零拷贝实时管线**：`MediaStreamTrackProcessor` / `VideoFrame` + `OffscreenCanvas`，整条管线移入 Worker；
   `VideoFrame.copyTo()` 直接写入 Wasm 内存；增加摄像头输入；按取帧 / 处理 / 输出分段统计与掉帧率。
2. ✅ **GPU 对照**：WebGL2 fragment shader 和 WebGPU compute 同场对照，包括固定帧含读回基准与 Worker 实时直出。
3. **贴近直播**：`captureStream` + `MediaRecorder` / WebRTC 模拟推拉流；美白、双边滤波磨皮、绿幕抠像；Canvas 弹幕层。
4. **多设备报告**：Mac、安卓中端机、iPhone 实测数据汇总。
