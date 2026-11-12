const http = require('http');
// 旧静态服务草稿：9898 端口、以 classColor 为根，与页面写死的 5500 /wasm/... 路径不匹配。
// 上级 package.json 设置 type=module，此处 require/__dirname 不能直接按 ES 模块运行。
// MIME 表未配置 JS 模块和视频类型；当前示例沿用 stady 根目录的静态服务启动方式。
const url = require('url');
const fs = require('fs');
const path = require('path');
const PORT = 9898; // 服务器监听的端口号；

const mime = {
  html: 'text/html;charset=UTF-8',
  wasm: 'application/wasm', // 当遇到对 ".wasm" 格式文件的请求时，返回特定的 MIME
};
http
  .createServer((req, res) => {
    let realPath = path.join(__dirname, `.${url.parse(req.url).pathname}`);
    // 检查所访问文件是否存在，且是否可读；
    fs.access(realPath, fs.constants.R_OK, (err) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end();
      } else {
        fs.readFile(realPath, 'binary', (err, file) => {
          if (err) {
            // 文件读取失败时返回 500；
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end();
          } else {
            // 根据请求的文件返回相应的文件内容；
            let ext = path.extname(realPath);
            ext = ext ? ext.slice(1) : 'unknown';
            let contentType = mime[ext] || 'text/plain';
            res.writeHead(200, { 'Content-Type': contentType });
            res.write(file, 'binary');
            res.end();
          }
        });
      }
    });
  })
  .listen(PORT);
console.log('Server is runing at port: ' + PORT + '.');
