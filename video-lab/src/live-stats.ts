// 实时管线的辅助工具：画面裁剪、掉帧估算、分段耗时统计。主线程管线和 Worker 管线共用。
import { statistics } from './kernels.ts';

// 以目标宽高比在源画面中心裁剪（cover），返回源坐标系中的整数矩形。
// 例：1920×1080 的视频放进 640×640，会裁掉左右两侧，取中间 1080×1080 再缩小，画面不变形、不留黑边。
export function coverRect(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  if (!(sourceWidth > 0 && sourceHeight > 0 && width > 0 && height > 0)) throw new RangeError('尺寸无效');
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = Math.min(sourceWidth, Math.round(width / scale));
  const cropHeight = Math.min(sourceHeight, Math.round(height / scale));
  return {
    x: Math.floor((sourceWidth - cropWidth) / 2),
    y: Math.floor((sourceHeight - cropHeight) / 2),
    width: cropWidth,
    height: cropHeight,
  };
}

// 根据相邻两帧的时间戳估算中间丢掉的帧数；间隔不足 1.5 帧视为抖动，不计掉帧。
// 时间戳单位是微秒；interval 为一帧应有的间隔，例如 30 FPS 时约 33333。
export function droppedBetween(previous: number | undefined, current: number, interval: number) {
  if (previous === undefined || !(interval > 0) || !(current > previous)) return 0;
  return Math.max(0, Math.round((current - previous) / interval) - 1);
}

// 一帧的四个耗时分段：copyIn 取像素进缓冲区，process 跑效果，output 画到 Canvas，total 三者合计。
const SEGMENTS = ['copyIn', 'process', 'output', 'total'] as const;
/** 实时计时分段，取帧、处理、输出和整帧四项均以毫秒计。 */
type Segment = typeof SEGMENTS[number];
/** 实时统计窗口内某一分段的平均值和 P95，单位为毫秒。 */
type SegmentStats = { mean: number; p95: number };
/** 单帧在各分段的耗时，供实时计量器累积。 */
type FrameTiming = Record<Segment, number>;

/** 实时计量器对一个统计窗口的汇总，包含分段耗时、处理帧数、掉帧率和帧率。 */
export type LiveSummary = Record<Segment, SegmentStats> & {
  frames: number;
  dropped: number;
  dropRate: number;
  fps: number | null;
};

// 实时管线计量：按取帧 / 处理 / 输出分段记录，每个窗口（约 0.5 秒）汇总一次。
// 用法：每处理完一帧 add()，发现掉帧 drop(n)，到点 summary() 取结果后 next() 开始新窗口。
// now 可注入，方便测试里用假时钟。
export class LiveMeter {
  private readonly now: () => number;
  private anchor?: number;
  private firstFrame?: number;
  private lastFrame?: number;
  private samples!: Record<Segment, number[]>;
  private frames!: number;
  private dropped!: number;

  constructor(now = () => performance.now()) {
    this.now = now;
    this.reset();
  }

  // 每个统计窗口结束时调用 next()：清空样本但保留上一窗口末帧时刻，帧率跨窗口连续计算。
  next() {
    const anchor = this.lastFrame;
    this.reset();
    this.anchor = anchor;
  }

  reset() {
    this.anchor = undefined;
    this.samples = { copyIn: [], process: [], output: [], total: [] };
    this.frames = 0;
    this.dropped = 0;
    this.firstFrame = undefined;
    this.lastFrame = undefined;
  }

  add(sample: FrameTiming) {
    for (const key of SEGMENTS) {
      if (!Number.isFinite(sample[key]) || sample[key] < 0) throw new RangeError(`分段耗时无效：${key}`);
      this.samples[key].push(sample[key]);
    }
    const time = this.now();
    this.firstFrame ??= time;
    this.lastFrame = time;
    this.frames++;
  }

  drop(count: number) {
    if (Number.isInteger(count) && count > 0) this.dropped += count;
  }

  // 帧率按帧完成时刻计算，避免把启动等待算进去。
  // 首个窗口没有锚点：N 帧只构成 N-1 个间隔；之后的窗口以上一窗口末帧为起点，N 帧对应 N 个间隔。
  summary(): LiveSummary | null {
    if (this.firstFrame === undefined || this.lastFrame === undefined) return null;
    const frames = this.anchor === undefined ? this.frames - 1 : this.frames;
    const span = this.lastFrame - (this.anchor ?? this.firstFrame);
    const segments = {} as Record<Segment, SegmentStats>;
    const result = {
      frames: this.frames,
      dropped: this.dropped,
      dropRate: this.dropped / (this.frames + this.dropped),
      fps: frames > 0 && span > 0 ? frames * 1000 / span : null,
    };
    for (const key of SEGMENTS) {
      const values = this.samples[key];
      segments[key] = { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        p95: statistics(values).p95 };
    }
    return { ...result, ...segments };
  }
}
