import type { WasmId } from './kernels.ts';
import scalar from '../wasm/benchmark-scalar.wasm?url';
import simd from '../wasm/benchmark-simd.wasm?url';
import asScalar from '../wasm/assemblyscript-scalar.wasm?url';
import asSimd from '../wasm/assemblyscript-simd.wasm?url';

// 按 kernels.ts 的实现 ID 提供资源 URL，页面和两个 Worker 共用这张表。
// 显式导入让 Vite 在生产构建中重写带内容哈希的文件路径。
export const wasmUrls = {
  scalar,
  simd,
  'as-scalar': asScalar,
  'as-simd': asSimd,
} satisfies Record<WasmId, string>;
