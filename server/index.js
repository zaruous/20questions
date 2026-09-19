// WebSocket 서버 (I/O 계층).
// 게임 규칙은 game.js에만 있고, 여기서는 연결/방 목록/브로드캐스트/시간만 다룬다.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as game from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 0/O/1/I 제외
const EMPTY_ROOM_TTL = 10 * 60 * 1000; // 아무도 없는 방을 정리하기까지

/** @type {Map<string, object>} */
const rooms = new Map();
/** @type {Map<import('ws').WebSocket, {roomCode: string, playerId: string}>} */
const sessions = new Map();

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function newRoomCode() {
  for (let i = 0; i < 50; i += 1) {
    const code = Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    if (!rooms.has(code)) return code;
  }
  throw new Error('방 코드를 만들지 못했습니다.');
}

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
};
// fatal: 입장 자체가 실패한 경우. 클라이언트는 재접속을 멈추고 첫 화면으로 돌아간다.
const fail = (ws, message, fatal = false) => send(ws, { type: 'error', message, fatal });

/** 방 전체에 각자의 시점으로 상태 전송 */
function broadcast(room) {
  for (const [ws, session] of sessions) {
    if (session.roomCode === room.code) {
      send(ws, { type: 'state', state: game.viewFor(room, session.playerId), serverNow: Date.now() });
    }
  }
}

function handle(ws, session, msg) {
  const room = rooms.get(session.roomCode);
  if (!room) return fail(ws, '방이 사라졌습니다.', true);
  const now = Date.now();
  const me = session.playerId;

  let result;
  switch (msg.type) {
    case 'start':
      result = game.startGame(room, me, now);
      break;
    case 'secret':
      result = game.setSecret(room, me, msg.text, now);
      break;
    case 'ask':
      result = game.askQuestion(room, me, msg.text, now);
      break;
    case 'answer':
      result = game.answerQuestion(room, me, msg.verdict, now);
      break;
    case 'guess':
      result = game.submitGuess(room, me, msg.text, now);
      break;
    case 'next':
      result = game.nextRound(room, me, now);
      break;
    case 'restart':
      result = game.restart(room, me);
      break;
    default:
      return fail(ws, `알 수 없는 요청입니다: ${msg.type}`);
  }

  if (!result.ok) return fail(ws, result.error);
  broadcast(room);
}

function handleEntry(ws, msg) {
  const name = String(msg.name ?? '').trim();
  const reject = (message) => fail(ws, message, true);

  if (msg.type === 'create') {
    const room = game.createRoom(newRoomCode());
    const playerId = randomId();
    const joined = game.joinRoom(room, { id: playerId, name });
    if (!joined.ok) return reject(joined.error);
    rooms.set(room.code, room);
    sessions.set(ws, { roomCode: room.code, playerId });
    send(ws, { type: 'joined', playerId, code: room.code });
    broadcast(room);
    return;
  }

  // join: 신규 참가 또는 토큰(playerId)을 가진 재접속
  const code = String(msg.code ?? '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return reject('그런 방 코드가 없습니다.');

  if (msg.token && game.findPlayer(room, msg.token)) {
    // 같은 좌석으로 돌아온 경우: 기존 연결이 남아 있으면 정리한다.
    for (const [otherWs, other] of sessions) {
      if (other.playerId === msg.token && otherWs !== ws) {
        sessions.delete(otherWs);
        otherWs.close();
      }
    }
    const back = game.reconnect(room, msg.token);
    if (!back.ok) return reject(back.error);
    sessions.set(ws, { roomCode: code, playerId: msg.token });
    send(ws, { type: 'joined', playerId: msg.token, code });
    broadcast(room);
    return;
  }

  const playerId = randomId();
  const joined = game.joinRoom(room, { id: playerId, name });
  if (!joined.ok) return reject(joined.error);
  sessions.set(ws, { roomCode: code, playerId });
  send(ws, { type: 'joined', playerId, code });
  broadcast(room);
}

export function createServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'dist')));
  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail(ws, '잘못된 요청 형식입니다.');
      }
      if (!msg || typeof msg.type !== 'string') return fail(ws, '잘못된 요청입니다.');

      const session = sessions.get(ws);
      if (!session) {
        if (msg.type === 'create' || msg.type === 'join') return handleEntry(ws, msg);
        return fail(ws, '먼저 방에 입장하세요.', true);
      }
      handle(ws, session, msg);
    });

    ws.on('close', () => {
      const session = sessions.get(ws);
      sessions.delete(ws);
      if (!session) return;
      const room = rooms.get(session.roomCode);
      if (!room) return;
      game.disconnect(room, session.playerId, Date.now());
      broadcast(room);
    });
  });

  // 제한 시간 처리 + 빈 방 정리
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (game.tick(room, now)) broadcast(room);
      const occupied = room.players.some((p) => p.connected);
      if (occupied) room.lastSeenAt = now;
      else if (now - (room.lastSeenAt ?? room.createdAt) > EMPTY_ROOM_TTL) rooms.delete(room.code);
    }
  }, 1000);
  timer.unref?.();

  server.on('close', () => {
    clearInterval(timer);
    wss.close();
  });
  return server;
}

// 테스트에서 import할 때는 자동으로 뜨지 않게 한다.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`20고개 서버 실행 중 → http://localhost:${PORT} (ws: /ws)`);
  });
}
