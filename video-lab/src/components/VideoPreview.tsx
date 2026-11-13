import { useRef } from 'react';
import { Camera, ImageUp, Pause, Video } from 'lucide-react';
import { IMPLEMENTATIONS } from '../kernels.ts';
import sampleVideo from '../../assets/sample.mp4';
import type { RefObject } from 'react';
import type { ChangeOption, LabOptions, LiveView } from '../ui-types.ts';
import type { LiveMode, LiveSource, PipelineKind } from '../worker-protocol.ts';

/** 视频预览所需的配置、媒体元素引用、统计状态和操作回调。 */
type VideoPreviewProps = {
  options: LabOptions;
  live: LiveView;
  media: {
    input: RefObject<HTMLCanvasElement | null>;
    output: RefObject<HTMLCanvasElement | null>;
    worker: RefObject<HTMLCanvasElement | null>;
    video: RefObject<HTMLVideoElement | null>;
  };
  workerCanvasKey: number;
  sourceName: string;
  previewMeta: string;
  busy: boolean;
  onOption: ChangeOption;
  onUpload: (file: File | undefined) => void;
  onToggle: () => void;
  onCapture: () => void;
};

// 渲染主线程和 Worker 共用的统计字段，掉帧显示自上次重置统计以来的累计值。
function LiveStats({ live, source }: { live: LiveView; source: LiveSource }) {
  const { stats, sourcePath, phase } = live;
  const state = phase === 'playing'
    ? (source === 'camera' ? '摄像头实时处理中' : '视频实时处理中')
    : phase === 'starting' ? '正在启动实时处理…' : '实时处理已停止';
  return (
    <div className="live-stats" aria-label="实时管线统计">
      <span>取帧 <b>{stats?.copyIn.mean.toFixed(2) ?? '--'}</b> ms</span>
      <span>处理 <b>{stats?.process.mean.toFixed(2) ?? '--'}</b> ms</span>
      <span>输出 <b>{stats?.output.mean.toFixed(2) ?? '--'}</b> ms</span>
      <span>整帧 <b>{stats?.total.mean.toFixed(2) ?? '--'}</b> ms</span>
      <span>整帧 P95 <b>{stats?.total.p95.toFixed(2) ?? '--'}</b> ms</span>
      <span>处理帧率 <b>{stats?.fps?.toFixed(1) ?? '--'}</b> FPS</span>
      <span>掉帧 <b>{stats ? `${stats.dropped} · ${(stats.dropRate * 100).toFixed(1)}%` : '--'}</b></span>
      <span>取帧路径 <b title={stats?.fallbackReason}>{stats?.path ?? '--'}</b></span>
      <span>帧来源 <b>{sourcePath ?? '--'}</b></span>
      <span className="muted">{state}</span>
    </div>
  );
}

// 展示输入源、管线选择和预览。通过 ref 把媒体元素交给固定帧和实时处理模块。
export function VideoPreview({ options, live, media, workerCanvasKey, sourceName, previewMeta, busy, onOption, onUpload, onToggle, onCapture }: VideoPreviewProps) {
  const upload = useRef<HTMLInputElement>(null);
  const playing = live.phase === 'playing';
  const workerPlaying = playing && live.kind === 'worker';
  return (
    <section className="preview" aria-labelledby="preview-title">
      <div className="section-heading">
        <h2 id="preview-title">图像与视频</h2>
        <div className="preview-actions">
          <button className="file-button" disabled={busy} onClick={() => upload.current?.click()}><ImageUp />选择图片</button>
          <input ref={upload} type="file" accept="image/*" hidden onChange={e => {
            onUpload(e.target.files?.[0]);
            e.target.value = '';
          }} />
          <label>输入源
            <select value={options.source} onChange={e => onOption('source', e.target.value as LiveSource)} disabled={busy}>
              <option value="file">示例视频</option><option value="camera">摄像头</option>
            </select>
          </label>
          <label>管线
            <select value={options.pipeline} onChange={e => onOption('pipeline', e.target.value as PipelineKind)} disabled={busy}>
              <option value="worker">Worker · VideoFrame</option><option value="main">主线程 · Canvas</option>
            </select>
          </label>
          <button disabled={busy || live.phase === 'starting'} onClick={onToggle}>
            {playing ? <><Pause />停止实时</> : <><Video />开始实时</>}
          </button>
          <button disabled={busy || !playing} onClick={onCapture}><Camera />截取当前帧</button>
          <label>实时实现
            <select value={options.mode} onChange={e => onOption('mode', e.target.value as LiveMode)} disabled={busy}>
              <option value="none">原始画面</option>
              {Object.entries(IMPLEMENTATIONS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        </div>
      </div>
      <div className="images">
        <figure>
          <figcaption><span>输入</span><span>{sourceName}</span></figcaption>
          <div className="media-surface">
            <canvas ref={media.input} width={1280} height={720} hidden={playing} />
            <video ref={media.video} src={sampleVideo} preload="metadata" muted loop playsInline hidden={!playing} />
          </div>
        </figure>
        <figure>
          <figcaption><span>处理结果</span><span>{previewMeta}</span></figcaption>
          <div className="media-surface">
            <canvas ref={media.output} width={1280} height={720} hidden={workerPlaying} />
            {/* Canvas 转移给 Worker 后无法再次转移。Worker 故障时换 key 创建新的 DOM 节点。 */}
            <canvas key={workerCanvasKey} ref={media.worker} hidden={!workerPlaying} />
          </div>
        </figure>
      </div>
      <LiveStats live={live} source={options.source} />
      <p className="note">取帧：VideoFrame 写入滤镜输入缓冲区（Wasm 模式下即 Wasm 线性内存）；处理：滤镜计算；输出：写入画布。三段均为管线所在线程的同步耗时，掉帧按帧时间戳或视频帧回调的 presentedFrames 统计。</p>
    </section>
  );
}
