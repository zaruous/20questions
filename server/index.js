// WebSocket 서버 (I/O 계층).
// 게임 규칙은 game.js, 라이브채팅은 chat.js, 음성 참여자·시그널링 규칙은 rtc.js에 있고,
// 여기서는 연결/방 목록/브로드캐스트/시간만 다룬다.
import http from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as game from './game.js';
import * as chat from './chat.js';
import * as rtc from './rtc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const ROOM_COUNT = Number(process.env.ROOM_COUNT ?? 3); // 서버가 여는 방의 개수(고정)
const EMPTY_ROOM_RESET = 60 * 1000; // 아무도 없는 방을 대기실로 되돌리기까지
export const WS_DATA_MAX = 32 * 1024; // JSON 파싱 전에 막는 클라이언트 요청 전체 크기 상한

/** 서버 시작 시 방을 미리 만들어 두고, 이후로는 생성/삭제하지 않는다. */
const rooms = new Map(
  Array.from({ length: ROOM_COUNT }, (_, i) => {
    const code = String(i + 1);
    return [code, game.createRoom(code)];
  }),
);
/** 방마다 하나씩 두는 채팅 기록. 게임 상태(rooms)와 따로 살고, 방이 대기실로 되돌아갈 때 함께 비운다. */
const chats = new Map([...rooms.keys()].map((code) => [code, chat.createChat()]));
const chatHistoryOf = (code) => ({ type: 'chatHistory', messages: chats.get(code).messages, textMax: chat.CHAT_TEXT_MAX });
/** 방마다 하나씩 두는 음성 참여자 목록. 채팅과 같은 생애를 산다. */
const voices = new Map([...rooms.keys()].map((code) => [code, rtc.createVoice()]));
/** @type {Map<import('ws').WebSocket, {roomCode: string, playerId: string, name: string}>} */
const sessions = new Map();

/** 음성 참여자 목록. 이름은 게임 상태가 아니라 세션에서 가져온다. */
function voiceStateOf(code) {
  const nameOf = new Map();
  for (const s of sessions.values()) if (s.roomCode === code) nameOf.set(s.playerId, s.name);
  return { type: 'voice', members: rtc.membersOf(voices.get(code)).map((id) => ({ id, name: nameOf.get(id) ?? '???' })) };
}

/** 채팅 기록과 음성 참여자를 함께 비운다. 방이 대기실로 되돌아갈 때. */
function resetSocial(code) {
  chats.set(code, chat.createChat());
  voices.set(code, rtc.createVoice());
}
/** 열려 있는 모든 연결. 이 중 sessions에 없는 것이 '아직 방을 고르는 중'인 사람이다. */
const lobbySockets = new Set();

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const send = (ws, payload) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
};
// fatal: 입장 자체가 실패한 경우. 클라이언트는 재접속을 멈추고 첫 화면으로 돌아간다.
const fail = (ws, message, fatal = false) => send(ws, { type: 'error', message, fatal });

const roomList = () => [...rooms.values()].map(game.summary);

/** 방 안의 사람들에게는 각자의 시점으로, 입장 전 사람들에게는 방 목록을 보낸다. */
function publish(room) {
  const now = Date.now();
  for (const [ws, session] of sessions) {
    if (session.roomCode === room.code) {
      send(ws, { type: 'state', state: game.viewFor(room, session.playerId), serverNow: now });
    }
  }
  broadcastLobby();
}

/** 아직 방에 들어가지 않은 모든 연결에 방 목록 전송 */
function broadcastLobby() {
  const rows = roomList();
  for (const ws of lobbySockets) {
    if (!sessions.has(ws)) send(ws, { type: 'rooms', rooms: rows });
  }
}

/** 같은 방의 모든 연결에 보낸다. 게임 상태(viewFor)를 거치지 않는 메시지용. */
function broadcastRoom(roomCode, payload) {
  for (const [ws, session] of sessions) {
    if (session.roomCode === roomCode) send(ws, payload);
  }
}

/** 라이브채팅. 게임 규칙과 무관하므로 방 상태를 읽지 않고, 세션에 적어둔 이름만 쓴다. */
function handleChat(ws, session, msg) {
  const log = chats.get(session.roomCode);
  if (!log) return fail(ws, '방이 사라졌습니다.', true);
  if (msg.type === 'chatHistory') return send(ws, chatHistoryOf(session.roomCode));

  const result = chat.postMessage(log, { by: session.playerId, name: session.name }, msg.text);
  if (!result.ok) return fail(ws, result.error);
  broadcastRoom(session.roomCode, { type: 'chat', message: result.message });
}

/**
 * 음성. 참여/이탈은 목록을 모두에게 알리고, 시그널(rtc)은 상대 한 사람에게만 건넨다 — 절대 방 전체로 뿌리지 않는다.
 * 소리 자체는 서버를 거치지 않는다.
 */
function handleVoice(ws, session, msg) {
  const voice = voices.get(session.roomCode);
  if (!voice) return fail(ws, '방이 사라졌습니다.', true);
  const me = session.playerId;

  if (msg.type === 'voiceState') return send(ws, voiceStateOf(session.roomCode));
  if (msg.type === 'voice') {
    if (msg.on) rtc.join(voice, me);
    else rtc.leave(voice, me);
    return broadcastRoom(session.roomCode, voiceStateOf(session.roomCode));
  }

  if (typeof msg.to !== 'string' || typeof msg.data !== 'object' || msg.data === null) {
    return fail(ws, '잘못된 시그널링 요청입니다.');
  }
  if (!rtc.canRelay(voice, me, msg.to)) return fail(ws, '음성에 참여한 사람에게만 연결할 수 있습니다.');
  if (JSON.stringify(msg.data).length > rtc.RTC_DATA_MAX) return fail(ws, '시그널링 데이터가 너무 큽니다.');
  for (const [otherWs, other] of sessions) {
    if (other.roomCode === session.roomCode && other.playerId === msg.to) {
      return send(otherWs, { type: 'rtc', from: me, data: msg.data });
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
    case 'pickFirst':
      result = game.pickFirstAnswerer(room, me, msg.playerId ?? null);
      break;
    case 'start':
      result = game.startGame(room, me, now);
      break;
    case 'secret':
      result = game.setSecret(room, me, msg.text, msg.category, now);
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
  publish(room);
}

function handleEntry(ws, msg) {
  const name = String(msg.name ?? '').trim();
  const reject = (message) => fail(ws, message, true);

  const code = String(msg.code ?? '').trim();
  const room = rooms.get(code);
  if (!room) return reject('그런 방이 없습니다.');

  // 토큰을 가진 사람은 게임 중이어도 자기 자리로 돌아올 수 있다.
  if (msg.token && game.findPlayer(room, msg.token)) {
    for (const [otherWs, other] of sessions) {
      if (other.playerId === msg.token && otherWs !== ws) {
        sessions.delete(otherWs);
        otherWs.close();
      }
    }
    const back = game.reconnect(room, msg.token);
    if (!back.ok) return reject(back.error);
    // 새 페이지는 이전 페이지의 음성 연결을 이어받을 수 없다. 참여 중이었다면 빠진 것으로 하고 남은 사람들에게 알린다.
    if (rtc.leave(voices.get(code), msg.token)) broadcastRoom(code, voiceStateOf(code));
    sessions.set(ws, { roomCode: code, playerId: msg.token, name: back.player.name });
    send(ws, { type: 'joined', playerId: msg.token, code });
    send(ws, chatHistoryOf(code));
    send(ws, voiceStateOf(code));
    publish(room);
    return;
  }

  const playerId = randomId();
  const joined = game.joinRoom(room, { id: playerId, name });
  if (!joined.ok) return reject(joined.error);
  sessions.set(ws, { roomCode: code, playerId, name: joined.player.name });
  send(ws, { type: 'joined', playerId, code });
  send(ws, chatHistoryOf(code));
  send(ws, voiceStateOf(code));
  publish(room);
}

/** 테스트 전용: 모든 방을 빈 대기실로 되돌린다. 방이 고정이라 테스트끼리 상태가 섞이기 때문. */
export function resetRooms() {
  for (const room of rooms.values()) {
    game.resetRoom(room);
    resetSocial(room.code);
  }
}

export function createServer() {
  const app = express();
  const dist = path.join(__dirname, '..', 'dist');
  app.use(express.static(dist));
  app.get('/healthz', (_req, res) => res.json({ ok: true, rooms: roomList() }));
  app.use((_req, res) => {
    if (existsSync(path.join(dist, 'index.html'))) return res.sendFile(path.join(dist, 'index.html'));
    res.status(503).type('text/plain').send('먼저 npm run build 를 실행해 주세요. (dist 폴더가 없습니다)');
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: WS_DATA_MAX });

  wss.on('connection', (ws) => {
    // 잘못된/과도한 프레임은 해당 연결만 닫는다. error 이벤트를 방치하면 프로세스까지 종료될 수 있다.
    ws.on('error', () => {});
    lobbySockets.add(ws);
    send(ws, { type: 'rooms', rooms: roomList() }); // 첫 화면에 보여줄 방 목록

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
        if (msg.type === 'join') return handleEntry(ws, msg);
        return fail(ws, '먼저 방에 입장하세요.', true);
      }
      if (msg.type === 'chat' || msg.type === 'chatHistory') return handleChat(ws, session, msg);
      if (msg.type === 'voice' || msg.type === 'voiceState' || msg.type === 'rtc') return handleVoice(ws, session, msg);
      handle(ws, session, msg);
    });

    ws.on('close', () => {
      const session = sessions.get(ws);
      sessions.delete(ws);
      lobbySockets.delete(ws);
      if (!session) return;
      const room = rooms.get(session.roomCode);
      if (!room) return;
      // 연결이 끊긴 사람은 음성에서도 빠진다. 남은 사람들이 그 사람과의 피어 연결을 닫을 수 있게 알린다.
      if (rtc.leave(voices.get(room.code), session.playerId)) broadcastRoom(room.code, voiceStateOf(room.code));
      game.disconnect(room, session.playerId, Date.now());
      // 대기실이 비면 채팅·음성도 바로 비운다 — 다음에 들어오는 다른 사람들에게 이전 대화가 보이지 않게.
      if (room.phase === 'lobby' && game.connectedPlayers(room).length === 0) resetSocial(room.code);
      publish(room);
    });
  });

  // 제한 시간 처리 + 빈 방 초기화
  const timer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (game.tick(room, now)) publish(room);

      if (room.players.some((p) => p.connected)) {
        room.lastSeenAt = now;
        continue;
      }
      // 아무도 없는 방은 삭제하지 않고 대기실로 되돌린다(방이 3개뿐이라 자리를 비워줘야 한다).
      // 끝난 게임은 지킬 것이 없으니 즉시, 진행 중이던 판은 재접속을 기다렸다가 반납한다.
      const waited = now - (room.lastSeenAt ?? room.createdAt);
      if (room.phase === 'gameEnd' || (room.phase !== 'lobby' && waited > EMPTY_ROOM_RESET)) {
        game.resetRoom(room, now);
        resetSocial(room.code);
        room.lastSeenAt = now;
        broadcastLobby();
      }
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
