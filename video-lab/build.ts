import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 两种来源各编出标量 / SIMD 两份：
//   C++：Clang 编译、wasm-ld（或 Rust 随附的 rust-lld）链接，无第三方依赖；
//   AssemblyScript：devDependencies 中的 asc 编译器。
// 用 ONLY=cpp 或 ONLY=as 只编其中一种。
const root = dirname(fileURLToPath(import.meta.url));
const clang = process.env.CLANG || 'clang++';
let linker = process.env.WASM_LD;
if (!linker) {
  const rust = join(homedir(), '.rustup/toolchains/stable-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/rust-lld');
  linker = existsSync(rust) ? rust : 'wasm-ld';
}
// 中间产物 .o 放临时目录，结束时删除。
const temporary = mkdtempSync(join(tmpdir(), 'rgba-wasm-'));
// 同步执行外部命令，输出直接打印到终端；失败则抛错中止构建。
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command} 编译失败`);
}
const only = process.env.ONLY;
try {
  for (const simd of only === 'as' ? [] : [false, true]) {
    const name = `benchmark-${simd ? 'simd' : 'scalar'}`;
    const object = join(temporary, `${name}.o`);
    // 先编译成目标文件 .o：--target=wasm32 输出 Wasm 指令；-O3 最高优化；
    // -fno-exceptions / -fno-rtti / -nostdlib 去掉异常、运行时类型信息和标准库，产物里只剩我们自己的代码；
    // -fno-builtin 防止编译器把循环替换成 memcpy 之类的库函数调用（没有标准库，链接会失败）。
    run(clang, ['--target=wasm32', '-std=c++17', '-O3', '-Wall', '-Wextra', '-Werror',
      '-fno-exceptions', '-fno-rtti', '-fno-builtin', '-nostdlib',
      ...(simd ? ['-msimd128'] : []), '-c', join(root, 'native/benchmark.cc'), '-o', object]);
    // 再链接成 .wasm：--no-entry 表示没有 main；--export 列出 JS 能调用的函数；
    // 内存固定 33554432 字节（32 MiB，三块 1920×1080 RGBA 缓冲区约 24 MiB）；--strip-all 去掉调试信息减小体积。
    run(linker, [...(linker.endsWith('rust-lld') ? ['-flavor', 'wasm'] : []),
      '--no-entry', '--export=get_input', '--export=get_params', '--export=get_capacity',
      '--export=get_simd', '--export=process', '--initial-memory=33554432',
      '--max-memory=33554432', '--strip-all', object,
      '-o', join(root, `wasm/${name}.wasm`)]);
    console.log(`Built ${name}.wasm (-O3${simd ? ', SIMD128' : ''})`);
  }
  const asc = join(root, 'node_modules/.bin/asc');
  if (only !== 'cpp' && !existsSync(asc)) throw new Error('缺少 AssemblyScript 编译器，请先运行 npm install');
  for (const simd of only === 'cpp' ? [] : [false, true]) {
    const name = `assemblyscript-${simd ? 'simd' : 'scalar'}`;
    // stub 运行时：不带垃圾回收；内存固定 512 页（32 MiB），与 C++ 版一致。
    run(asc, [join(root, 'assembly/effects.ts'), '-O3', '--noAssert', '--runtime', 'stub',
      '--initialMemory', '512', '--maximumMemory', '512', ...(simd ? ['--enable', 'simd'] : []),
      '-o', join(root, `wasm/${name}.wasm`)]);
    console.log(`Built ${name}.wasm (asc -O3${simd ? ', SIMD128' : ''})`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
