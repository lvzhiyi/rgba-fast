import { EFFECTS } from '../src/effects.ts';
import { comparePixels } from '../src/kernels.ts';
import { WebGPUProcessor } from '../src/webgpu.ts';
import { WebGLProcessor } from '../src/webgl.ts';
import { reference } from './reference.ts';

const status = document.querySelector<HTMLElement>('[role="status"]')!;

async function verify(backend: 'webgl2' | 'webgpu') {
  let checks = 0;
  for (const [width, height] of [[1, 1], [2, 7], [9, 11], [17, 13]]) {
    const input = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 131 + (i >> 2) * 17) % 256);
    const output = new Uint8Array(input.length);
    const gpu = backend === 'webgl2' ? new WebGLProcessor(new OffscreenCanvas(width, height), width, height)
      : await WebGPUProcessor.create(width, height);
    try {
      for (const [id, effect] of Object.entries(EFFECTS)) {
        gpu.setEffect(effect);
        for (const passes of [1, 2, 4, 32]) {
          gpu.prepare(input);
          gpu.run(passes);
          await gpu.readback(output);
          gpu.assertHealthy();
          const check = comparePixels(reference(input, width, height, passes, effect), output);
          if (check.mismatches) throw new Error(`${id} ${width}×${height} × ${passes}：${JSON.stringify(check)}`);
          checks++;
        }
      }
    } finally {
      gpu.dispose();
    }
  }
  return checks;
}

try {
  const backend = new URLSearchParams(location.search).has('webgpu') ? 'webgpu' : 'webgl2';
  status.textContent = `通过 ${await verify(backend)} 组 ${backend === 'webgpu' ? 'WebGPU' : 'WebGL2'} 像素校验`;
  status.dataset.result = 'pass';
} catch (error) {
  status.textContent = error instanceof Error ? error.message : String(error);
  status.dataset.result = 'fail';
}
