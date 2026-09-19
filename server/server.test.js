// 실제 WebSocket 서버를 띄우고 여러 클라이언트로 한 라운드를 끝까지 돌린다.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer, resetRooms } from './index.js';

let server;
let url;
const clients = new Set();

beforeAll(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  url = `ws://localhost:${server.address().port}/ws`;
});

beforeEach(() => {
  resetRooms(); // 방이 고정이므로 테스트마다 초기 상태로 되돌린다
});

afterAll(async () => {
  for (const ws of clients) ws.terminate();
  clients.clear();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

/** 받은 메시지를 모두 기록하는 테스트용 클라이언트 */
async function connect() {
  const ws = new WebSocket(url);
  clients.add(ws);
  const inbox = [];
  ws.on('message', (raw) => inbox.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    inbox,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    /** 조건을 만족하는 메시지가 올 때까지 기다린다 */
    async wait(predicate, timeout = 2000) {
      const started = Date.now();
      for (;;) {
        const hit = inbox.find(predicate);
        if (hit) return hit;
        if (Date.now() - started > timeout) throw new Error('메시지를 기다리다 시간이 초과되었습니다.');
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    latest: () => [...inbox].reverse().find((m) => m.type === 'state')?.state,
  };
}

const isState = (phase) => (m) => m.type === 'state' && m.state.phase === phase;
const latestRooms = (client) => [...client.inbox].reverse().find((m) => m.type === 'rooms')?.rooms;

describe('WebSocket 서버 (고정 3개 방)', () => {
  it('접속하면 방 목록 3개를 바로 받는다', async () => {
    const a = await connect();
    const list = (await a.wait((m) => m.type === 'rooms')).rooms;
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.code)).toEqual(['1', '2', '3']);
    expect(list.every((r) => r.joinable && r.players === 0 && r.capacity === 8)).toBe(true);
    a.close();
  });

  it('방을 고르면 들어가고, 밖에 있는 사람의 목록이 실시간으로 바뀐다', async () => {
    const watcher = await connect(); // 첫 화면에 머물러 있는 사람
    await watcher.wait((m) => m.type === 'rooms');

    const a = await connect();
    a.send({ type: 'join', code: '2', name: '지우' });
    const joined = await a.wait((m) => m.type === 'joined');
    expect(joined.code).toBe('2');
    expect(a.latest().name).toBe('2번 방');

    await watcher.wait((m) => m.type === 'rooms' && m.rooms.find((r) => r.code === '2').players === 1);
    const row = latestRooms(watcher).find((r) => r.code === '2');
    expect(row).toMatchObject({ players: 1, phase: 'lobby', joinable: true });
    expect(latestRooms(watcher).find((r) => r.code === '1').players).toBe(0);

    [watcher, a].forEach((c) => c.close());
  });

  it('없는 방 번호는 거절한다', async () => {
    const a = await connect();
    a.send({ type: 'join', code: '4', name: '길잃음' });
    await a.wait((m) => m.type === 'error' && m.message.includes('그런 방이 없습니다'));
    a.close();
  });

  it('게임이 시작된 방은 목록에서 잠기고 새 사람이 못 들어온다', async () => {
    const watcher = await connect();
    await watcher.wait((m) => m.type === 'rooms');
    const a = await connect();
    const b = await connect();
    a.send({ type: 'join', code: '3', name: '방장' });
    b.send({ type: 'join', code: '3', name: '손님' });
    await a.wait((m) => m.type === 'state' && m.state.players.length === 2);
    a.send({ type: 'start' });
    await a.wait(isState('secret'));

    await watcher.wait((m) => m.type === 'rooms' && !m.rooms.find((r) => r.code === '3').joinable);
    expect(latestRooms(watcher).find((r) => r.code === '3')).toMatchObject({ joinable: false, phase: 'secret' });

    const late = await connect();
    late.send({ type: 'join', code: '3', name: '지각생' });
    await late.wait((m) => m.type === 'error' && m.message.includes('진행 중'));

    [watcher, a, b, late].forEach((c) => c.close());
  });

  it('한 방에서 3명이 한 라운드를 끝까지 진행한다', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    for (const [client, name] of [[a, '출제자'], [b, '비'], [c, '씨']]) {
      client.send({ type: 'join', code: '1', name });
    }
    await a.wait((m) => m.type === 'state' && m.state.players.length === 3);

    b.send({ type: 'start' });
    await b.wait((m) => m.type === 'error' && m.message.includes('방장'));

    a.send({ type: 'start' });
    await c.wait(isState('secret'));
    a.send({ type: 'secret', text: '고양이' });
    await b.wait(isState('asking'));

    // 정답 단어는 출제자에게만 전달된다
    expect(a.latest().secret).toBe('고양이');
    expect(b.latest().secret).toBeNull();
    expect(JSON.stringify(b.inbox)).not.toContain('고양이');

    b.send({ type: 'ask', text: '동물인가요?' });
    await a.wait((m) => m.type === 'state' && m.state.pendingId === 'q1');
    a.send({ type: 'answer', verdict: 'yes' });
    await c.wait((m) => m.type === 'state' && m.state.questions[0]?.verdict === 'yes');
    expect(c.latest().remaining).toBe(19);

    c.send({ type: 'guess', text: ' 고양이 ' });
    await b.wait(isState('roundEnd'));
    const view = b.latest();
    expect(view.secret).toBe('고양이');
    expect(view.lastResult).toMatchObject({ reason: 'solved' });
    expect(view.players.find((p) => p.name === '씨').score).toBe(3);
    expect(view.players.find((p) => p.name === '출제자').score).toBe(1);

    [a, b, c].forEach((client) => client.close());
  });

  it('끊긴 플레이어가 같은 토큰으로 돌아온다', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    a.send({ type: 'join', code: '2', name: '방장' });
    b.send({ type: 'join', code: '2', name: '손님' });
    c.send({ type: 'join', code: '2', name: '구경' });
    const bJoined = await b.wait((m) => m.type === 'joined');
    await a.wait((m) => m.type === 'state' && m.state.players.length === 3);

    a.send({ type: 'start' });
    await a.wait(isState('secret'));

    b.close();
    await a.wait((m) => m.type === 'state' && m.state.players.some((p) => !p.connected));
    expect(a.latest().phase).toBe('secret');

    const back = await connect();
    back.send({ type: 'join', code: '2', token: bJoined.playerId });
    const view = (await back.wait(isState('secret'))).state;
    expect(view.you).toBe(bJoined.playerId);
    expect(view.players).toHaveLength(3);
    expect(view.players.every((p) => p.connected)).toBe(true);

    [a, c, back].forEach((client) => client.close());
  });

  it('사람이 다 나간 방은 다시 대기실로 열린다', async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: 'join', code: '1', name: '지우' });
    b.send({ type: 'join', code: '1', name: '민수' });
    await a.wait((m) => m.type === 'state' && m.state.players.length === 2);
    a.send({ type: 'start' });
    await a.wait(isState('secret'));

    // 둘 다 나가면 인원 부족으로 게임이 끝나고, 방은 비워진 채 잠긴 상태가 된다
    a.close();
    b.close();

    // 1초 틱이 돌면서 방을 대기실로 되돌려야 한다 (끝난 게임은 즉시 반납)
    const watcher = await connect();
    const list = await watcher.wait(
      (m) => m.type === 'rooms' && m.rooms.find((r) => r.code === '1')?.joinable,
      4000,
    );
    expect(list.rooms.find((r) => r.code === '1')).toMatchObject({ players: 0, phase: 'lobby', joinable: true });

    // 실제로 다시 들어갈 수 있어야 한다
    watcher.send({ type: 'join', code: '1', name: '새손님' });
    const back = await watcher.wait(isState('lobby'));
    expect(back.state.players).toHaveLength(1);
    watcher.close();
  });

  it('정원 8명이 차면 9번째를 거절한다', async () => {
    const clientsInRoom = [];
    for (let i = 0; i < 8; i += 1) {
      const client = await connect();
      client.send({ type: 'join', code: '3', name: `P${i}` });
      clientsInRoom.push(client);
    }
    await clientsInRoom[0].wait((m) => m.type === 'state' && m.state.players.length === 8);

    const ninth = await connect();
    ninth.send({ type: 'join', code: '3', name: '아홉' });
    await ninth.wait((m) => m.type === 'error' && m.message.includes('가득'));

    [...clientsInRoom, ninth].forEach((client) => client.close());
  });
});
