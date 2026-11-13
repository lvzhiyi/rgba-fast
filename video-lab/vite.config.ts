import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发与预览共用跨源隔离响应头，保持本地两种运行方式的浏览器环境一致。
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  plugins: [react()],
  // 将 Wasm 保留为独立资源，由各管线按需加载。
  build: { assetsInlineLimit: 0 },
  server: { host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT) || 5500, headers },
  preview: { headers },
});
