const js = import("./tcping/hello-wasm/pkg/Speedtest_wasm.js");
js.then(js => {
  js.greet("WebAssembly1111");
  js.tcp_ping();
});

function getPingData(data){
  console.log(data);
}

window.getPingData = getPingData;

