import { useCallback, useEffect, useRef, useState } from 'react';

const SESSION_KEY = '20q.session';

// 개발(Vite 프록시)과 배포(Node가 dist까지 서빙) 모두 같은 주소를 쓴다.
const socketUrl = () => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
};

// 새로고침해도 같은 자리로 돌아오기 위한 좌석 토큰
function loadSeat() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { code, token } = JSON.parse(raw);
    return code && token ? { type: 'join', code, token } : null;
  } catch {
    return null;
  }
}

export function useGameSocket() {
  const [state, setState] = useState(null);
  const [status, setStatus] = useState('connecting'); // connecting | online | offline
  const [notice, setNotice] = useState('');
  const socketRef = useRef(null);
  const entryRef = useRef(loadSeat()); // 연결되면 바로 보낼 입장 요청
  const offsetRef = useRef(0); // 서버 시각 - 내 시각 (타이머 오차 보정)
  const retryRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let retryTimer;

    const connect = () => {
      setStatus((prev) => (prev === 'online' ? 'offline' : prev));
      const ws = new WebSocket(socketUrl());
      socketRef.current = ws;

      ws.onopen = () => {
        retryRef.current = 0;
        setStatus('online');
        if (entryRef.current) ws.send(JSON.stringify(entryRef.current));
      };

      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type === 'joined') {
          entryRef.current = { type: 'join', code: msg.code, token: msg.playerId };
          try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: msg.code, token: msg.playerId }));
          } catch {
            /* 사생활 보호 모드 등에서 저장 실패해도 게임은 계속된다 */
          }
        } else if (msg.type === 'state') {
          offsetRef.current = msg.serverNow - Date.now();
          setState(msg.state);
        } else if (msg.type === 'error') {
          setNotice(msg.message);
          if (msg.fatal) {
            // 입장 자체가 실패 → 재입장 시도를 멈추고 첫 화면으로
            entryRef.current = null;
            try {
              sessionStorage.removeItem(SESSION_KEY);
            } catch {
              /* 무시 */
            }
            setState(null);
          }
        }
      };

      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (disposed) return;
        setStatus('offline');
        retryRef.current += 1;
        retryTimer = setTimeout(connect, Math.min(1000 * retryRef.current, 5000));
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const send = useCallback((msg) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else setNotice('서버와 연결이 끊겼습니다. 다시 연결하는 중…');
  }, []);

  const createRoom = useCallback(
    (name) => {
      entryRef.current = { type: 'create', name };
      send(entryRef.current);
    },
    [send],
  );

  const joinRoom = useCallback(
    (code, name) => {
      entryRef.current = { type: 'join', code: String(code).trim().toUpperCase(), name };
      send(entryRef.current);
    },
    [send],
  );

  const leaveRoom = useCallback(() => {
    entryRef.current = null;
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* 무시 */
    }
    setState(null);
    socketRef.current?.close(); // 재연결되지만 입장 요청은 보내지 않는다
  }, []);

  const serverNow = useCallback(() => Date.now() + offsetRef.current, []);

  return { state, status, notice, setNotice, send, createRoom, joinRoom, leaveRoom, serverNow };
}
