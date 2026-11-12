import colors from 'colors';
import { readFile } from 'fs/promises';
import fibonacci from './index.js';
import { performance }  from 'node:perf_hooks';


async function contrast (jsFn, wasmPath,  name){
  console.log(name.green);
  performance.mark('jsStart')
  const val = jsFn();
  performance.mark('jsEnd')
  performance.measure('jsStart to jsEnd', 'jsStart', 'jsEnd');
  const entry = performance.getEntriesByName('jsStart to jsEnd')[0];
  console.log('js 执行结果：' + val, '耗时：' +`${Math.floor(entry.duration)}`.bgGreen);

  performance.mark('cStart');
  const importMemory = new WebAssembly.Memory({
    initial:10, // 初始页位置 每页 64kib
    maximum:100,
    shared:false
  })
  const file = await readFile(new URL(wasmPath, import.meta.url))
  const wasmModule = new WebAssembly.Module(file);
  const wasmInstance = new WebAssembly.Instance(wasmModule, { importMemory });


  const cVal = wasmInstance.exports.fibonacci(45)
  performance.mark('cEnd')
  performance.measure('cStart to cEnd', 'cStart', 'cEnd');
  const cEntry = performance.getEntriesByName('cStart to cEnd')[0];
  console.log('c 执行结果：' + cVal, '耗时：' + `${Math.floor(cEntry.duration)}`.bgGreen);

  console.log('c 比 js 的执行速度快' + `${Math.floor((entry.duration / cEntry.duration - 1) * 100)}%`);
}

const contrastHandle = () => {
  contrast(() => {
    return fibonacci(45);
  }, './index.wasm', '斐波那契数列');
}

contrastHandle();


