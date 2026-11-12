import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSProcessor, WasmProcessor, comparePixels, statistics, validateConfig } from '../src/kernels.js';
import { EFFECTS, encodeEffect, validateEffect } from '../src/effects.js';

async function processor(kind, width, height) {
  const binary = await readFile(new URL(`../wasm/benchmark-${kind}.wasm`, import.meta.url));
  const { instance } = await WebAssembly.instantiate(binary);
  assert.equal(instance.exports.get_simd(), kind === 'simd' ? 1 : 0);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(binary)), []);
  return new WasmProcessor(instance, width, height);
}

// 独立参考实现：按坐标取邻域、用 Math.floor 做除法，避免只比较两份可能共享同一错误的优化实现。
function reference(input, width, height, passes, effect) {
  const clamp = value => Math.min(255, Math.max(0, value));
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

// 内置效果覆盖了“等权重”和“16 位小权重”两条 SIMD 路径；再补两组自定义参数，
// 分别命中“部分零权重的等权重”和“必须 32 位累加的通用路径”（含负数与偏移）。
const CASES = {
  ...EFFECTS,
  crossUniform: { name: '十字等权', kind: 'convolution', weights: [0, 3, 0, 3, 3, 3, 0, 3, 0], bias: -40, shift: 4 },
  general: { name: '通用 32 位', kind: 'convolution', weights: [300, -1200, 450, -800, 4000, -700, 120, -900, 500], bias: 9000, shift: 10 },
};

const sizes = [[1, 1], [1, 9], [2, 8], [3, 3], [5, 7], [9, 11], [17, 13], [64, 37]];
for (const [id, effect] of Object.entries(CASES)) {
  test(`${id}: pixel equality, alpha, border, tails and repeatability`, async () => {
    for (const [width, height] of sizes) {
      const input = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 131 + (i >> 2) * 17) % 256);
      const saved = input.slice();
      const js = new JSProcessor(width, height);
      js.setEffect(effect);
      const engines = await Promise.all(['scalar', 'simd'].map(kind => processor(kind, width, height)));
      for (const engine of engines) engine.setEffect(effect);
      for (const passes of [1, 2, 5]) {
        const expected = reference(input, width, height, passes, effect);
        assert.deepEqual(js.run(input, passes), expected, `js ${width}x${height} ×${passes}`);
        for (const engine of engines) {
          engine.prepare(input);
          assert.deepEqual(engine.run(passes), expected, `wasm ${width}x${height} ×${passes}`);
          assert.deepEqual(engine.run(passes), expected, 'each run starts from immutable input');
        }
      }
      assert.deepEqual(input, saved);
    }
  });
}

test('extreme inputs saturate identically in every implementation', async () => {
  const width = 23;
  const height = 6;
  // 黑白棋盘让锐化、边缘、浮雕的加权和远超 0..255，检验截断与负数右移。
  const input = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 3 ? 200 : ((i >> 2) + (i >> 2) / width | 0) % 2 ? 255 : 0));
  const engines = await Promise.all(['scalar', 'simd'].map(kind => processor(kind, width, height)));
  const js = new JSProcessor(width, height);
  for (const effect of Object.values(CASES)) {
    js.setEffect(effect);
    const expected = reference(input, width, height, 3, effect);
    assert.deepEqual(js.run(input, 3), expected, effect.name);
    for (const engine of engines) {
      engine.setEffect(effect);
      engine.prepare(input);
      assert.deepEqual(engine.run(3), expected, effect.name);
    }
  }
});

test('effect parameters are validated in JS and rejected by Wasm', async () => {
  const blur = EFFECTS.box;
  assert.throws(() => validateEffect({ ...blur, shift: 31 }), RangeError);
  assert.throws(() => validateEffect({ ...blur, weights: [1, 2, 3] }), RangeError);
  assert.throws(() => validateEffect({ ...blur, weights: Array(9).fill(40000) }), RangeError);
  assert.throws(() => validateEffect({ ...blur, weights: Array(9).fill(0.5) }), RangeError);
  assert.throws(() => validateEffect({ kind: 'color', shift: 8, matrix: Array(12).fill(32767).map((v, i) => i % 4 === 3 ? 2 ** 31 - 100 : v) }), RangeError);
  assert.throws(() => validateEffect({ kind: 'other', shift: 0 }), RangeError);
  const engine = await processor('simd', 4, 4);
  // 绕过 JS 校验直接写入非法参数，Wasm 必须拒绝。
  engine.params.set(encodeEffect(blur));
  engine.params[2] = 40000;
  assert.equal(engine.exports.process(4, 4, 1), 0);
  engine.params[2] = 7282;
  engine.params[0] = 7;
  assert.equal(engine.exports.process(4, 4, 1), 0);
  engine.setEffect(blur);
  assert.notEqual(engine.exports.process(4, 4, 1), 0);
});

test('SIMD integer division is exact for every possible nine-byte sum', () => {
  for (let sum = 0; sum <= 9 * 255; sum++) assert.equal((sum * 7282) >>> 16, Math.floor(sum / 9));
});

test('1080p capacity, maximum pass count and rejected dimensions', async () => {
  const engine = await processor('simd', 1920, 1080);
  const input = new Uint8Array(1920 * 1080 * 4).fill(255);
  engine.prepare(input);
  assert.deepEqual(engine.run(1), input);
  assert.equal(engine.exports.process(1921, 1080, 1), 0);
  assert.equal(engine.exports.process(1920, 1081, 1), 0);
  assert.equal(engine.exports.process(0, 1, 1), 0);
  assert.equal(engine.exports.process(1, 1, 33), 0);
  assert.throws(() => validateConfig(1, 1, 0), RangeError);
  assert.throws(() => new JSProcessor(1921, 1080), RangeError);
  assert.throws(() => engine.prepare(new Uint8Array(3)), RangeError);
  const small = await processor('simd', 5, 5);
  small.prepare(new Uint8Array(100).fill(255));
  assert.deepEqual(small.run(32), new Uint8Array(100).fill(255));
});

test('comparison detects errors and statistics use median and nearest-rank P95', () => {
  assert.deepEqual(comparePixels(new Uint8Array([0, 255, 4]), new Uint8Array([1, 250, 4])),
    { mismatches: 2, maxError: 5, bytes: 3 });
  assert.equal(statistics([4, 1, 2, 3]).median, 2.5);
  assert.equal(statistics(Array.from({ length: 20 }, (_, i) => i + 1)).p95, 19);
  assert.throws(() => statistics([]), RangeError);
});
