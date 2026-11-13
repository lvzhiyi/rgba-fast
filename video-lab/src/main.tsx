import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import '../style.css';

// Vite 从 index.html 加载入口，React 挂载页面，样式作为模块一并打包。
createRoot(document.getElementById('root')!).render(<App />);
