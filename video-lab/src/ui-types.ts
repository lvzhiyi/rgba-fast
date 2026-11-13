import type { BenchmarkConfig, LiveConfig, LiveStats, PipelineKind } from './worker-protocol.ts';

/** 页面控件选项。分辨率保留为“宽x高”字符串，启动处理前再解析。 */
export type LabOptions = Omit<BenchmarkConfig & LiveConfig, 'width' | 'height'> & { resolution: string };
/** 修改单个页面选项的回调，字段名决定该字段允许的值类型。 */
export type ChangeOption = <Key extends keyof LabOptions>(field: Key, value: LabOptions[Key]) => void;
/** 页面状态栏的文案和可选的错误标记。 */
export type Status = { text: string; error?: boolean };
/** 更新状态栏的回调，error 为 true 时采用错误样式。 */
export type SetStatus = (text: string, error?: boolean) => void;
/** 实时预览的界面状态，包含播放阶段、当前管线和最近一次统计。 */
export type LiveView = {
  phase: 'idle' | 'starting' | 'playing';
  kind?: PipelineKind;
  stats?: LiveStats | null;
  sourcePath?: string;
};
