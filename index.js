import { readFile } from 'fs/promises';
import { WASI } from 'wasi';
import { argv, env } from 'process';
const wasi = new WASI({
  args: argv,
  env,
  preopens: {
    '/sandbox': '/sandbox'
  }
});
const importMemory = new WebAssembly.Memory({
  initial:10, // 初始页位置 每页 64kib
  maximum:100,
  shared:false
})
// Some WASI binaries require:
//   const importObject = { wasi_unstable: wasi.wasiImport };
const importObject = { wasi_snapshot_preview1: wasi.wasiImport, importMemory };



const wasm = await WebAssembly.compile(
  await readFile(new URL('./test2.wasm', import.meta.url))
);
const instance = await WebAssembly.instantiate(wasm, importObject);

wasi.start(instance);