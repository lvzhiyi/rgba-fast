import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 无第三方依赖：Clang 负责编译，wasm-ld（或 Rust 随附的 rust-lld）负责链接。
const root = dirname(fileURLToPath(import.meta.url));
const clang = process.env.CLANG || 'clang++';
let linker = process.env.WASM_LD;
if (!linker) {
  const rust = join(homedir(), '.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/rust-lld');
  linker = existsSync(rust) ? rust : 'wasm-ld';
}
const temporary = mkdtempSync(join(tmpdir(), 'rgba-wasm-'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} 编译失败`);
}
try {
  for (const simd of [false, true]) {
    const name = `benchmark-${simd ? 'simd' : 'scalar'}`;
    const object = join(temporary, `${name}.o`);
    run(clang, ['--target=wasm32', '-std=c++17', '-O3', '-Wall', '-Wextra', '-Werror',
      '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
      ...(simd ? ['-msimd128'] : []), '-c', join(root, 'native/benchmark.cc'), '-o', object]);
    run(linker, [...(linker.endsWith('rust-lld') ? ['-flavor', 'wasm'] : []),
      '--no-entry', '--export=get_input', '--export=get_params', '--export=get_capacity',
      '--export=get_simd', '--export=process', '--initial-memory=33554432',
      '--max-memory=33554432', '--strip-all', object,
      '-o', join(root, `wasm/${name}.wasm`)]);
    console.log(`Built ${name}.wasm (-O3${simd ? ', SIMD128' : ''})`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
