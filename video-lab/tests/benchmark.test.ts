import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSProcessor, WasmProcessor, WASM_BUILDS, comparePixels, statistics, validateConfig } from '../src/kernels.ts';
import { EFFECTS, encodeEffect, validateEffect } from '../src/effects.ts';
import { reference } from './reference.ts';
import type { Effect, NamedEffect } from '../src/effects.ts';
import type { WasmId } from '../src/kernels.ts';

const KINDS = WASM_BUILDS.map(build => build.id);

async function processor(kind: WasmId, width: number, height: number) {
  const build = WASM_BUILDS.find(item => item.id === kind);
  assert.ok(build);
  const binary = await readFile(new URL(`../wasm/${build.file}`, import.meta.url));
  const { instance } = await WebAssembly.instantiate(binary);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(binary)), []);
  const result = new WasmProcessor(instance, width, height);
  assert.equal(result.exports.get_simd(), build.simd ? 1 : 0, `${kind} SIMD flag`);
  return Object.assign(result, { kind });
}

// 内置效果覆盖了“等权重”和“16 位小权重”两条 SIMD 路径；再补两组自定义参数，
// 分别命中“部分零权重的等权重”和“必须 32 位累加的通用路径”（含负数与偏移）。
const CASES: Record<string, NamedEffect> = {
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
      const engines = await Promise.all(KINDS.map(kind => processor(kind, width, height)));
      for (const engine of engines) engine.setEffect(effect);
      for (const passes of [1, 2, 5]) {
        const expected = reference(input, width, height, passes, effect);
        assert.deepEqual(js.run(input, passes), expected, `js ${width}x${height} ×${passes}`);
        for (const engine of engines) {
          engine.prepare(input);
          assert.deepEqual(engine.run(passes), expected, `${engine.kind} ${width}x${height} ×${passes}`);
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
  const engines = await Promise.all(KINDS.map(kind => processor(kind, width, height)));
  const js = new JSProcessor(width, height);
  for (const effect of Object.values(CASES)) {
    js.setEffect(effect);
    const expected = reference(input, width, height, 3, effect);
    assert.deepEqual(js.run(input, 3), expected, effect.name);
    for (const engine of engines) {
      engine.setEffect(effect);
      engine.prepare(input);
      assert.deepEqual(engine.run(3), expected, `${engine.kind} ${effect.name}`);
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
  assert.throws(() => validateEffect({ kind: 'other', shift: 0 } as unknown as Effect), RangeError);
  for (const kind of KINDS) {
    const engine = await processor(kind, 4, 4);
    // 绕过 JS 校验直接写入非法参数，每个 Wasm 构建都必须拒绝。
    engine.params.set(encodeEffect(blur));
    engine.params[2] = 40000;
    assert.equal(engine.exports.process(4, 4, 1), 0, kind);
    engine.params[2] = 7282;
    engine.params[0] = 7;
    assert.equal(engine.exports.process(4, 4, 1), 0, kind);
    engine.params[0] = 0;
    engine.params[1] = 31;
    assert.equal(engine.exports.process(4, 4, 1), 0, kind);
    engine.setEffect(blur);
    assert.notEqual(engine.exports.process(4, 4, 1), 0, kind);
  }
});

test('SIMD integer division is exact for every possible nine-byte sum', () => {
  for (let sum = 0; sum <= 9 * 255; sum++) assert.equal((sum * 7282) >>> 16, Math.floor(sum / 9));
});

test('1080p capacity, maximum pass count and rejected dimensions', async () => {
  const input = new Uint8Array(1920 * 1080 * 4).fill(255);
  for (const kind of KINDS) {
    const engine = await processor(kind, 1920, 1080);
    engine.prepare(input);
    assert.deepEqual(engine.run(1), input, kind);
    assert.equal(engine.exports.process(1921, 1080, 1), 0);
    assert.equal(engine.exports.process(1920, 1081, 1), 0);
    assert.equal(engine.exports.process(0, 1, 1), 0);
    assert.equal(engine.exports.process(1, 1, 33), 0);
    assert.throws(() => engine.prepare(new Uint8Array(3)), RangeError);
    const small = await processor(kind, 5, 5);
    small.prepare(new Uint8Array(100).fill(255));
    assert.deepEqual(small.run(32), new Uint8Array(100).fill(255), kind);
  }
  assert.throws(() => validateConfig(1, 1, 0), RangeError);
  assert.throws(() => new JSProcessor(1921, 1080), RangeError);
});

test('comparison detects errors and statistics use median and nearest-rank P95', () => {
  assert.deepEqual(comparePixels(new Uint8Array([0, 255, 4]), new Uint8Array([1, 250, 4])),
    { mismatches: 2, maxError: 5, bytes: 3 });
  assert.equal(statistics([4, 1, 2, 3]).median, 2.5);
  assert.equal(statistics(Array.from({ length: 20 }, (_, i) => i + 1)).p95, 19);
  assert.throws(() => statistics([]), RangeError);
});
