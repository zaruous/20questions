// 20고개 게임의 순수 로직.
// - I/O, 타이머, 소켓을 전혀 모른다. 시간은 항상 인자로 주입받는다(now).
// - 모든 상태는 서버가 소유하고, viewFor()가 플레이어별로 볼 수 있는 것만 골라서 내보낸다.
//   (정답 단어가 추측자 화면으로 새지 않게 하는 유일한 관문)

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_QUESTIONS = 20;
export const SECRET_SECONDS = 60; // 출제자가 단어를 고르는 제한 시간
export const ROUND_SECONDS = 300; // 질문 단계 제한 시간
export const RESULT_SECONDS = 15; // 결과 화면에서 다음 라운드까지
export const NAME_MAX = 12;
export const SECRET_MAX = 40;
export const TEXT_MAX = 200;

const ok = (extra = {}) => ({ ok: true, ...extra });
const err = (message) => ({ ok: false, error: message });

/** 비교용 정규화: 공백/문장부호/대소문자 무시 */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s·・\-_.,!?~'"()[\]]/g, '');
}

export function createRoom(code, now = Date.now()) {
  return {
    code,
    createdAt: now,
    phase: 'lobby', // lobby | secret | asking | roundEnd | gameEnd
    hostId: null,
    players: [], // { id, name, score, connected }
    roster: [], // 게임 시작 시 확정된 출제 순서(플레이어 id)
    roundIndex: -1,
    answererId: null,
    secret: null,
    questions: [], // { id, by, text, verdict: 'yes'|'no'|'unclear'|null }
    guesses: [], // { by, text, correct }
    pendingId: null, // 판정 대기 중인 질문 id (동시에 1개만)
    deadline: null,
    lastResult: null, // { reason, secret, winnerId }
  };
}

export const findPlayer = (room, id) => room.players.find((p) => p.id === id) ?? null;
export const connectedPlayers = (room) => room.players.filter((p) => p.connected);

/** 이번 라운드에서 소진한 질문 수 (답변된 질문 + 틀린 추측) */
export function usedQuestions(room) {
  return (
    room.questions.filter((q) => q.verdict !== null).length +
    room.guesses.filter((g) => !g.correct).length
  );
}

export const remainingQuestions = (room) => Math.max(0, MAX_QUESTIONS - usedQuestions(room));

export function joinRoom(room, { id, name }, now = Date.now()) {
  if (room.phase !== 'lobby') return err('이미 게임이 진행 중인 방입니다.');
  if (room.players.length >= MAX_PLAYERS) return err(`방이 가득 찼습니다 (최대 ${MAX_PLAYERS}명).`);
  const clean = String(name ?? '').trim();
  if (!clean) return err('닉네임을 입력하세요.');
  if (clean.length > NAME_MAX) return err(`닉네임은 ${NAME_MAX}자 이하로 입력하세요.`);
  if (room.players.some((p) => p.name === clean)) return err('이미 사용 중인 닉네임입니다.');

  room.players.push({ id, name: clean, score: 0, connected: true, joinedAt: now });
  if (!room.hostId) room.hostId = id;
  return ok({ player: findPlayer(room, id) });
}

/** 같은 토큰(=playerId)으로 돌아온 플레이어 복구 */
export function reconnect(room, id) {
  const player = findPlayer(room, id);
  if (!player) return err('방에서 찾을 수 없는 플레이어입니다.');
  player.connected = true;
  if (!room.hostId || !findPlayer(room, room.hostId)?.connected) room.hostId = id;
  return ok({ player });
}

export function disconnect(room, id, now = Date.now()) {
  const player = findPlayer(room, id);
  if (!player) return ok();

  if (room.phase === 'lobby') {
    // 대기실에서는 자리를 잡아둘 이유가 없다.
    room.players = room.players.filter((p) => p.id !== id);
    room.roster = room.roster.filter((pid) => pid !== id);
  } else {
    player.connected = false;
  }

  if (room.hostId === id) {
    room.hostId = connectedPlayers(room)[0]?.id ?? null;
  }

  // 출제자가 나가면 그 라운드는 성립하지 않는다.
  if (room.answererId === id && (room.phase === 'secret' || room.phase === 'asking')) {
    endRound(room, 'answererLeft', now);
  }
  // 남은 인원이 부족하면 게임을 끝낸다(대기실로 돌아갈 수 있게).
  if (room.phase !== 'lobby' && room.phase !== 'gameEnd' && connectedPlayers(room).length < MIN_PLAYERS) {
    endGame(room);
  }
  return ok();
}

export function startGame(room, byId, now = Date.now()) {
  if (room.phase !== 'lobby') return err('대기실에서만 시작할 수 있습니다.');
  if (byId !== room.hostId) return err('방장만 게임을 시작할 수 있습니다.');
  const players = connectedPlayers(room);
  if (players.length < MIN_PLAYERS) return err(`${MIN_PLAYERS}명 이상 모여야 시작할 수 있습니다.`);

  room.roster = players.map((p) => p.id);
  room.players.forEach((p) => {
    p.score = 0;
  });
  room.roundIndex = -1;
  startRound(room, now);
  return ok();
}

/** 다음 출제자를 찾아 라운드 시작. 남은 출제자가 없으면 게임 종료. */
export function startRound(room, now = Date.now()) {
  let next = room.roundIndex + 1;
  while (next < room.roster.length && !findPlayer(room, room.roster[next])?.connected) next += 1;

  if (next >= room.roster.length) {
    room.roundIndex = room.roster.length;
    endGame(room);
    return ok({ ended: true });
  }

  room.roundIndex = next;
  room.answererId = room.roster[next];
  room.secret = null;
  room.questions = [];
  room.guesses = [];
  room.pendingId = null;
  room.lastResult = null;
  room.phase = 'secret';
  room.deadline = now + SECRET_SECONDS * 1000;
  return ok();
}

export function setSecret(room, playerId, text, now = Date.now()) {
  if (room.phase !== 'secret') return err('지금은 단어를 정할 수 없습니다.');
  if (playerId !== room.answererId) return err('출제자만 단어를 정할 수 있습니다.');
  const clean = String(text ?? '').trim();
  if (!clean) return err('단어를 입력하세요.');
  if (clean.length > SECRET_MAX) return err(`단어는 ${SECRET_MAX}자 이하로 입력하세요.`);

  room.secret = clean;
  room.phase = 'asking';
  room.deadline = now + ROUND_SECONDS * 1000;
  return ok();
}

export function askQuestion(room, playerId, text, now = Date.now()) {
  if (room.phase !== 'asking') return err('지금은 질문할 수 없습니다.');
  if (playerId === room.answererId) return err('출제자는 질문할 수 없습니다.');
  if (room.pendingId) return err('아직 답변되지 않은 질문이 있습니다.');
  const clean = String(text ?? '').trim();
  if (!clean) return err('질문을 입력하세요.');
  if (clean.length > TEXT_MAX) return err(`질문은 ${TEXT_MAX}자 이하로 입력하세요.`);

  const question = { id: `q${room.questions.length + 1}`, by: playerId, text: clean, verdict: null, at: now };
  room.questions.push(question);
  room.pendingId = question.id;
  return ok({ question });
}

export function answerQuestion(room, playerId, verdict, now = Date.now()) {
  if (room.phase !== 'asking') return err('지금은 답변할 수 없습니다.');
  if (playerId !== room.answererId) return err('출제자만 답변할 수 있습니다.');
  if (!room.pendingId) return err('답변할 질문이 없습니다.');
  if (!['yes', 'no', 'unclear'].includes(verdict)) return err('올바르지 않은 답변입니다.');

  const question = room.questions.find((q) => q.id === room.pendingId);
  question.verdict = verdict;
  room.pendingId = null;

  if (remainingQuestions(room) <= 0) endRound(room, 'outOfQuestions', now);
  return ok();
}

export function submitGuess(room, playerId, text, now = Date.now()) {
  if (room.phase !== 'asking') return err('지금은 정답을 말할 수 없습니다.');
  if (playerId === room.answererId) return err('출제자는 정답을 맞힐 수 없습니다.');
  const clean = String(text ?? '').trim();
  if (!clean) return err('정답을 입력하세요.');
  if (clean.length > TEXT_MAX) return err(`정답은 ${TEXT_MAX}자 이하로 입력하세요.`);

  const correct = normalize(clean) === normalize(room.secret);
  room.guesses.push({ by: playerId, text: clean, correct, at: now });

  if (correct) {
    findPlayer(room, playerId).score += 3;
    const answerer = findPlayer(room, room.answererId);
    if (answerer) answerer.score += 1; // 맞힐 수 있는 단어를 낸 보상
    endRound(room, 'solved', now, playerId);
  } else if (remainingQuestions(room) <= 0) {
    endRound(room, 'outOfQuestions', now);
  }
  return ok({ correct });
}

export function endRound(room, reason, now = Date.now(), winnerId = null) {
  if (reason === 'outOfQuestions' || reason === 'timeout') {
    const answerer = findPlayer(room, room.answererId);
    if (answerer) answerer.score += 2; // 아무도 못 맞힘
  }
  room.lastResult = { reason, secret: room.secret, winnerId, answererId: room.answererId };
  room.pendingId = null;
  room.phase = 'roundEnd';
  room.deadline = now + RESULT_SECONDS * 1000;
  return ok();
}

export function nextRound(room, byId, now = Date.now()) {
  if (room.phase !== 'roundEnd') return err('지금은 넘어갈 수 없습니다.');
  if (byId && byId !== room.hostId) return err('방장만 다음 라운드로 넘길 수 있습니다.');
  return startRound(room, now);
}

export function endGame(room) {
  room.phase = 'gameEnd';
  room.pendingId = null;
  room.deadline = null;
  return ok();
}

export function restart(room, byId) {
  if (room.phase !== 'gameEnd') return err('게임이 끝난 뒤에만 다시 시작할 수 있습니다.');
  if (byId !== room.hostId) return err('방장만 다시 시작할 수 있습니다.');
  room.phase = 'lobby';
  room.roster = [];
  room.roundIndex = -1;
  room.answererId = null;
  room.secret = null;
  room.questions = [];
  room.guesses = [];
  room.pendingId = null;
  room.deadline = null;
  room.lastResult = null;
  room.players.forEach((p) => {
    p.score = 0;
  });
  // 끊긴 채 남아 있던 좌석 정리
  room.players = room.players.filter((p) => p.connected);
  if (!findPlayer(room, room.hostId)) room.hostId = room.players[0]?.id ?? null;
  return ok();
}

/** 제한 시간 처리. 상태가 바뀌었으면 true. */
export function tick(room, now = Date.now()) {
  if (!room.deadline || now < room.deadline) return false;
  if (room.phase === 'secret') {
    endRound(room, 'noSecret', now);
    return true;
  }
  if (room.phase === 'asking') {
    endRound(room, 'timeout', now);
    return true;
  }
  if (room.phase === 'roundEnd') {
    startRound(room, now);
    return true;
  }
  return false;
}

/**
 * 플레이어별 화면 상태. 화이트리스트 방식으로만 만든다.
 * 정답 단어는 출제자 본인과 라운드/게임 종료 이후에만 포함된다.
 */
export function viewFor(room, playerId) {
  const revealed = room.phase === 'roundEnd' || room.phase === 'gameEnd';
  const isAnswerer = playerId === room.answererId;
  return {
    code: room.code,
    phase: room.phase,
    you: playerId,
    hostId: room.hostId,
    answererId: room.answererId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
    })),
    round: room.roundIndex + 1,
    totalRounds: room.roster.length,
    maxQuestions: MAX_QUESTIONS,
    used: usedQuestions(room),
    remaining: remainingQuestions(room),
    questions: room.questions.map((q) => ({ id: q.id, by: q.by, text: q.text, verdict: q.verdict, at: q.at })),
    guesses: room.guesses.map((g) => ({ by: g.by, text: g.text, correct: g.correct, at: g.at })),
    pendingId: room.pendingId,
    deadline: room.deadline,
    secret: isAnswerer || revealed ? room.secret : null,
    lastResult: revealed ? room.lastResult : null,
    limits: { minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, nameMax: NAME_MAX, secretMax: SECRET_MAX, textMax: TEXT_MAX },
  };
}
