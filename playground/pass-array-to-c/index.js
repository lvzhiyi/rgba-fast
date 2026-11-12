
const memory = new WebAssembly.Memory({ initial: 20 });
wasmImports.memory = memory;
wasmImports.env = {
  getRgb: function(r, g, b){
    log('1111');
    log(r);  log(g);  log(b);
  },
  datas: () => 18,
  mem: memory


};
var wasmModule = new WebAssembly.Module(wasmCode);
var wasmInstance = new WebAssembly.Instance(wasmModule, wasmImports);
const array = new Int32Array(wasmInstance.exports.memory.buffer, 0, 5);
array.set([3, 15, 18, 4, 2]);

const buffer = new Uint8Array(memory.buffer);

const strNum = wasmInstance.exports.averageImgData([3, 15, 18, 4, 2],5,1);
log(strNum);



