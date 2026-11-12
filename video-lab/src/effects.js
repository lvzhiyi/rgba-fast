// 效果全部用整数参数描述，结果 = clamp((加权和 + bias) >> shift, 0, 255)，
// 这样 JS、标量 Wasm、SIMD Wasm 三条实现可以逐字节一致。
// convolution：3x3 卷积，weights 为九个权重（行优先），保留最外围一圈像素；
// color：颜色矩阵，matrix 为三行 [r, g, b, bias]，逐像素作用于全部像素。Alpha 始终不变。
export const EFFECTS = {
  box: { name: '均值模糊', kind: 'convolution', weights: Array(9).fill(7282), bias: 0, shift: 16,
    note: '九点均值；(sum × 7282) >> 16 与 floor(sum / 9) 完全一致' },
  gaussian: { name: '高斯模糊', kind: 'convolution', weights: [1, 2, 1, 2, 4, 2, 1, 2, 1], bias: 0, shift: 4,
    note: '1-2-1 二项式核，除数 16' },
  sharpen: { name: '锐化', kind: 'convolution', weights: [0, -1, 0, -1, 5, -1, 0, -1, 0], bias: 0, shift: 0,
    note: '中心 5、上下左右 -1，权重和为 1' },
  edge: { name: '边缘检测', kind: 'convolution', weights: [-1, -1, -1, -1, 8, -1, -1, -1, -1], bias: 0, shift: 0,
    note: '拉普拉斯核，平坦区域变黑' },
  emboss: { name: '浮雕', kind: 'convolution', weights: [-2, -1, 0, -1, 1, 1, 0, 1, 2], bias: 128, shift: 0,
    note: '方向差分 + 128 灰度偏移' },
  gray: { name: '灰度', kind: 'color', shift: 8,
    matrix: [77, 150, 29, 0, 77, 150, 29, 0, 77, 150, 29, 0], note: 'BT.601 亮度，权重 / 256' },
  sepia: { name: '怀旧', kind: 'color', shift: 8,
    matrix: [101, 197, 48, 0, 89, 176, 43, 0, 70, 137, 34, 0], note: '经典棕褐色矩阵，权重 / 256' },
  warm: { name: '暖色提亮', kind: 'color', shift: 8,
    matrix: [282, 0, 0, 12 << 8, 0, 269, 0, 6 << 8, 0, 0, 243, 0], note: 'R ×1.1 +12，G ×1.05 +6，B ×0.95' },
  invert: { name: '反色', kind: 'color', shift: 8,
    matrix: [-256, 0, 0, 255 << 8, 0, -256, 0, 255 << 8, 0, 0, -256, 255 << 8], note: '255 - 通道值' },
};

export const DEFAULT_EFFECT = 'box';
export const PARAM_COUNT = 16;
const WEIGHT_LIMIT = 32767;
const SUM_LIMIT = 2147483647;

export function getEffect(id) {
  const effect = EFFECTS[id];
  if (!effect) throw new RangeError(`未知效果：${id}`);
  return effect;
}

// 与 C++ valid_params 相同的约束：权重可放进 16 位有符号数，累加不超出 32 位有符号整数。
export function validateEffect(effect) {
  const integers = values => values.every(Number.isInteger);
  if (!Number.isInteger(effect.shift) || effect.shift < 0 || effect.shift > 30) throw new RangeError('shift 须为 0–30 的整数');
  const rows = effect.kind === 'convolution' ? [[...effect.weights, effect.bias]]
    : effect.kind === 'color' ? [0, 1, 2].map(row => effect.matrix.slice(row * 4, row * 4 + 4)) : null;
  if (!rows) throw new RangeError('效果类型须为 convolution 或 color');
  if (effect.kind === 'convolution' && effect.weights.length !== 9) throw new RangeError('卷积须为九个权重');
  if (effect.kind === 'color' && effect.matrix.length !== 12) throw new RangeError('颜色矩阵须为 3 × 4');
  for (const row of rows) {
    if (!integers(row)) throw new RangeError('效果参数须为整数');
    const weights = row.slice(0, -1);
    if (weights.some(value => Math.abs(value) > WEIGHT_LIMIT)) throw new RangeError('权重超出 16 位范围');
    if (Math.abs(row.at(-1)) + weights.reduce((sum, value) => sum + Math.abs(value) * 255, 0) > SUM_LIMIT) {
      throw new RangeError('效果参数可能导致 32 位溢出');
    }
  }
  return effect;
}

// 按 C++ params 布局编码。
export function encodeEffect(effect) {
  validateEffect(effect);
  const params = new Int32Array(PARAM_COUNT);
  params[0] = effect.kind === 'convolution' ? 0 : 1;
  params[1] = effect.shift;
  if (effect.kind === 'convolution') {
    params.set(effect.weights, 2);
    params[11] = effect.bias;
  } else {
    params.set(effect.matrix, 2);
  }
  return params;
}
