import { describe, it, expect, beforeEach } from 'vitest';
import * as g from './game.js';

const T0 = 1_700_000_000_000;

/** n명이 들어와 있는 방 */
function roomWith(n, now = T0) {
  const room = g.createRoom('TEST', now);
  for (let i = 0; i < n; i += 1) g.joinRoom(room, { id: `p${i}`, name: `플레이어${i}` }, now);
  return room;
}

/** 질문 1개를 묻고 답해서 예산을 1 소모 */
function spendQuestion(room, asker, now = T0) {
  g.askQuestion(room, asker, '동물인가요?', now);
  g.answerQuestion(room, room.answererId, 'yes', now);
}

describe('입장 규칙', () => {
  it('최대 8명까지만 들어온다', () => {
    const room = roomWith(8);
    expect(room.players).toHaveLength(8);
    const ninth = g.joinRoom(room, { id: 'p8', name: '아홉번째' });
    expect(ninth.ok).toBe(false);
    expect(ninth.error).toContain('가득');
  });

  it('닉네임이 비었거나 중복이면 거절한다', () => {
    const room = roomWith(1);
    expect(g.joinRoom(room, { id: 'x', name: '   ' }).ok).toBe(false);
    expect(g.joinRoom(room, { id: 'x', name: '플레이어0' }).ok).toBe(false);
    expect(g.joinRoom(room, { id: 'x', name: 'a'.repeat(g.NAME_MAX + 1) }).ok).toBe(false);
  });

  it('첫 입장자가 방장이 되고, 게임 중에는 새로 들어올 수 없다', () => {
    const room = roomWith(2);
    expect(room.hostId).toBe('p0');
    g.startGame(room, 'p0');
    expect(g.joinRoom(room, { id: 'late', name: '지각생' }).ok).toBe(false);
  });
});

describe('게임 시작', () => {
  it('2명 미만이면 시작할 수 없다', () => {
    const room = roomWith(1);
    const res = g.startGame(room, 'p0');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('2명');
  });

  it('방장만 시작할 수 있다', () => {
    const room = roomWith(3);
    expect(g.startGame(room, 'p1').ok).toBe(false);
    expect(g.startGame(room, 'p0').ok).toBe(true);
  });

  it('시작하면 첫 출제자가 정해지고 단어 입력 단계가 된다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    expect(room.phase).toBe('secret');
    expect(room.answererId).toBe('p0');
    expect(room.roster).toHaveLength(3);
    expect(room.deadline).toBe(T0 + g.SECRET_SECONDS * 1000);
  });
});

describe('정답 단어 비공개', () => {
  let room;
  beforeEach(() => {
    room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
  });

  it('출제자 화면에만 단어가 담긴다', () => {
    expect(g.viewFor(room, 'p0').secret).toBe('고양이');
    expect(g.viewFor(room, 'p1').secret).toBeNull();
    expect(g.viewFor(room, 'p2').secret).toBeNull();
  });

  it('추측자 화면 어디에도 단어 문자열이 들어 있지 않다', () => {
    g.askQuestion(room, 'p1', '동물인가요?', T0);
    g.answerQuestion(room, 'p0', 'yes', T0);
    expect(JSON.stringify(g.viewFor(room, 'p1'))).not.toContain('고양이');
  });

  it('라운드가 끝나면 모두에게 공개된다', () => {
    g.endRound(room, 'timeout', T0);
    expect(g.viewFor(room, 'p1').secret).toBe('고양이');
    expect(g.viewFor(room, 'p1').lastResult.secret).toBe('고양이');
  });

  it('출제자만 단어를 정할 수 있다', () => {
    const fresh = roomWith(2);
    g.startGame(fresh, 'p0', T0);
    expect(g.setSecret(fresh, 'p1', '몰래', '동물', T0).ok).toBe(false);
    expect(g.setSecret(fresh, 'p0', '', '동물', T0).ok).toBe(false);
    expect(g.setSecret(fresh, 'p0', 'a'.repeat(g.SECRET_MAX + 1), '동물', T0).ok).toBe(false);
  });
});

describe('주제', () => {
  it('후보는 중복 없이 풀에서만 뽑힌다', () => {
    const picked = g.pickCategoryChoices();
    expect(picked).toHaveLength(g.CATEGORY_CHOICES);
    expect(new Set(picked).size).toBe(g.CATEGORY_CHOICES);
    expect(picked.every((c) => g.CATEGORY_POOL.includes(c))).toBe(true);
  });

  it('라운드마다 출제자에게 후보가 주어진다', () => {
    const room = roomWith(2);
    g.startGame(room, 'p0', T0);
    expect(g.viewFor(room, 'p0').categoryChoices).toHaveLength(g.CATEGORY_CHOICES);
    expect(g.viewFor(room, 'p1').categoryChoices).toEqual([]); // 추측자에겐 필요 없다
  });

  it('주제 없이는 단어를 확정할 수 없다', () => {
    const room = roomWith(2);
    g.startGame(room, 'p0', T0);
    expect(g.setSecret(room, 'p0', '고양이', '', T0).ok).toBe(false);
    expect(g.setSecret(room, 'p0', '고양이', 'a'.repeat(g.CATEGORY_MAX + 1), T0).ok).toBe(false);
    expect(room.phase).toBe('secret');
  });

  it('후보에 없는 주제도 직접 쓸 수 있고, 단어와 달리 모두에게 보인다', () => {
    const room = roomWith(2);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '주전자', '부엌에 있는 것', T0);
    expect(g.viewFor(room, 'p1').category).toBe('부엌에 있는 것');
    expect(g.viewFor(room, 'p1').secret).toBeNull();
  });

  it('다음 라운드로 넘어가면 지난 주제는 남지 않는다', () => {
    const room = roomWith(2);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
    g.endRound(room, 'timeout', T0);
    g.startRound(room, T0);
    expect(room.category).toBeNull();
  });
});

describe('질문과 답변', () => {
  let room;
  beforeEach(() => {
    room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
  });

  it('답변 대기 중에는 다음 질문을 받지 않는다', () => {
    expect(g.askQuestion(room, 'p1', '동물인가요?', T0).ok).toBe(true);
    const second = g.askQuestion(room, 'p2', '살아있나요?', T0);
    expect(second.ok).toBe(false);
    expect(second.error).toContain('답변되지 않은');
    g.answerQuestion(room, 'p0', 'yes', T0);
    expect(g.askQuestion(room, 'p2', '살아있나요?', T0).ok).toBe(true);
  });

  it('출제자는 질문할 수 없고, 추측자는 답변할 수 없다', () => {
    expect(g.askQuestion(room, 'p0', '내가 질문', T0).ok).toBe(false);
    g.askQuestion(room, 'p1', '동물인가요?', T0);
    expect(g.answerQuestion(room, 'p1', 'yes', T0).ok).toBe(false);
    expect(g.answerQuestion(room, 'p0', '아마도', T0).ok).toBe(false);
    expect(g.answerQuestion(room, 'p0', 'unclear', T0).ok).toBe(true);
  });

  it('20번째 질문이 답변되면 라운드가 끝나고 출제자가 2점을 얻는다', () => {
    for (let i = 0; i < g.MAX_QUESTIONS; i += 1) {
      expect(room.phase).toBe('asking');
      spendQuestion(room, 'p1', T0);
    }
    expect(g.remainingQuestions(room)).toBe(0);
    expect(room.phase).toBe('roundEnd');
    expect(room.lastResult.reason).toBe('outOfQuestions');
    expect(g.findPlayer(room, 'p0').score).toBe(2);
  });
});

describe('정답 추측', () => {
  let room;
  beforeEach(() => {
    room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
  });

  it('맞히면 추측자 3점, 출제자 1점을 받고 라운드가 끝난다', () => {
    const res = g.submitGuess(room, 'p1', '고양이', T0);
    expect(res.correct).toBe(true);
    expect(g.findPlayer(room, 'p1').score).toBe(3);
    expect(g.findPlayer(room, 'p0').score).toBe(1);
    expect(room.phase).toBe('roundEnd');
    expect(room.lastResult).toMatchObject({ reason: 'solved', winnerId: 'p1' });
  });

  it('공백과 문장부호, 대소문자는 무시하고 비교한다', () => {
    g.setSecret(room, 'p0', 'Hot Dog!', '동물', T0); // 이미 asking 단계라 무시되는지도 함께 확인
    expect(room.secret).toBe('고양이');
    expect(g.submitGuess(room, 'p1', ' 고 양 이 ', T0).correct).toBe(true);
  });

  it('틀린 추측은 질문 1개를 소모한다', () => {
    g.submitGuess(room, 'p1', '강아지', T0);
    expect(g.remainingQuestions(room)).toBe(g.MAX_QUESTIONS - 1);
    expect(room.phase).toBe('asking');
  });

  it('마지막 한 개를 틀린 추측으로 쓰면 라운드가 끝난다', () => {
    for (let i = 0; i < g.MAX_QUESTIONS - 1; i += 1) spendQuestion(room, 'p1', T0);
    expect(g.remainingQuestions(room)).toBe(1);
    g.submitGuess(room, 'p2', '강아지', T0);
    expect(room.phase).toBe('roundEnd');
    expect(g.findPlayer(room, 'p0').score).toBe(2);
  });

  it('출제자는 정답을 말할 수 없다', () => {
    expect(g.submitGuess(room, 'p0', '고양이', T0).ok).toBe(false);
  });
});

describe('라운드 진행과 종료', () => {
  it('모든 사람이 한 번씩 출제하면 게임이 끝난다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    for (const id of ['p0', 'p1', 'p2']) {
      expect(room.answererId).toBe(id);
      g.setSecret(room, id, '단어', '동물', T0);
      g.endRound(room, 'timeout', T0);
      g.nextRound(room, 'p0', T0);
    }
    expect(room.phase).toBe('gameEnd');
  });

  it('제한 시간이 지나면 단계별로 자동 처리된다', () => {
    const room = roomWith(2);
    g.startGame(room, 'p0', T0);
    expect(g.tick(room, T0 + 1000)).toBe(false);

    // 단어를 못 정하면 라운드 무효(점수 없음)
    expect(g.tick(room, T0 + g.SECRET_SECONDS * 1000)).toBe(true);
    expect(room.lastResult.reason).toBe('noSecret');
    expect(g.findPlayer(room, 'p0').score).toBe(0);

    // 결과 화면은 시간이 지나면 다음 라운드로
    const t1 = T0 + g.SECRET_SECONDS * 1000 + g.RESULT_SECONDS * 1000;
    expect(g.tick(room, t1)).toBe(true);
    expect(room.answererId).toBe('p1');

    // 질문 시간이 다 되면 출제자 2점
    g.setSecret(room, 'p1', '단어', '동물', t1);
    expect(g.tick(room, t1 + g.ROUND_SECONDS * 1000)).toBe(true);
    expect(room.lastResult.reason).toBe('timeout');
    expect(g.findPlayer(room, 'p1').score).toBe(2);
  });

  it('게임이 끝나면 방장이 같은 사람들과 다시 시작할 수 있다', () => {
    const room = roomWith(2);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
    g.submitGuess(room, 'p1', '고양이', T0);
    g.endGame(room);
    expect(g.restart(room, 'p1').ok).toBe(false);
    expect(g.restart(room, 'p0').ok).toBe(true);
    expect(room.phase).toBe('lobby');
    expect(room.players.every((p) => p.score === 0)).toBe(true);
  });
});

describe('첫 출제자 지정', () => {
  it('지정하지 않으면 입장 순서대로 출제한다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    expect(room.roster).toEqual(['p0', 'p1', 'p2']);
    expect(room.answererId).toBe('p0');
  });

  it('지정한 사람이 첫 출제자가 되고, 나머지는 입장 순서를 이어 돈다', () => {
    const room = roomWith(4);
    expect(g.pickFirstAnswerer(room, 'p0', 'p2').ok).toBe(true);
    g.startGame(room, 'p0', T0);
    expect(room.roster).toEqual(['p2', 'p3', 'p0', 'p1']);
    expect(room.answererId).toBe('p2');
  });

  it('방장만, 대기실에서만, 방에 있는 사람만 지정할 수 있다', () => {
    const room = roomWith(3);
    expect(g.pickFirstAnswerer(room, 'p1', 'p2').ok).toBe(false);
    expect(g.pickFirstAnswerer(room, 'p0', '없는사람').ok).toBe(false);
    expect(room.firstAnswererId).toBeNull();

    g.startGame(room, 'p0', T0);
    expect(g.pickFirstAnswerer(room, 'p0', 'p1').ok).toBe(false);
  });

  it('null을 주면 입장 순서대로 되돌린다', () => {
    const room = roomWith(3);
    g.pickFirstAnswerer(room, 'p0', 'p2');
    expect(g.pickFirstAnswerer(room, 'p0', null).ok).toBe(true);
    expect(room.firstAnswererId).toBeNull();
  });

  it('지정된 사람이 대기실에서 나가면 지정이 풀린다', () => {
    const room = roomWith(3);
    g.pickFirstAnswerer(room, 'p0', 'p2');
    g.disconnect(room, 'p2', T0);
    expect(room.firstAnswererId).toBeNull();
    g.startGame(room, 'p0', T0);
    expect(room.answererId).toBe('p0');
  });

  it('다시 시작할 때 그 사람이 남아 있으면 지정이 유지된다', () => {
    const room = roomWith(3);
    g.pickFirstAnswerer(room, 'p0', 'p1');
    g.startGame(room, 'p0', T0);
    g.endGame(room);
    g.restart(room, 'p0');
    expect(room.firstAnswererId).toBe('p1');

    // 그 사람이 게임 중 끊긴 채 끝났다면 restart가 좌석을 치우면서 지정도 푼다
    g.startGame(room, 'p0', T0);
    g.disconnect(room, 'p1', T0);
    g.endGame(room);
    g.restart(room, 'p0');
    expect(room.firstAnswererId).toBeNull();
  });

  it('플레이어 화면에 지정 결과가 담긴다', () => {
    const room = roomWith(2);
    g.pickFirstAnswerer(room, 'p0', 'p1');
    expect(g.viewFor(room, 'p1').firstAnswererId).toBe('p1');
  });
});

describe('접속이 끊길 때', () => {
  it('대기실에서 나가면 자리가 비고 방장이 넘어간다', () => {
    const room = roomWith(3);
    g.disconnect(room, 'p0', T0);
    expect(room.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(room.hostId).toBe('p1');
  });

  it('게임 중에는 자리를 남겨 두고, 같은 토큰으로 돌아올 수 있다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
    g.disconnect(room, 'p1', T0);
    expect(g.findPlayer(room, 'p1').connected).toBe(false);
    expect(room.phase).toBe('asking'); // 추측자 한 명이 빠져도 계속된다

    expect(g.reconnect(room, 'p1').ok).toBe(true);
    expect(g.findPlayer(room, 'p1').connected).toBe(true);
    expect(g.reconnect(room, '없는사람').ok).toBe(false);
  });

  it('출제자가 나가면 그 라운드는 무효가 된다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
    g.disconnect(room, 'p0', T0);
    expect(room.phase).toBe('roundEnd');
    expect(room.lastResult.reason).toBe('answererLeft');
    expect(g.findPlayer(room, 'p0').score).toBe(0);
  });

  it('남은 인원이 2명 미만이면 게임이 끝난다', () => {
    const room = roomWith(2);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
    g.disconnect(room, 'p1', T0);
    expect(room.phase).toBe('gameEnd');
  });

  it('끊긴 사람은 출제 차례에서 건너뛴다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.disconnect(room, 'p1', T0);
    g.endRound(room, 'timeout', T0);
    g.nextRound(room, 'p0', T0);
    expect(room.answererId).toBe('p2');
  });
});

describe('normalize', () => {
  it.each([
    ['고양이', ' 고양이 ', true],
    ['Hot Dog', 'hotdog', true],
    ['에스프레소', '에스프레소!', true],
    ['고양이', '강아지', false],
  ])('%s vs %s → %s', (a, b, same) => {
    expect(g.normalize(a) === g.normalize(b)).toBe(same);
  });
});

describe('고정 방 목록', () => {
  it('요약에 인원과 입장 가능 여부가 담긴다', () => {
    const room = g.createRoom('1');
    expect(g.summary(room)).toMatchObject({ code: '1', name: '1번 방', players: 0, capacity: 8, joinable: true });

    for (let i = 0; i < 8; i += 1) g.joinRoom(room, { id: `p${i}`, name: `P${i}` });
    expect(g.summary(room)).toMatchObject({ players: 8, joinable: false }); // 정원 초과

    g.startGame(room, 'p0', T0);
    expect(g.summary(room)).toMatchObject({ phase: 'secret', joinable: false }); // 게임 중
  });

  it('끊긴 사람은 목록의 인원수에서 빠진다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.disconnect(room, 'p2', T0);
    expect(g.summary(room).players).toBe(2);
  });

  it('초기화하면 이름과 번호는 유지한 채 빈 대기실이 된다', () => {
    const room = roomWith(3);
    g.startGame(room, 'p0', T0);
    g.setSecret(room, 'p0', '고양이', '동물', T0);
    g.resetRoom(room, T0);

    expect(g.summary(room)).toMatchObject({ code: 'TEST', players: 0, phase: 'lobby', joinable: true });
    expect(room.players).toHaveLength(0);
    expect(room.hostId).toBeNull();
    expect(room.secret).toBeNull();
    expect(g.viewFor(room, 'p0').secret).toBeNull(); // 이전 라운드 정답이 남아 있지 않다
  });
});
