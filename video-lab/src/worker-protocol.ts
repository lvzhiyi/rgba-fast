import type { EffectId, NamedEffect } from './effects.ts';
import type { comparePixels, ImplementationId, statistics, WasmId, WasmLoadErrors } from './kernels.ts';
import type { LiveSummary } from './live-stats.ts';

/** 单帧处理参数。宽高为像素数，passes 为同一效果连续执行的轮数。 */
export type FrameConfig = { width: number; height: number; passes: number; effect: EffectId };
/** 固定帧基准参数。samples 是采样批数，每批重复次数由 Worker 决定。 */
export type BenchmarkConfig = FrameConfig & { samples: number };
/** 发给基准 Worker 的任务。buffer 是固定帧 RGBA 像素副本，发送时转移所有权。 */
export type BenchmarkRequest = BenchmarkConfig & { buffer: ArrayBuffer };
/** 基准的计时分段，分别为滤镜计算、输入复制、输出复制和整批耗时。 */
export type TimingSegment = 'compute' | 'upload' | 'download' | 'total';
/** 各分段每批的单次平均耗时，单位为毫秒。 */
export type BenchmarkSamples = Record<TimingSegment, number[]>;
/** 单个实现的基准结果，包含分段统计、逐字节校验和原始采样。 */
export type BenchmarkRow = Record<TimingSegment, ReturnType<typeof statistics>> & {
  id: ImplementationId;
  check: ReturnType<typeof comparePixels>;
  rawSamples: BenchmarkSamples;
};
/** 基准 Worker 的完成消息。output 是转移回主线程供画布预览的 RGBA 像素。 */
export type BenchmarkResult = {
  type: 'result';
  rows: BenchmarkRow[];
  loadErrors: WasmLoadErrors;
  warmup: number;
  batchSize: number;
  config: BenchmarkConfig;
  output: ArrayBuffer;
};
/** 基准 Worker 发给主线程的消息，按 type 区分进度、错误和完整结果。 */
export type BenchmarkMessage =
  | { type: 'progress'; phase: '预热' | '采样'; done: number; total: number }
  | { type: 'error'; message: string }
  | BenchmarkResult;
/** 用于历史和 JSON 导出的结果，附带输入来源、环境和构建信息，省略预览像素。 */
export type BenchmarkRecord = Omit<BenchmarkResult, 'output'> & {
  timestamp: string;
  userAgent: string;
  /** 同一页面内每次重绘固定帧都会递增，用于追溯基准输入。 */
  frameRevision: number;
  source: string;
  algorithm: NamedEffect & { id: EffectId; formula: string };
  build: string[];
  timing: string;
};

/** 实时预览的滤镜实现。none 直接显示原始画面。 */
export type LiveMode = 'none' | ImplementationId;
/** 实时预览的输入源。file 是项目自带的示例视频，camera 是摄像头。 */
export type LiveSource = 'file' | 'camera';
/** 实时滤镜执行的位置，分别对应主线程 Canvas 和 Worker VideoFrame。 */
export type PipelineKind = 'main' | 'worker';
/** 启动实时预览所需的帧参数、输入源、管线和滤镜实现。 */
export type LiveConfig = FrameConfig & { source: LiveSource; pipeline: PipelineKind; mode: LiveMode };
/** 实时统计及实际取像素路径。回退到 Canvas 时可携带原因。 */
export type LiveStats = LiveSummary & { path: string; fallbackReason?: string };
/** 启动实时 Worker 的参数。帧流与轨道择一转移，逐帧模式由后续 frame 消息供帧。 */
export type PipelineStart = FrameConfig & {
  type: 'start';
  mode: LiveMode;
  /** 输入轨道报告的帧率（FPS），用于估算实时掉帧。 */
  frameRate?: number;
  /** 主线程创建处理器时，Worker 直接读取转移过来的帧流。 */
  readable?: ReadableStream<VideoFrame>;
  /** Worker 创建处理器时，由主线程转移轨道副本，Worker 停止时释放。 */
  track?: MediaStreamTrack;
};
/** 主线程发给实时 Worker 的命令，涵盖初始化、启停、逐帧传输和配置更新。 */
export type PipelineRequest =
  | { type: 'init'; canvas: OffscreenCanvas }
  | PipelineStart
  | { type: 'frame'; frame: VideoFrame; session: number; missed: number }
  | { type: 'mode'; mode: LiveMode }
  | { type: 'effect'; effect: EffectId }
  | { type: 'stop' };
/** 实时 Worker 启动成功后的确认，返回会话编号和已加载的 Wasm 实现。 */
export type PipelineStarted = { type: 'started'; session: number; available: WasmId[] };
/** 实时 Worker 的回执和事件，涵盖能力探测、启动确认、可接收下一帧、统计和错误。 */
export type PipelineMessage =
  | { type: 'caps'; mstp: boolean }
  | PipelineStarted
  | { type: 'ready'; session: number }
  | ({ type: 'stats'; session: number; format: VideoPixelFormat | null; size: string } & LiveStats)
  | { type: 'error'; session?: number; message: string };
