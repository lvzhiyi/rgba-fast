import type { Effect } from '../src/effects.ts';

// 独立参考实现：按坐标取邻域、用 Math.floor 做除法，避免只比较两份可能共享同一错误的优化实现。
export function reference(input: Uint8Array, width: number, height: number, passes: number, effect: Effect) {
  const clamp = (value: number) => Math.min(255, Math.max(0, value));
  const scale = 2 ** effect.shift;
  let source = input;
  for (let pass = 0; pass < passes; pass++) {
    const output = source.slice();
    if (effect.kind === 'color') {
      for (let p = 0; p < source.length; p += 4) {
        for (let c = 0; c < 3; c++) {
          const [r, g, b, bias] = effect.matrix.slice(c * 4, c * 4 + 4);
          output[p + c] = clamp(Math.floor((r * source[p] + g * source[p + 1] + b * source[p + 2] + bias) / scale));
        }
      }
    } else {
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          for (let c = 0; c < 3; c++) {
            let sum = effect.bias;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                sum += effect.weights[(dy + 1) * 3 + dx + 1] * source[((y + dy) * width + x + dx) * 4 + c];
              }
            }
            output[(y * width + x) * 4 + c] = clamp(Math.floor(sum / scale));
          }
        }
      }
    }
    source = output;
  }
  return source;
}
