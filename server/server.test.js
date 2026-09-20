// 실제 WebSocket 서버를 띄우고 여러 클라이언트로 한 라운드를 끝까지 돌린다.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import WebSocket from 'ws';
import { createServer, resetRooms, WS_DATA_MAX } from './index.js';
import { RTC_DATA_MAX } from './rtc.js';

let server;
let url;
const clients = new Set();
const GRACE = 500; // 끊긴 자리를 비우기까지의 유예. 실제 기본값(5초)은 테스트를 느리게 하므로 줄인다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  server = createServer({ reconnectGrace: GRACE });
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
  it('과도하게 큰 요청은 JSON 파싱 전에 연결을 닫는다', async () => {
    const a = await connect();
    const closed = new Promise((resolve) => a.ws.once('close', resolve));
    a.ws.send('x'.repeat(WS_DATA_MAX + 1));
    expect(await closed).toBe(1009);
  });

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
    a.send({ type: 'secret', text: '고양이', category: '동물' });
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

  it('방장이 대기실에서 첫 출제자를 지정하면 그 사람부터 시작한다', async () => {
    const host = await connect();
    const b = await connect();
    const c = await connect();
    for (const [client, name] of [[host, '방장'], [b, '비'], [c, '씨']]) {
      client.send({ type: 'join', code: '2', name });
    }
    await c.wait((m) => m.type === 'state' && m.state.players.length === 3);
    const idOf = (name) => host.latest().players.find((p) => p.name === name).id;

    // 방장이 아닌 사람은 지정할 수 없다
    b.send({ type: 'pickFirst', playerId: idOf('씨') });
    await b.wait((m) => m.type === 'error' && m.message.includes('방장'));

    // 방장이 지정하면 모두의 화면에 반영된다
    host.send({ type: 'pickFirst', playerId: idOf('씨') });
    await b.wait((m) => m.type === 'state' && m.state.firstAnswererId === idOf('씨'));

    host.send({ type: 'start' });
    const view = (await b.wait(isState('secret'))).state;
    expect(view.answererId).toBe(idOf('씨'));
    expect(view.round).toBe(1);
    expect(view.totalRounds).toBe(3);

    [host, b, c].forEach((client) => client.close());
  });

  it('유예가 지나 끊김으로 표시된 뒤에도 같은 토큰으로 돌아온다', async () => {
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
    await a.wait((m) => m.type === 'state' && m.state.players.some((p) => !p.connected)); // 유예(GRACE)가 지난 뒤
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

describe('라이브채팅 (게임 상태와 분리)', () => {
  it('채팅은 전용 메시지로 오가고, 게임 상태 스냅샷에는 실리지 않는다', async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: 'join', code: '2', name: '가' });
    b.send({ type: 'join', code: '2', name: '나' });
    await a.wait((m) => m.type === 'state' && m.state.players.length === 2);

    a.send({ type: 'chat', text: '  안녕하세요  ' });
    const got = await b.wait((m) => m.type === 'chat');
    expect(got.message).toMatchObject({ name: '가', text: '안녕하세요' });
    expect((await a.wait((m) => m.type === 'chat')).message).toEqual(got.message);
    expect(a.latest()).not.toHaveProperty('chat');

    b.send({ type: 'chat', text: '' });
    await b.wait((m) => m.type === 'error' && m.message.includes('메시지'));

    [a, b].forEach((c) => c.close());
  });

  it('늦게 들어온 사람과 토큰으로 돌아온 사람은 이전 대화를 받는다', async () => {
    const a = await connect();
    a.send({ type: 'join', code: '3', name: '방장' });
    await a.wait((m) => m.type === 'joined');
    a.send({ type: 'chat', text: '첫 마디' });
    await a.wait((m) => m.type === 'chat');

    // 늦게 들어온 사람: 입장 직후 이력을 받는다
    const b = await connect();
    b.send({ type: 'join', code: '3', name: '손님' });
    const bJoined = await b.wait((m) => m.type === 'joined');
    const history = await b.wait((m) => m.type === 'chatHistory');
    expect(history.messages.map((m) => m.text)).toEqual(['첫 마디']);
    expect(history.textMax).toBeGreaterThan(0);

    // 패널이 늦게 열려도 요청하면 다시 받는다
    b.send({ type: 'chatHistory' });
    await b.wait(() => b.inbox.filter((m) => m.type === 'chatHistory').length === 2);

    // 게임 중 끊겼다가 토큰으로 돌아온 사람도 받는다
    await a.wait((m) => m.type === 'state' && m.state.players.length === 2);
    a.send({ type: 'start' });
    await b.wait(isState('secret'));
    b.close();
    const back = await connect();
    back.send({ type: 'join', code: '3', token: bJoined.playerId });
    expect((await back.wait((m) => m.type === 'chatHistory')).messages).toHaveLength(1);

    [a, back].forEach((c) => c.close());
  });
});

describe('음성 (시그널링 릴레이)', () => {
  const voiceMsgs = (client) => client.inbox.filter((m) => m.type === 'voice');
  const latestVoice = (client) => voiceMsgs(client).at(-1);

  it('참여하면 모두에게 참여자 목록이 가고, 시그널은 상대 한 사람에게만 닿는다', async () => {
    const a = await connect();
    const b = await connect();
    const c = await connect();
    for (const [client, name] of [[a, '가'], [b, '나'], [c, '다']]) client.send({ type: 'join', code: '1', name });
    const aId = (await a.wait((m) => m.type === 'joined')).playerId;
    const bId = (await b.wait((m) => m.type === 'joined')).playerId;
    const cId = (await c.wait((m) => m.type === 'joined')).playerId;
    await c.wait((m) => m.type === 'state' && m.state.players.length === 3);
    expect((await c.wait((m) => m.type === 'voice')).members).toEqual([]); // 입장 직후 빈 목록을 받는다

    a.send({ type: 'voice', on: true });
    b.send({ type: 'voice', on: true });
    await c.wait((m) => m.type === 'voice' && m.members.length === 2);
    expect(latestVoice(c).members).toEqual(
      expect.arrayContaining([
        { id: aId, name: '가' },
        { id: bId, name: '나' },
      ]),
    );
    expect(c.latest()).not.toHaveProperty('voice'); // 게임 상태 스냅샷에는 실리지 않는다

    // a → b: b만 받고, 보낸 사람 id가 붙는다
    const offer = { sdp: { type: 'offer', sdp: 'v=0' } };
    a.send({ type: 'rtc', to: bId, data: offer });
    expect(await b.wait((m) => m.type === 'rtc')).toEqual({ type: 'rtc', from: aId, data: offer });

    // 참여하지 않은 사람에게, 자기 자신에게, 너무 큰 데이터는 중계하지 않는다
    a.send({ type: 'rtc', to: cId, data: { candidate: {} } });
    a.send({ type: 'rtc', to: aId, data: { candidate: {} } });
    a.send({ type: 'rtc', to: bId, data: { sdp: 'x'.repeat(RTC_DATA_MAX + 1) } });
    a.send({ type: 'rtc', to: 42, data: { candidate: {} } });
    await a.wait(() => a.inbox.filter((m) => m.type === 'error').length === 4);
    expect(a.inbox.filter((m) => m.type === 'error').map((m) => m.message)).toEqual([
      expect.stringContaining('참여한 사람에게만'),
      expect.stringContaining('참여한 사람에게만'),
      expect.stringContaining('너무 큽니다'),
      expect.stringContaining('잘못된 시그널링'),
    ]);
    expect(b.inbox.filter((m) => m.type === 'rtc')).toHaveLength(1);
    expect(c.inbox.filter((m) => m.type === 'rtc')).toHaveLength(0);

    // 끊으면 목록이 줄고, 연결 자체가 끊긴 사람도 빠진다
    b.send({ type: 'voice', on: false });
    await c.wait(() => latestVoice(c)?.members.length === 1);
    expect(latestVoice(c).members).toEqual([{ id: aId, name: '가' }]);
    a.close();
    await c.wait(() => latestVoice(c)?.members.length === 0);

    [b, c].forEach((client) => client.close());
  });

  it('늦게 들어온 사람은 현재 참여자를 받고, 다른 탭에서 돌아온 사람은 다시 참여해야 한다', async () => {
    const a = await connect();
    a.send({ type: 'join', code: '2', name: '가' });
    const aId = (await a.wait((m) => m.type === 'joined')).playerId;
    a.send({ type: 'voice', on: true });
    await a.wait((m) => m.type === 'voice' && m.members.length === 1);

    const b = await connect();
    b.send({ type: 'join', code: '2', name: '나' });
    const bId = (await b.wait((m) => m.type === 'joined')).playerId;
    expect((await b.wait((m) => m.type === 'voice')).members).toEqual([{ id: aId, name: '가' }]);

    // 화면이 늦게 떠서 입장 직후 목록을 놓쳤으면 다시 요청할 수 있다
    b.send({ type: 'voiceState' });
    await b.wait(() => voiceMsgs(b).length === 2);
    expect(latestVoice(b).members).toEqual([{ id: aId, name: '가' }]);

    await a.wait((m) => m.type === 'state' && m.state.players.length === 2);
    a.send({ type: 'start' });
    await b.wait(isState('secret'));
    b.send({ type: 'voice', on: true });
    await a.wait(() => latestVoice(a)?.members.length === 2);
    const before = voiceMsgs(a).length;

    // b가 다른 탭에서 같은 토큰으로 들어오면 이전 탭은 밀려나고, 새 탭은 음성을 이어받지 못하므로 참여가 풀린다
    const back = await connect();
    back.send({ type: 'join', code: '2', token: bId });
    expect((await back.wait((m) => m.type === 'voice')).members).toEqual([{ id: aId, name: '가' }]);
    await a.wait(() => voiceMsgs(a).length > before);
    expect(latestVoice(a).members).toEqual([{ id: aId, name: '가' }]);

    [a, back].forEach((client) => client.close());
  });
});

describe('새로고침(F5) 좌석 유예', () => {
  it('게임 중 잠시 끊겼다 같은 토큰으로 돌아오면 게임이 그대로 이어진다 (2명·방장·출제자여도)', async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: 'join', code: '1', name: '방장' });
    b.send({ type: 'join', code: '1', name: '손님' });
    const aId = (await a.wait((m) => m.type === 'joined')).playerId;
    await a.wait((m) => m.type === 'state' && m.state.players.length === 2);
    a.send({ type: 'start' });
    await b.wait(isState('secret'));
    expect(b.latest()).toMatchObject({ hostId: aId, answererId: aId });

    // 방장이자 출제자인 a가 새로고침: 연결이 끊기고 곧 새 연결이 같은 토큰으로 들어온다.
    // 예전에는 이 순간 출제자 이탈로 라운드가 무효가 되고, 2명이라 인원 부족으로 게임까지 끝났다.
    a.close();
    const back = await connect();
    back.send({ type: 'join', code: '1', token: aId });
    const view = (await back.wait(isState('secret'))).state;
    expect(view).toMatchObject({ you: aId, hostId: aId, answererId: aId, round: 1 });
    expect(view.players.every((p) => p.connected)).toBe(true);

    // 남아 있던 b는 끊김·라운드 무효·게임 종료 중 어느 것도 보지 못했다
    const seen = b.inbox.filter((m) => m.type === 'state').map((m) => m.state);
    expect(seen.every((s) => s.phase === 'lobby' || s.phase === 'secret')).toBe(true);
    expect(seen.every((s) => s.players.every((p) => p.connected))).toBe(true);

    // 유예가 지나도 자리는 그대로다 (비우기 예약이 취소되었는지)
    await sleep(GRACE + 200);
    expect(b.latest().phase).toBe('secret');
    expect(b.latest().players.every((p) => p.connected)).toBe(true);

    [b, back].forEach((c) => c.close());
  });

  it('대기실에서 새로고침해도 같은 자리(방장)로 돌아온다', async () => {
    const a = await connect();
    a.send({ type: 'join', code: '2', name: '혼자' });
    const aId = (await a.wait((m) => m.type === 'joined')).playerId;
    a.close();

    const back = await connect();
    back.send({ type: 'join', code: '2', token: aId });
    const view = (await back.wait(isState('lobby'))).state;
    expect(view.you).toBe(aId);
    expect(view.hostId).toBe(aId);
    expect(view.players).toEqual([expect.objectContaining({ id: aId, name: '혼자', connected: true })]);
    back.close();
  });

  it('유예 안에 돌아오지 않으면 그때 자리를 비우고, 비워진 자리의 토큰은 거절한다', async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: 'join', code: '3', name: '갈사람' });
    b.send({ type: 'join', code: '3', name: '남을사람' });
    const aId = (await a.wait((m) => m.type === 'joined')).playerId;
    await b.wait((m) => m.type === 'state' && m.state.players.length === 2);

    a.close();
    await sleep(GRACE / 3);
    expect(b.latest().players).toHaveLength(2); // 아직은 자리를 잡아 두고 있다
    await b.wait((m) => m.type === 'state' && m.state.players.length === 1);

    const late = await connect();
    late.send({ type: 'join', code: '3', token: aId });
    const error = await late.wait((m) => m.type === 'error');
    expect(error).toMatchObject({ fatal: true, message: expect.stringContaining('비워졌습니다') });

    [b, late].forEach((c) => c.close());
  });

  it('나가기는 유예 없이 바로 자리를 비우고, 연결을 유지한 채 방 목록으로 돌아간다', async () => {
    const a = await connect();
    const b = await connect();
    a.send({ type: 'join', code: '1', name: '가' });
    b.send({ type: 'join', code: '1', name: '나' });
    await a.wait((m) => m.type === 'state' && m.state.players.length === 2);
    a.send({ type: 'voice', on: true });
    await b.wait((m) => m.type === 'voice' && m.members.length === 1);

    const mark = a.inbox.length;
    a.send({ type: 'leave' });
    await b.wait((m) => m.type === 'state' && m.state.players.length === 1);
    await b.wait((m) => m.type === 'voice' && m.members.length === 0); // 음성에서도 바로 빠진다
    const rows = (await a.wait((m) => a.inbox.indexOf(m) >= mark && m.type === 'rooms')).rooms;
    expect(rows.find((r) => r.code === '1')).toMatchObject({ players: 1, joinable: true });

    // 같은 닉네임으로 곧바로 다시 들어갈 수 있다 (자리가 정말 비워졌다)
    a.send({ type: 'join', code: '1', name: '가' });
    await a.wait((m) => a.inbox.indexOf(m) >= mark && m.type === 'state' && m.state.players.length === 2);
    expect(a.inbox.filter((m) => m.type === 'error')).toEqual([]);

    [a, b].forEach((c) => c.close());
  });
});
