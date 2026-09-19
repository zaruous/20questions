import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 개발 중에는 Vite(5173)가 /ws 요청을 게임 서버(3001)로 프록시한다.
// 덕분에 클라이언트는 개발/배포 모두 같은 주소(location.host + /ws)를 쓴다.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
});
