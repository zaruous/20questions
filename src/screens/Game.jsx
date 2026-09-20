import React, { useEffect, useRef, useState } from 'react';

const VERDICT_LABEL = { yes: '예', no: '아니오', unclear: '애매함' };
const RESULT_TEXT = {
  solved: (name) => `🎉 ${name}님이 정답을 맞혔습니다!`,
  outOfQuestions: () => '질문 20개를 모두 썼습니다. 아무도 맞히지 못했어요.',
  timeout: () => '시간이 다 되었습니다.',
  noSecret: () => '출제자가 단어를 정하지 못해 이 라운드는 무효입니다.',
  answererLeft: () => '출제자가 나가서 이 라운드는 무효입니다.',
};

/** 서버 기준 남은 시간(초). 서버가 알려준 시각으로 내 시계 오차를 보정한다. */
function useCountdown(deadline, serverNow) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!deadline) {
      setLeft(0);
      return undefined;
    }
    const update = () => setLeft(Math.max(0, Math.ceil((deadline - serverNow()) / 1000)));
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [deadline, serverNow]);
  return left;
}

const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

/** 이름으로 색을 정한다. 서버를 거치지 않아도 모든 사람의 화면에서 같은 사람이 같은 색으로 보인다. */
function hueOf(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function Avatar({ name, size }) {
  return (
    <span className={`avatar${size ? ` avatar--${size}` : ''}`} style={{ '--h': hueOf(name) }} aria-hidden="true">
      {[...name][0]}
    </span>
  );
}

/** 지정한 사람부터 시작하도록 입장 순서를 돌린 결과. 서버 startGame과 같은 규칙(표시용). */
function turnOrder(players, firstId) {
  const at = players.findIndex((p) => p.id === firstId);
  return at > 0 ? [...players.slice(at), ...players.slice(0, at)] : players;
}

/** 지금 무슨 상황인지 한 줄로. 내가 움직여야 할 때는 mine=true. */
function situation(state, nameOf, isAnswerer, pending) {
  const who = nameOf(state.answererId);
  switch (state.phase) {
    case 'secret':
      return isAnswerer
        ? { text: '🎩 당신이 출제자예요. 맞힐 단어를 정해 주세요', mine: true }
        : { text: `🎩 ${who}님이 단어를 고르는 중…`, mine: false };
    case 'asking':
      if (isAnswerer) {
        return pending
          ? { text: `${nameOf(pending.by)}님의 질문에 답해 주세요`, mine: true }
          : { text: '🎩 질문을 기다리는 중…', mine: false };
      }
      return pending ? { text: `${who}님이 답변하는 중…`, mine: false } : { text: '지금 질문할 수 있어요', mine: true };
    case 'roundEnd':
      return { text: '라운드 종료', mine: false };
    default:
      return { text: '게임 종료', mine: false };
  }
}

export default function Game({ state, send, leaveRoom, serverNow }) {
  const left = useCountdown(state.deadline, serverNow);
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '???';
  const isHost = state.you === state.hostId;
  const isAnswerer = state.you === state.answererId;
  const inLobby = state.phase === 'lobby';
  const pending = state.questions.find((q) => q.id === state.pendingId) ?? null;
  const now = inLobby ? null : situation(state, nameOf, isAnswerer, pending);

  return (
    <main className="game">
      <header className="game__header">
        {/* 대기실은 본문에 방 이름을 크게 띄우므로 헤더에서는 뺀다 */}
        {!inLobby && (
          <>
            <span className="room-chip">{state.name}</span>
            <span className="round-chip">
              라운드 {state.round}/{state.totalRounds}
            </span>
          </>
        )}
        <span className="spacer" />
        {state.deadline && (
          <span className={`timer${left <= 10 ? ' is-urgent' : ''}`} aria-label={`남은 시간 ${left}초`}>
            {mmss(left)}
          </span>
        )}
        <button className="btn btn--ghost btn--sm" onClick={leaveRoom}>
          나가기
        </button>
      </header>

      {inLobby ? (
        <Lobby state={state} isHost={isHost} send={send} />
      ) : (
        <div className="game__body">
          <Players state={state} />

          <section className="main">
            {(state.phase === 'asking' || state.phase === 'roundEnd') && (
              <Budget used={state.used} max={state.maxQuestions} />
            )}
            {state.category && (
              <p className="topic-badge">
                주제 <b>{state.category}</b>
              </p>
            )}
            <p className={`status${now.mine ? ' is-mine' : ''}`} aria-live="polite">
              {now.text}
            </p>

            <div className="feed-wrap">
              <Feed state={state} nameOf={nameOf} isAnswerer={isAnswerer} />
            </div>

            <footer className="actions">
              {state.phase === 'secret' &&
                (isAnswerer ? (
                  <SecretForm
                    send={send}
                    max={state.limits.secretMax}
                    choices={state.categoryChoices}
                    categoryMax={state.limits.categoryMax}
                  />
                ) : (
                  <p className="hint actions__wait">단어가 정해지면 바로 질문할 수 있어요.</p>
                ))}

              {state.phase === 'asking' &&
                (isAnswerer ? (
                  <AnswerPanel pending={pending} nameOf={nameOf} secret={state.secret} send={send} />
                ) : (
                  <GuesserPanel pending={pending} nameOf={nameOf} send={send} max={state.limits.textMax} />
                ))}

              {state.phase === 'roundEnd' && (
                <div className="result">
                  <p className="result__headline">{RESULT_TEXT[state.lastResult.reason](nameOf(state.lastResult.winnerId))}</p>
                  <p className="result__secret">
                    정답은 <b>{state.secret ?? '—'}</b>
                  </p>
                  <p className="hint">{left}초 뒤 다음 라운드로 넘어갑니다.</p>
                  {isHost && (
                    <button className="btn btn--primary" onClick={() => send({ type: 'next' })}>
                      바로 다음 라운드
                    </button>
                  )}
                </div>
              )}

              {state.phase === 'gameEnd' && (
                <div className="result">
                  <p className="result__headline">게임 종료!</p>
                  <p className="result__secret">
                    우승 <b>🏆 {[...state.players].sort((a, b) => b.score - a.score)[0]?.name}</b>
                  </p>
                  {isHost ? (
                    <button className="btn btn--primary" onClick={() => send({ type: 'restart' })}>
                      같은 사람들과 다시 하기
                    </button>
                  ) : (
                    <p className="hint">방장이 다시 시작하기를 기다리는 중…</p>
                  )}
                </div>
              )}
            </footer>
          </section>
        </div>
      )}
    </main>
  );
}

/** 참가자 칩. 폰에서는 가로로 넘기는 한 줄, 넓은 화면에서는 왼쪽 세로 목록. */
function Players({ state }) {
  // 출제자를 맨 앞에: 폰에서는 한 줄이 잘려도 지금 누가 내는지는 보여야 한다. 그 다음은 점수순.
  const rank = (p) => (p.id === state.answererId ? -1 : 0);
  const sorted = [...state.players].sort((a, b) => rank(a) - rank(b) || b.score - a.score);
  return (
    <ul className="players" aria-label="참가자">
      {sorted.map((p) => (
        <li
          key={p.id}
          className={`player${p.id === state.answererId ? ' is-answerer' : ''}${p.connected ? '' : ' is-offline'}`}
        >
          <Avatar name={p.name} />
          <span className="player__name">
            {p.id === state.answererId && <span aria-label="출제자">🎩 </span>}
            {p.name}
            {p.id === state.you && <em>나</em>}
          </span>
          {p.id === state.hostId && <span className="tag">방장</span>}
          {!p.connected && <span className="tag tag--off">끊김</span>}
          <b className="player__score">{p.score}</b>
        </li>
      ))}
    </ul>
  );
}

/** 질문 20칸. 쓸수록 칸이 꺼진다 — 스무고개의 핵심 자원을 한눈에. */
function Budget({ used, max }) {
  return (
    <div className="budget" role="img" aria-label={`질문 ${max - used}개 남음`}>
      <div className="budget__track">
        {Array.from({ length: max }, (_, i) => (
          <i key={i} className={i < used ? 'is-used' : ''} />
        ))}
      </div>
      <b>{max - used}</b>
      <span>남은 질문</span>
    </div>
  );
}

function Lobby({ state, isHost, send }) {
  const players = state.players.filter((p) => p.connected);
  const picked = players.find((p) => p.id === state.firstAnswererId) ?? null;
  const order = turnOrder(players, picked?.id);
  const firstId = order[0]?.id; // 지정이 없으면 입장 순서 첫 사람
  const pick = (playerId) => send({ type: 'pickFirst', playerId });
  const canStart = players.length >= state.limits.minPlayers;

  const card = (p) => (
    <>
      <Avatar name={p.name} size="lg" />
      <span className="roster__name">
        {p.name}
        {p.id === state.you && <em>나</em>}
      </span>
      {p.id === state.hostId && <span className="tag">방장</span>}
      <span className="roster__hat" aria-hidden="true">
        🎩
      </span>
    </>
  );

  return (
    <div className="lobby">
      <div className="lobby__top">
        <p className="lobby__eyebrow">친구에게 알려주세요</p>
        <h1 className="lobby__room">{state.name}</h1>
        <p className="hint">
          {players.length}명 참가 중 · {state.limits.minPlayers}명부터 시작 (최대 {state.limits.maxPlayers}명)
        </p>
      </div>

      <section className="roster" aria-label="참가자와 첫 출제자">
        <div className="roster__head">
          <h2>🎩 첫 출제자{isHost ? ' · 탭해서 고르기' : ''}</h2>
          {isHost && picked && (
            <button className="btn btn--ghost btn--sm" onClick={() => pick(null)}>
              입장 순서대로
            </button>
          )}
        </div>
        <ul className="roster__list">
          {players.map((p) =>
            isHost ? (
              <li key={p.id}>
                <label className={`roster__card${p.id === firstId ? ' is-first' : ''}`}>
                  <input
                    className="roster__radio"
                    type="radio"
                    name="firstAnswerer"
                    checked={picked?.id === p.id}
                    onChange={() => pick(p.id)}
                  />
                  {card(p)}
                </label>
              </li>
            ) : (
              <li key={p.id} className={`roster__card${p.id === firstId ? ' is-first' : ''}`}>
                {card(p)}
              </li>
            ),
          )}
        </ul>
        {players.length >= 2 && (
          <p className="hint roster__order">
            {picked ? '' : '입장 순서대로 · '}
            {order.map((p) => p.name).join(' → ')}
          </p>
        )}
      </section>

      <div className="lobby__cta">
        {isHost ? (
          <button className="btn btn--primary btn--big" disabled={!canStart} onClick={() => send({ type: 'start' })}>
            {canStart ? '게임 시작' : `${state.limits.minPlayers - players.length}명 더 기다리는 중…`}
          </button>
        ) : (
          <p className="hint">방장이 시작하기를 기다리는 중…</p>
        )}
      </div>
    </div>
  );
}

function Feed({ state, nameOf, isAnswerer }) {
  const endRef = useRef(null);
  const items = [
    ...state.questions.map((q) => ({ kind: 'q', at: q.at, ...q })),
    ...state.guesses.map((g, i) => ({ kind: 'g', at: g.at, id: `g${i}`, ...g })),
  ].sort((a, b) => a.at - b.at);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, state.pendingId]);

  let qNo = 0;
  return (
    <ol className="feed">
      {items.length === 0 && (
        <li className="feed__empty">
          {state.phase === 'secret'
            ? '단어가 정해지면 여기에 질문이 쌓입니다.'
            : isAnswerer
              ? '아직 질문이 없어요. 곧 올 거예요…'
              : '아직 질문이 없어요. 첫 질문을 던져보세요!'}
        </li>
      )}
      {items.map((item) => {
        if (item.kind === 'q') qNo += 1;
        const who = nameOf(item.by);
        return item.kind === 'q' ? (
          <li key={item.id} className={`msg${item.verdict ? '' : ' is-pending'}`}>
            <Avatar name={who} size="sm" />
            <div className="msg__body">
              <span className="msg__meta">
                <b>{who}</b>
                <span>Q{qNo}</span>
              </span>
              <p className="msg__text">{item.text}</p>
            </div>
            <span className={`pill pill--${item.verdict ?? 'wait'}`}>
              {item.verdict ? VERDICT_LABEL[item.verdict] : '답변 대기'}
            </span>
          </li>
        ) : (
          <li key={item.id} className={`msg msg--guess ${item.correct ? 'is-correct' : 'is-wrong'}`}>
            <Avatar name={who} size="sm" />
            <div className="msg__body">
              <span className="msg__meta">
                <b>{who}</b>
                <span>정답 시도</span>
              </span>
              <p className="msg__text">“{item.text}”</p>
            </div>
            <span className={`pill ${item.correct ? 'pill--yes' : 'pill--no'}`}>{item.correct ? '정답!' : '오답'}</span>
          </li>
        );
      })}
      <li ref={endRef} aria-hidden="true" />
    </ol>
  );
}

function SecretForm({ send, max, choices, categoryMax }) {
  const [text, setText] = useState('');
  const [picked, setPicked] = useState(choices[0] ?? '');
  const [custom, setCustom] = useState('');
  const category = custom.trim() || picked; // 직접 입력한 주제가 있으면 그쪽이 우선

  return (
    <form
      className="secret-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && category) send({ type: 'secret', text, category });
      }}
    >
      <fieldset className="topics">
        <legend className="topics__label">주제 고르기 · 추측자에게도 보여요</legend>
        <div className="topics__chips">
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip${category === c ? ' is-on' : ''}`}
              aria-pressed={category === c}
              onClick={() => {
                setPicked(c);
                setCustom('');
              }}
            >
              {c}
            </button>
          ))}
          <input
            className="chip chip--input"
            aria-label="주제 직접 입력"
            value={custom}
            maxLength={categoryMax}
            placeholder="직접 입력"
            autoComplete="off"
            onChange={(e) => setCustom(e.target.value)}
          />
        </div>
      </fieldset>

      <div className="action-form">
        <input
          className="input"
          aria-label="맞힐 단어"
          value={text}
          maxLength={max}
          placeholder="맞힐 단어… 예: 고양이"
          autoComplete="off"
          enterKeyHint="done"
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={!text.trim() || !category}>
          확정
        </button>
      </div>
    </form>
  );
}

function AnswerPanel({ pending, nameOf, secret, send }) {
  return (
    <div className="answer-panel">
      <p className="answer-panel__secret">
        내 단어 <b>{secret}</b>
      </p>
      {pending ? (
        <>
          <p className="answer-panel__q">
            <b>{nameOf(pending.by)}</b> {pending.text}
          </p>
          <div className="answer-panel__buttons">
            <button className="btn btn--yes" onClick={() => send({ type: 'answer', verdict: 'yes' })}>
              예
            </button>
            <button className="btn btn--no" onClick={() => send({ type: 'answer', verdict: 'no' })}>
              아니오
            </button>
            <button className="btn btn--unclear" onClick={() => send({ type: 'answer', verdict: 'unclear' })}>
              애매함
            </button>
          </div>
        </>
      ) : (
        <p className="hint actions__wait">질문이 올라오면 여기서 바로 답할 수 있어요.</p>
      )}
    </div>
  );
}

function GuesserPanel({ pending, nameOf, send, max }) {
  const [question, setQuestion] = useState('');
  const [guess, setGuess] = useState('');

  return (
    <div className="guesser-panel">
      <form
        className="action-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (question.trim()) {
            send({ type: 'ask', text: question });
            setQuestion('');
          }
        }}
      >
        <input
          className="input"
          aria-label="질문"
          value={question}
          maxLength={max}
          disabled={Boolean(pending)}
          placeholder={pending ? `${nameOf(pending.by)}님 질문에 답변 대기 중…` : '예/아니오로 답할 수 있는 질문…'}
          autoComplete="off"
          enterKeyHint="send"
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button className="btn btn--secondary" type="submit" disabled={Boolean(pending) || !question.trim()}>
          질문
        </button>
      </form>

      <form
        className="action-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (guess.trim()) {
            send({ type: 'guess', text: guess });
            setGuess('');
          }
        }}
      >
        <input
          className="input"
          aria-label="정답"
          value={guess}
          maxLength={max}
          placeholder="정답 외치기… (틀리면 질문 -1)"
          autoComplete="off"
          enterKeyHint="send"
          onChange={(e) => setGuess(e.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={!guess.trim()}>
          정답!
        </button>
      </form>
    </div>
  );
}
