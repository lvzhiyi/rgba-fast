import { statistics } from './kernels.js';

// 以目标宽高比在源画面中心裁剪（cover），返回源坐标系中的整数矩形。
export function coverRect(sourceWidth, sourceHeight, width, height) {
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
export function droppedBetween(previous, current, interval) {
  if (previous === undefined || !(interval > 0) || !(current > previous)) return 0;
  return Math.max(0, Math.round((current - previous) / interval) - 1);
}

const SEGMENTS = ['copyIn', 'process', 'output', 'total'];

// 实时管线计量：按取帧 / 处理 / 输出分段记录，每个窗口汇总一次。
export class LiveMeter {
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
    this.samples = Object.fromEntries(SEGMENTS.map(key => [key, []]));
    this.frames = 0;
    this.dropped = 0;
    this.firstFrame = undefined;
    this.lastFrame = undefined;
  }

  add(sample) {
    for (const key of SEGMENTS) {
      if (!Number.isFinite(sample[key]) || sample[key] < 0) throw new RangeError(`分段耗时无效：${key}`);
      this.samples[key].push(sample[key]);
    }
    const time = this.now();
    this.firstFrame ??= time;
    this.lastFrame = time;
    this.frames++;
  }

  drop(count) {
    if (Number.isInteger(count) && count > 0) this.dropped += count;
  }

  // 帧率按帧完成时刻计算，避免把启动等待算进去。
  summary() {
    if (!this.frames) return null;
    const frames = this.anchor === undefined ? this.frames - 1 : this.frames;
    const span = this.lastFrame - (this.anchor ?? this.firstFrame);
    const result = {
      frames: this.frames,
      dropped: this.dropped,
      dropRate: this.dropped / (this.frames + this.dropped),
      fps: frames > 0 && span > 0 ? frames * 1000 / span : null,
    };
    for (const key of SEGMENTS) {
      const values = this.samples[key];
      result[key] = { mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        p95: statistics(values).p95 };
    }
    return result;
  }
}
