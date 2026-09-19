import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// StrictMode는 쓰지 않는다: 개발 중 이펙트가 두 번 실행되면서
// WebSocket이 두 번 연결되어 디버깅이 혼란스러워지기 때문.
createRoot(document.getElementById('root')).render(<App />);
