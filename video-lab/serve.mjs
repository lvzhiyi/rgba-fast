import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 零依赖静态服务：以 video-lab 为根目录，正确返回 .wasm / ES 模块 / 视频的 MIME，
// 支持 Range（视频拖动与循环），并开启跨源隔离（COOP/COEP），为后续 SharedArrayBuffer 做准备。
const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 5500;
const host = process.env.HOST || '127.0.0.1';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
};

function resolvePath(url) {
  const pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  const file = normalize(join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname));
  // 防止 ../ 越出根目录。
  return file === root || file.startsWith(root + sep) ? file : null;
}

createServer(async (req, res) => {
  const file = resolvePath(req.url);
  let info;
  try {
    info = file && await stat(file);
  } catch {
    info = null;
  }
  if (!info?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...isolation });
    res.end('Not Found');
    return;
  }
  const headers = {
    'Content-Type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ...isolation,
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, ...isolation });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${info.size}` });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}).listen(port, host, () => {
  console.log(`video-lab: http://${host}:${port}/`);
});
