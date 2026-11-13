import { Download, Play, Square } from 'lucide-react';
import { EFFECTS, getEffect } from '../effects.ts';
import { IMPLEMENTATIONS } from '../kernels.ts';
import { exportResult } from '../useBenchmark.ts';
import type { useBenchmark } from '../useBenchmark.ts';
import type { EffectId, NamedEffect } from '../effects.ts';
import type { WasmId } from '../kernels.ts';
import type { ChangeOption, LabOptions, Status } from '../ui-types.ts';
import type { BenchmarkRecord, BenchmarkRow } from '../worker-protocol.ts';

/** 基准 Hook 提供给面板的状态和操作。 */
type Benchmark = ReturnType<typeof useBenchmark>;
/** 基准参数面板需要的选项、任务状态、可用状态与操作回调。 */
type BenchmarkControlsProps = {
  options: LabOptions;
  onOption: ChangeOption;
  benchmark: Benchmark;
  busy: boolean;
  hasFrame: boolean;
  status: Status;
  onStart: () => void;
};

const ms = (value: number) => `${value.toFixed(3)} ms`;
const ratio = (value: number | null) => value == null ? '--' : `${value.toFixed(2)}×`;

// 页面摘要与历史记录统一用 JavaScript 中位数除以 C++ SIMD 中位数。
function speedup(result: BenchmarkRecord, metric: 'compute' | 'total') {
  const js = result.rows.find(row => row.id === 'js');
  const simd = result.rows.find(row => row.id === 'simd');
  return simd && js ? js[metric].median / simd[metric].median : null;
}

// 渲染基准参数和开始、停止、导出操作。测试和图片解码期间锁定参数。
export function BenchmarkControls({ options, onOption, benchmark, busy, hasFrame, status, onStart }: BenchmarkControlsProps) {
  return (
    <section className="controls" aria-label="测试参数">
      <label>分辨率
        <select value={options.resolution} onChange={e => onOption('resolution', e.target.value)} disabled={busy}>
          <option value="640x360">640 × 360</option>
          <option value="1280x720">1280 × 720</option>
          <option value="1920x1080">1920 × 1080</option>
        </select>
      </label>
      <label>效果
        <select value={options.effect} onChange={e => onOption('effect', e.target.value as EffectId)} disabled={busy}>
          {Object.entries(EFFECTS).map(([id, effect]) => <option key={id} value={id} title={effect.note}>{effect.name}</option>)}
        </select>
      </label>
      <label>处理轮数
        <select value={options.passes} onChange={e => onOption('passes', Number(e.target.value))} disabled={busy}>
          {[1, 4, 12, 24].map(value => <option key={value} value={value}>{value} 轮</option>)}
        </select>
      </label>
      <label>采样次数
        <select value={options.samples} onChange={e => onOption('samples', Number(e.target.value))} disabled={busy}>
          {[15, 30, 60].map(value => <option key={value} value={value}>{value} 次</option>)}
        </select>
      </label>
      <button className="primary" disabled={busy || !hasFrame} onClick={onStart}><Play />开始测试</button>
      <button hidden={!benchmark.running} onClick={benchmark.cancel}><Square />停止</button>
      <button disabled={!benchmark.result} title="导出当前测试结果 JSON" onClick={() => benchmark.result && exportResult(benchmark.result)}>
        <Download />导出结果
      </button>
      <span id="status" role="status" aria-live="polite" className={status.error ? 'error' : undefined}>{status.text}</span>
    </section>
  );
}

// 展示计算与含复制的两种加速比，以及逐字节校验状态。
function Summary({ result, failed }: { result: BenchmarkRecord | null; failed: boolean }) {
  const js = result?.rows.find(row => row.id === 'js');
  const simd = result?.rows.find(row => row.id === 'simd');
  return (
    <section className="summary" aria-label="性能摘要">
      {([
        ['计算加速比', 'compute', 'SIMD 模块未加载'],
        ['含复制加速比', 'total', '标量结果见下表'],
      ] as const).map(([label, metric, unavailable]) => (
        <div key={metric}>
          <span className="eyebrow">{label} · JS / C++ SIMD</span>
          <strong>{result ? (simd ? ratio(speedup(result, metric)) : '不可用') : '--'}</strong>
          <span className="muted">{simd && js ? `${ms(js[metric].median)} → ${ms(simd[metric].median)}` : result ? unavailable : '等待采样'}</span>
        </div>
      ))}
      <div>
        <span className="eyebrow">RGBA 结果校验</span>
        <strong className="validation">{result ? '完全一致' : failed ? '未通过' : '待校验'}</strong>
        <span className="muted">{js ? `${(js.check.bytes / 4).toLocaleString()} 像素 · 最大通道误差 0` : '逐字节比较'}</span>
      </div>
    </section>
  );
}

// 测试前按实现清单显示占位行，完成后按 Worker 返回的数据展示耗时和加载错误。
function ResultRows({ result }: { result: BenchmarkRecord | null }) {
  if (!result) {
    return Object.entries(IMPLEMENTATIONS).map(([id, name]) => (
      <tr key={id}><td><span className={`dot ${id}`} />{name}</td><td colSpan={6} className="empty">等待测试</td></tr>
    ));
  }
  return (
    <>
      {result.rows.map(row => (
        <tr key={row.id}>
          <td><span className={`dot ${row.id}`} />{IMPLEMENTATIONS[row.id]}</td>
          <td>{ms(row.compute.median)}</td><td>{row.id === 'js' ? '—' : ms(row.upload.median)}</td>
          <td>{ms(row.download.median)}</td><td><b>{ms(row.total.median)}</b></td>
          <td>{ms(row.total.p95)}</td><td className="pass">完全一致</td>
        </tr>
      ))}
      {Object.entries(result.loadErrors).map(([id, message]) => (
        <tr key={id}><td colSpan={7}>{IMPLEMENTATIONS[id as WasmId]} 不可用：{message}</td></tr>
      ))}
    </>
  );
}

// 以最慢实现的总耗时中位数作为满宽，其余实现按比例显示。
function Bars({ rows }: { rows: BenchmarkRow[] }) {
  const max = Math.max(...rows.map(row => row.total.median));
  return (
    <div className="bars" aria-label="总耗时对比">
      {rows.map(row => (
        <div className="bar-row" key={row.id}>
          <span>{IMPLEMENTATIONS[row.id]}</span>
          <div className="bar-track"><div className={`bar-fill ${row.id}`} style={{ width: `${max ? row.total.median / max * 100 : 0}%` }} /></div>
          <span className="bar-value">{ms(row.total.median)}</span>
        </div>
      ))}
    </div>
  );
}

// 等待时说明当前效果，完成后展示本次实际采样配置。
function resultMeta(result: BenchmarkRecord | null, effect: NamedEffect) {
  if (!result) return `${effect.name} · ${effect.kind === 'convolution' ? '3×3 卷积 · 保留边界与 Alpha' : '颜色矩阵 · 保留 Alpha'}`;
  const { width, height, passes, samples } = result.config;
  return `${effect.name} · ${width} × ${height} · ${passes} 轮 · ${samples} 批 × ${result.batchSize} 次 · 预热 ${result.warmup} 次`;
}

// 展示同类 Wasm 构建的 AS / C++ 耗时比，并说明中位数和 P95 的统计口径。
function resultNote(result: BenchmarkRecord | null) {
  if (!result) return '计时不包含模块加载与编译、视频解码和 Canvas 绘制。';
  // 标量和 SIMD 分开比较，任一模块缺失时保留占位。
  const pair = (as: WasmId, cpp: WasmId) => {
    const a = result.rows.find(row => row.id === as);
    const c = result.rows.find(row => row.id === cpp);
    return a && c ? ratio(a.compute.median / c.compute.median) : '--';
  };
  return `AssemblyScript ÷ C++ 计算耗时：标量 ${pair('as-scalar', 'scalar')}，SIMD ${pair('as-simd', 'simd')}（大于 1 表示 AS 更慢）。`
    + '耗时为每批的单次均值，P95 为批均值 P95。总耗时含输入复制、计算和输出复制；分项中位数之和不一定等于总中位数。加速比小于 1 表示 Wasm 更慢。';
}

// 组合基准摘要、进度、实现对照表和耗时图，统一消费同一次测试结果。
export function BenchmarkResults({ benchmark, effectId }: { benchmark: Benchmark; effectId: EffectId }) {
  const { result, failed, progress } = benchmark;
  return (
    <>
      <Summary result={result} failed={failed} />
      <section className="results" aria-labelledby="results-title">
        <div className="section-heading">
          <h2 id="results-title">固定帧基准</h2>
          <span className="muted">{resultMeta(result, getEffect(effectId))}</span>
        </div>
        <div className="progress-track"><div id="progress" style={{ width: `${progress}%` }} /></div>
        <div className="table-scroll"><table>
          <thead><tr><th>实现</th><th>计算中位数</th><th>输入复制</th><th>输出复制</th><th>总耗时中位数</th><th>批均值 P95</th><th>校验</th></tr></thead>
          <tbody><ResultRows result={result} /></tbody>
        </table></div>
        {result && <Bars rows={result.rows} />}
        <div className="method"><span>O3 编译</span><span>独立 Worker</span><span>预热 12 次</span><span>轮换采样顺序</span><span>复用像素缓冲区</span><span>计算与复制分别计时</span></div>
        <p className="note">{resultNote(result)}</p>
      </section>
    </>
  );
}

// 显示本次页面会话最近八条记录，每行都能下载当次的原始数据。
export function BenchmarkHistory({ history }: { history: BenchmarkRecord[] }) {
  return (
    <section className="history-section">
      <div className="section-heading"><h2>测试记录</h2><span className="muted">本次打开页面的最近 8 次</span></div>
      <div className="table-scroll"><table>
        <thead><tr><th>时间</th><th>效果</th><th>输入尺寸</th><th>轮数</th><th>计算加速比</th><th>含复制加速比</th><th>校验</th><th>原始数据</th></tr></thead>
        <tbody>
          {!history.length && <tr><td colSpan={8} className="empty">暂无记录</td></tr>}
          {history.map(result => {
            const time = new Date(result.timestamp).toLocaleTimeString();
            const { width, height, passes } = result.config;
            return (
              <tr key={result.timestamp}>
                <td>{time}</td><td>{result.algorithm.name}</td><td>{width} × {height}</td><td>{passes}</td>
                <td>{ratio(speedup(result, 'compute'))}</td><td>{ratio(speedup(result, 'total'))}</td><td className="pass">通过</td>
                <td>
                  <button className="icon-button" onClick={() => exportResult(result)} title="导出这次测试的原始数据" aria-label={`导出 ${time} 的原始数据`}>
                    <Download />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </section>
  );
}
