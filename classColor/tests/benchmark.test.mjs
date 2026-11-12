import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSProcessor, WasmProcessor, comparePixels, statistics, validateConfig } from '../wasm-video/kernels.js';

async function processor(kind, width, height) {
  const binary = await readFile(new URL(`../wasm-video/operations/benchmark-${kind}.wasm`, import.meta.url));
  const { instance } = await WebAssembly.instantiate(binary);
  assert.equal(instance.exports.get_simd(), kind === 'simd' ? 1 : 0);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(binary)), []);
  return new WasmProcessor(instance, width, height);
}

// 独立参考实现：按坐标和邻域求和，避免只比较两份可能共享同一错误的优化实现。
function reference(input, width, height, passes) {
  let source = input;
  for (let pass = 0; pass < passes; pass++) {
    const output = source.slice();
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) sum += source[((y + dy) * width + x + dx) * 4 + c];
          }
          output[(y * width + x) * 4 + c] = Math.floor(sum / 9);
        }
      }
    }
    source = output;
  }
  return source;
}

for (const [width, height] of [[1, 1], [1, 9], [2, 8], [3, 3], [5, 7], [9, 11], [17, 13], [64, 37]]) {
  test(`pixel equality, alpha, border, tails and repeatability: ${width}x${height}`, async () => {
    const input = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 131 + (i >> 2) * 17) % 256);
    const saved = input.slice();
    const js = new JSProcessor(width, height);
    const engines = await Promise.all(['scalar', 'simd'].map(kind => processor(kind, width, height)));
    for (const passes of [1, 2, 5, 12]) {
      const expected = reference(input, width, height, passes);
      assert.deepEqual(js.run(input, passes), expected);
      for (const engine of engines) {
        engine.prepare(input);
        assert.deepEqual(engine.run(passes), expected);
        assert.deepEqual(engine.run(passes), expected, 'each run starts from immutable input');
      }
    }
    assert.deepEqual(input, saved);
  });
}

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
