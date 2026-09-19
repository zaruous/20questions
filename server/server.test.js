// 실제 WebSocket 서버를 띄우고 여러 클라이언트로 한 라운드를 끝까지 돌린다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer } from './index.js';

let server;
let url;
const clients = new Set();

beforeAll(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  url = `ws://localhost:${server.address().port}/ws`;
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

describe('WebSocket 서버', () => {
  it('3명이 한 라운드를 끝까지 진행한다', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();

    a.send({ type: 'create', name: '출제자' });
    const joined = await a.wait((m) => m.type === 'joined');
    const code = joined.code;
    expect(code).toHaveLength(4);

    b.send({ type: 'join', code, name: '비' });
    c.send({ type: 'join', code, name: '씨' });
    await a.wait((m) => m.type === 'state' && m.state.players.length === 3);

    // 방장이 아니면 시작할 수 없다
    b.send({ type: 'start' });
    await b.wait((m) => m.type === 'error' && m.message.includes('방장'));

    a.send({ type: 'start' });
    await c.wait(isState('secret'));
    expect(c.latest().answererId).toBe(joined.playerId);

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
    expect(view.secret).toBe('고양이'); // 라운드가 끝나면 공개
    expect(view.lastResult.reason).toBe('solved');
    expect(view.players.find((p) => p.name === '씨').score).toBe(3);
    expect(view.players.find((p) => p.name === '출제자').score).toBe(1);

    [a, b, c].forEach((client) => client.close());
  });

  it('끊긴 플레이어가 같은 토큰으로 돌아온다', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    a.send({ type: 'create', name: '방장' });
    const { code } = await a.wait((m) => m.type === 'joined');
    b.send({ type: 'join', code, name: '손님' });
    c.send({ type: 'join', code, name: '구경' });
    const bJoined = await b.wait((m) => m.type === 'joined');
    await a.wait((m) => m.type === 'state' && m.state.players.length === 3);

    a.send({ type: 'start' });
    await a.wait(isState('secret'));

    b.close();
    // 3명 중 1명이 빠져도 라운드는 계속되고, 자리만 '끊김'으로 남는다
    await a.wait((m) => m.type === 'state' && m.state.players.some((p) => !p.connected));
    expect(a.latest().phase).toBe('secret');

    const back = await connect();
    back.send({ type: 'join', code, token: bJoined.playerId });
    const view = (await back.wait(isState('secret'))).state;
    expect(view.you).toBe(bJoined.playerId);
    expect(view.players).toHaveLength(3);
    expect(view.players.every((p) => p.connected)).toBe(true);

    [a, c, back].forEach((client) => client.close());
  });

  it('없는 방 코드와 가득 찬 방을 거절한다', async () => {
    const stray = await connect();
    stray.send({ type: 'join', code: 'ZZZZ', name: '길잃음' });
    await stray.wait((m) => m.type === 'error' && m.message.includes('방 코드'));

    stray.send({ type: 'ask', text: '방에도 없는데 질문' });
    await stray.wait((m) => m.type === 'error' && m.message.includes('먼저 방에'));

    const host = await connect();
    host.send({ type: 'create', name: 'H' });
    const { code } = await host.wait((m) => m.type === 'joined');
    const others = [];
    for (let i = 1; i < 8; i += 1) {
      const client = await connect();
      client.send({ type: 'join', code, name: `P${i}` });
      others.push(client);
    }
    await host.wait((m) => m.type === 'state' && m.state.players.length === 8);

    const ninth = await connect();
    ninth.send({ type: 'join', code, name: '아홉' });
    await ninth.wait((m) => m.type === 'error' && m.message.includes('가득'));

    [stray, host, ninth, ...others].forEach((client) => client.close());
  });
});
