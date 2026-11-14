import { encodeEffect, PARAM_COUNT } from './effects.ts';
import { validateConfig } from './kernels.ts';
import type { Effect } from './effects.ts';

const groupSize = 8;

// 固定帧与视频共用整数滤镜，参数布局与 encodeEffect 一致。
const filter = `
@group(0) @binding(0) var image: texture_2d<u32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8uint, write>;
@group(0) @binding(2) var<storage, read> params: array<i32, ${PARAM_COUNT}>;

@compute @workgroup_size(${groupSize}, ${groupSize})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(image);
  if (any(id.xy >= size)) { return; }
  let p = vec2i(id.xy);
  let pixel = textureLoad(image, p, 0);
  var sum = vec3i(0);
  if (params[0] == 0) {
    if (any(id.xy == vec2u(0)) || any(id.xy == size - 1u)) {
      textureStore(output, p, pixel);
      return;
    }
    sum = vec3i(params[11]);
    for (var i = 0; i < 9; i++) {
      let offset = vec2i(i % 3 - 1, i / 3 - 1);
      sum += vec3i(textureLoad(image, p + offset, 0).rgb) * params[i + 2];
    }
  } else {
    let rgb = vec3i(pixel.rgb);
    for (var row = 0; row < 3; row++) {
      let i = 2 + row * 4;
      sum[row] = rgb.r * params[i] + rgb.g * params[i + 1] + rgb.b * params[i + 2] + params[i + 3];
    }
  }
  textureStore(output, p, vec4u(vec3u(clamp(sum >> vec3u(u32(params[1])), vec3i(0), vec3i(255))), pixel.a));
}`;

const ingest = `
@group(0) @binding(0) var video: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8uint, write>;
@compute @workgroup_size(${groupSize}, ${groupSize})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(video))) { return; }
  let p = vec2i(id.xy);
  textureStore(output, p, vec4u(round(textureLoad(video, p, 0) * 255.0)));
}`;

const display = `
@group(0) @binding(0) var image: texture_2d<u32>;

@vertex fn vertex(@builtin(vertex_index) id: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((id << 1u) & 2u), f32(id & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fragment(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return vec4f(textureLoad(image, vec2i(p.xy), 0)) / 255.0;
}`;

/** 只在适配器支持 timestamp-query 时分配的计时资源。 */
type Timer = { queries: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer };
/** 实时上传纹理、转换管线及画布输出绑定。 */
type VideoOutput = {
  context: GPUCanvasContext;
  source: GPUTexture;
  ingest: GPUComputePipeline;
  ingestGroup: GPUBindGroup;
  display: GPURenderPipeline;
  groups: GPUBindGroup[];
};

// 每轮只读上一张纹理，交替写入两张 rgba8uint 纹理。
export class WebGPUProcessor {
  private readonly device: GPUDevice;
  private readonly width: number;
  private readonly height: number;
  private readonly input: GPUTexture;
  private readonly outputs: GPUTexture[];
  private readonly params: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly groups: GPUBindGroup[];
  private readonly timer?: Timer;
  private readBuffer?: GPUBuffer;
  private result = 0;
  private video?: VideoOutput;
  private error?: Error;
  readonly readbackFormat = 'rgba8uint → MAP_READ';

  static async create(width: number, height: number) {
    validateConfig(width, height, 1);
    const api = navigator.gpu;
    const adapter = await api?.requestAdapter();
    if (!adapter) throw new Error('当前环境没有可用的 WebGPU 适配器');
    const device = await adapter.requestDevice({
      requiredFeatures: adapter.features.has('timestamp-query') ? ['timestamp-query'] : [],
    });
    device.pushErrorScope('validation');
    try {
      const processor = new WebGPUProcessor(device, width, height);
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      processor.assertHealthy();
      return processor;
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  private constructor(device: GPUDevice, width: number, height: number) {
    this.device = device;
    this.width = width;
    this.height = height;
    device.addEventListener('uncapturederror', event => { this.error = new Error(event.error.message); });
    void device.lost.then(info => { this.error = new Error(`WebGPU 设备已丢失：${info.message}`); });
    const size = [width, height];
    const sampled = GPUTextureUsage.TEXTURE_BINDING;
    const storage = GPUTextureUsage.STORAGE_BINDING;
    this.input = device.createTexture({ size, format: 'rgba8uint', usage: sampled | storage | GPUTextureUsage.COPY_DST });
    this.outputs = [0, 1].map(() => device.createTexture({
      size, format: 'rgba8uint', usage: sampled | storage | GPUTextureUsage.COPY_SRC,
    }));
    this.params = device.createBuffer({ size: PARAM_COUNT * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.pipeline = this.compute(filter);
    this.groups = [this.input, ...this.outputs].map((source, i) => device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.outputs[i === 1 ? 1 : 0].createView() },
        { binding: 2, resource: { buffer: this.params } },
      ],
    }));
    if (device.features.has('timestamp-query')) {
      this.timer = {
        queries: device.createQuerySet({ type: 'timestamp', count: 2 }),
        resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
      };
    }
  }

  private compute(code: string) {
    const device = this.device;
    return device.createComputePipeline({ layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  }

  setEffect(effect: Effect) {
    this.device.queue.writeBuffer(this.params, 0, encodeEffect(effect));
  }

  prepare(source: Uint8Array<ArrayBuffer>) {
    this.device.queue.writeTexture({ texture: this.input }, source, { bytesPerRow: this.width * 4 }, [this.width, this.height]);
  }

  private dispatch(pass: GPUComputePassEncoder) {
    pass.dispatchWorkgroups(Math.ceil(this.width / groupSize), Math.ceil(this.height / groupSize));
  }

  run(passes: number, repeats = 1, timed = false) {
    const device = this.device;
    const encoder = device.createCommandEncoder();
    const timer = timed ? this.timer : undefined;
    const pass = encoder.beginComputePass(timer ? { timestampWrites: {
      querySet: timer.queries, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1,
    } } : undefined);
    pass.setPipeline(this.pipeline);
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (let round = 0; round < passes; round++) {
        pass.setBindGroup(0, this.groups[round === 0 ? 0 : (round - 1) % 2 + 1]);
        this.dispatch(pass);
      }
    }
    pass.end();
    if (timer) {
      encoder.resolveQuerySet(timer.queries, 0, 2, timer.resolve, 0);
      encoder.copyBufferToBuffer(timer.resolve, 0, timer.read, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    this.result = (passes - 1) % 2;
  }

  get supportsGpuTiming() { return this.timer !== undefined; }

  async timerResult() {
    if (!this.timer) return null;
    const { read } = this.timer;
    await read.mapAsync(GPUMapMode.READ);
    try {
      const [start, end] = new BigUint64Array(read.getMappedRange());
      return end >= start ? Number(end - start) / 1e6 : null;
    } finally {
      read.unmap();
    }
  }

  async readback(output: Uint8Array<ArrayBuffer>) {
    const row = this.width * 4;
    const bytesPerRow = Math.ceil(row / 256) * 256;
    const device = this.device;
    const buffer = this.readBuffer ??= device.createBuffer({
      size: bytesPerRow * this.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: this.outputs[this.result] }, { buffer, bytesPerRow }, [this.width, this.height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    try {
      const source = new Uint8Array(buffer.getMappedRange());
      if (row === bytesPerRow) output.set(source);
      else {
        for (let y = 0; y < this.height; y++) output.set(source.subarray(y * bytesPerRow, y * bytesPerRow + row), y * row);
      }
    } finally {
      buffer.unmap();
    }
  }

  prepareVideo(canvas: OffscreenCanvas) {
    const format = navigator.gpu.getPreferredCanvasFormat();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('当前 Worker 无法创建 WebGPU 画布上下文');
    canvas.width = this.width;
    canvas.height = this.height;
    const device = this.device;
    const source = device.createTexture({
      size: [this.width, this.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const ingestPipeline = this.compute(ingest);
    const ingestGroup = device.createBindGroup({ layout: ingestPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: source.createView() }, { binding: 1, resource: this.input.createView() },
    ] });
    const shader = device.createShaderModule({ code: display });
    const displayPipeline = device.createRenderPipeline({ layout: 'auto',
      vertex: { module: shader, entryPoint: 'vertex' },
      fragment: { module: shader, entryPoint: 'fragment', targets: [{ format }] },
    });
    const groups = this.outputs.map(texture => device.createBindGroup({ layout: displayPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: texture.createView() }] }));
    context.configure({ device, format, alphaMode: 'opaque' });
    this.video = { context, source, ingest: ingestPipeline, ingestGroup, display: displayPipeline, groups };
  }

  // 浏览器接管视频格式转换；中间结果经计算着色器转成整数纹理。
  uploadVideo(source: VideoFrame | ImageBitmap) {
    const video = this.video;
    if (!video) throw new Error('尚未初始化 WebGPU 视频纹理');
    const device = this.device;
    device.queue.copyExternalImageToTexture({ source }, { texture: video.source }, [this.width, this.height]);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(video.ingest);
    pass.setBindGroup(0, video.ingestGroup);
    this.dispatch(pass);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  present() {
    const video = this.video;
    if (!video) throw new Error('尚未初始化 WebGPU 画布');
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{
      view: video.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
    }] });
    pass.setPipeline(video.display);
    pass.setBindGroup(0, video.groups[this.result]);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  async waitForFrame() {
    await this.device.queue.onSubmittedWorkDone();
    this.assertHealthy();
  }

  assertHealthy() {
    if (this.error) throw this.error;
  }

  dispose() {
    this.video?.context.unconfigure();
    this.device.destroy();
  }
}
