import { encodeEffect, PARAM_COUNT } from './effects.ts';
import { validateConfig } from './kernels.ts';
import type { Effect } from './effects.ts';

const vertex = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0, 1);
}`;

// GLSL 与 encodeEffect 共用参数布局：类型、位移，之后为卷积权重及偏移或颜色矩阵。
const filter = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D image;
uniform int params[${PARAM_COUNT}];
out uvec4 result;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 pixel = texelFetch(image, p, 0);
  ivec3 sum = ivec3(0);
  if (params[0] == 0) {
    if (any(equal(p, ivec2(0))) || any(equal(p, textureSize(image, 0) - 1))) {
      result = pixel;
      return;
    }
    sum = ivec3(params[11]);
    for (int i = 0; i < 9; ++i) {
      ivec2 offset = ivec2(i % 3 - 1, i / 3 - 1);
      sum += ivec3(texelFetch(image, p + offset, 0).rgb) * params[i + 2];
    }
  } else {
    ivec3 rgb = ivec3(pixel.rgb);
    for (int row = 0; row < 3; ++row) {
      int i = 2 + row * 4;
      sum[row] = rgb.r * params[i] + rgb.g * params[i + 1] + rgb.b * params[i + 2] + params[i + 3];
    }
  }
  result = uvec4(uvec3(clamp(sum >> params[1], ivec3(0), ivec3(255))), pixel.a);
}`;

const ingest = `#version 300 es
precision highp float;
uniform sampler2D image;
out uvec4 result;
void main() {
  result = uvec4(round(texelFetch(image, ivec2(gl_FragCoord.xy), 0) * 255.0));
}`;

const display = `#version 300 es
precision highp float;
uniform highp usampler2D image;
out vec4 result;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  p.y = textureSize(image, 0).y - 1 - p.y;
  result = vec4(texelFetch(image, p, 0)) / 255.0;
}`;

/** 一张整数纹理及其专用渲染目标。 */
type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };
/** WebGL2 GPU 计时扩展暴露的两个枚举。 */
type TimerExtension = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function createProgram(gl: WebGL2RenderingContext, fragment: string) {
  const program = gl.createProgram();
  if (!program) throw new Error('无法创建 WebGL2 程序');
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('无法创建 WebGL2 着色器');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const details = [gl.getProgramInfoLog(program), ...(gl.getAttachedShaders(program) ?? [])
        .map(shader => gl.getShaderInfoLog(shader))];
      throw new Error(`WebGL2 着色器链接失败：${details.filter(Boolean).join(' ')}`);
    }
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  }
}

// 固定帧和实时预览共用整数滤镜。纹理第 0 行保存源图顶部，只有最终出画时翻转 Y。
export class WebGLProcessor {
  private readonly gl: WebGL2RenderingContext;
  private readonly timer: TimerExtension | null;
  private readonly programs: WebGLProgram[] = [];
  private readonly textures: WebGLTexture[] = [];
  private readonly framebuffers: WebGLFramebuffer[] = [];
  private readonly input: Target;
  private readonly outputs: [Target, Target];
  private readonly filterProgram: WebGLProgram;
  private readonly params: WebGLUniformLocation;
  private readonly byteReadback: boolean;
  private packBuffer?: WebGLBuffer;
  private reading = false;
  private disposed = false;
  private wideReadback?: Uint32Array<ArrayBuffer>;
  private video?: { texture: WebGLTexture; ingest: WebGLProgram; display: WebGLProgram };
  private result?: Target;

  constructor(canvas: OffscreenCanvas, width: number, height: number) {
    validateConfig(width, height, 1);
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl) throw new Error('当前 Worker 无法创建 WebGL2 上下文');
    this.gl = gl;
    try {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DITHER);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
      this.filterProgram = this.program(filter);
      const params = gl.getUniformLocation(this.filterProgram, 'params[0]');
      if (!params) throw new Error('WebGL2 滤镜参数不可用');
      this.params = params;
      this.input = this.target(width, height);
      this.outputs = [this.target(width, height), this.target(width, height)];
      this.byteReadback = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA_INTEGER &&
        gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.UNSIGNED_BYTE;
      this.assertHealthy();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  get readbackFormat() { return this.byteReadback ? 'PBO/RGBA_INTEGER/UNSIGNED_BYTE' : 'PBO/RGBA_INTEGER/UNSIGNED_INT'; }

  private program(source: string) {
    const program = createProgram(this.gl, source);
    this.programs.push(program);
    return program;
  }

  private texture(format: number, width: number, height: number) {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('无法创建 WebGL2 纹理');
    this.textures.push(texture);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, width, height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  private target(width: number, height: number): Target {
    const gl = this.gl;
    const texture = this.texture(gl.RGBA8UI, width, height);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) throw new Error('无法创建 WebGL2 帧缓冲');
    this.framebuffers.push(framebuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('WebGL2 整数帧缓冲不可用');
    }
    return { texture, framebuffer };
  }

  setEffect(effect: Effect) {
    const gl = this.gl;
    gl.useProgram(this.filterProgram);
    gl.uniform1iv(this.params, encodeEffect(effect));
  }

  prepare(source: Uint8Array<ArrayBuffer>) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.input.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
      gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, source);
  }

  prepareVideo() {
    if (this.video) return;
    const gl = this.gl;
    this.video = {
      texture: this.texture(gl.RGBA8, gl.drawingBufferWidth, gl.drawingBufferHeight),
      ingest: this.program(ingest),
      display: this.program(display),
    };
    this.assertHealthy();
  }

  // 使用浏览器管理的图像源上传，转换为整数字节纹理供公共滤镜使用。
  uploadVideo(source: VideoFrame | ImageBitmap) {
    if (!this.video) throw new Error('尚未初始化 WebGL2 视频纹理');
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.video.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.assertHealthy();
    gl.useProgram(this.video.ingest);
    this.draw(this.video.texture, this.input.framebuffer);
  }

  private draw(source: WebGLTexture, destination: WebGLFramebuffer | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, destination);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  run(passes: number) {
    this.gl.useProgram(this.filterProgram);
    let src = this.input;
    for (let i = 0; i < passes; i++) {
      const dst = this.outputs[i % 2];
      this.draw(src.texture, dst.framebuffer);
      src = dst;
    }
    this.result = src;
  }

  // PBO 接收 GPU 写入；完成信号就绪后再把字节复制到 JS，缓冲区跨采样复用。
  async readback(output: Uint8Array<ArrayBuffer>) {
    this.assertHealthy();
    if (!this.result) throw new Error('WebGL2 尚无可读回的输出');
    if (this.reading) throw new Error('WebGL2 上一次读回尚未完成');
    const gl = this.gl;
    const length = gl.drawingBufferWidth * gl.drawingBufferHeight * 4;
    if (output.length !== length) throw new RangeError('WebGL2 输出缓冲区长度不匹配');
    this.reading = true;
    try {
      if (!this.packBuffer) {
        const buffer = gl.createBuffer();
        if (!buffer) throw new Error('无法创建 WebGL2 读回缓冲区');
        this.packBuffer = buffer;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, length * (this.byteReadback ? 1 : 4), gl.STREAM_READ);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.result.framebuffer);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.packBuffer);
      gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        gl.RGBA_INTEGER, this.byteReadback ? gl.UNSIGNED_BYTE : gl.UNSIGNED_INT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      await this.waitForFrame(() => !this.disposed);
      this.assertHealthy();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.packBuffer);
      if (this.byteReadback) gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, output);
      else {
        const wide = this.wideReadback ??= new Uint32Array(length);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, wide);
        output.set(wide);
      }
      this.assertHealthy();
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.reading = false;
    }
  }

  present() {
    if (!this.video || !this.result) throw new Error('WebGL2 尚无可显示的视频输出');
    this.gl.useProgram(this.video.display);
    this.draw(this.result.texture, null);
  }

  startTimer() {
    const gl = this.gl;
    if (!this.timer || gl.getParameter(this.timer.GPU_DISJOINT_EXT)) return null;
    const query = gl.createQuery();
    if (query) gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
    return query;
  }

  stopTimer(query: WebGLQuery | null) {
    if (this.timer && query) this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
  }

  async timerResult(query: WebGLQuery | null, wait = true) {
    if (!query || !this.timer) return null;
    const gl = this.gl;
    try {
      const limit = performance.now() + 2000;
      while (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        if (!wait || gl.isContextLost() || performance.now() >= limit ||
          gl.getParameter(this.timer.GPU_DISJOINT_EXT)) return null;
        await yieldToBrowser();
      }
      if (gl.getParameter(this.timer.GPU_DISJOINT_EXT)) return null;
      return (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6;
    } finally {
      gl.deleteQuery(query);
    }
  }

  // 实时路径每次只允许一帧在途。等待 GPU 完成，无须把像素读回 CPU。
  async waitForFrame(isCurrent: () => boolean) {
    const gl = this.gl;
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!fence) throw new Error('无法创建 WebGL2 完成信号');
    gl.flush();
    try {
      const limit = performance.now() + 2000;
      while (isCurrent()) {
        await yieldToBrowser();
        if (!isCurrent()) break;
        const status = gl.clientWaitSync(fence, 0, 0);
        if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) return;
        if (status === gl.WAIT_FAILED || performance.now() >= limit) throw new Error('等待 WebGL2 完成失败');
      }
    } finally {
      gl.deleteSync(fence);
    }
  }

  assertHealthy() {
    if (this.disposed) throw new Error('WebGL2 处理器已释放');
    if (this.gl.isContextLost()) throw new Error('WebGL2 上下文已丢失');
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) throw new Error(`WebGL2 执行失败（0x${error.toString(16)}）`);
  }

  dispose() {
    this.disposed = true;
    const gl = this.gl;
    if (this.packBuffer) gl.deleteBuffer(this.packBuffer);
    for (const program of this.programs) gl.deleteProgram(program);
    for (const framebuffer of this.framebuffers) gl.deleteFramebuffer(framebuffer);
    for (const texture of this.textures) gl.deleteTexture(texture);
  }
}
