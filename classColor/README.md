# RGBA 性能对比

## 启动

```sh
python3 -m http.server 5500 --bind 127.0.0.1 --directory /Users/lv/work/stady
```

打开 <http://127.0.0.1:5500/wasm/classColor/index.html>。页面资源使用相对路径，亦可换端口。
页面使用现有 `wasm/img/1.jpg` 和 `classColor/wasm-video/video.mp4`；可上传本地图片或截取视频帧。
已附带编译后的 Wasm，正常使用无需安装依赖或编译工具。

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

## 编译与测试

```sh
cd /Users/lv/work/stady/wasm/classColor
node build.mjs
node --test tests/benchmark.test.mjs
```

`build.mjs` 使用支持 wasm32 的 Clang 和 `wasm-ld`，支持通过 `CLANG`、`WASM_LD` 指定路径，
并能使用本机 Rust 工具链随附的 `rust-lld`。两份模块均以 `-O3` 编译，SIMD 版额外启用
`-msimd128`，不依赖 Emscripten 运行时、WASI 导入或系统标准库。

计算源文件是 `wasm-video/operations/benchmark.cc`；`kernels.js` 提供等价 JS 与 Wasm 包装器，
`benchmark-worker.js` 负责测量，`dip.js` 负责界面与实时视频。
旧 `convolution.*`、滤镜、音频及 `15/` 示例保留供学习，新基准不加载它们。

优化后的 JS 也会被 JIT 优化；SIMD 和数据量可以放大可并行计算的收益，但不保证每台设备都加速。
