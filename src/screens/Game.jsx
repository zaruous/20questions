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

export default function Game({ state, send, leaveRoom, serverNow }) {
  const left = useCountdown(state.deadline, serverNow);
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? '???';
  const isHost = state.you === state.hostId;
  const isAnswerer = state.you === state.answererId;
  const pending = state.questions.find((q) => q.id === state.pendingId) ?? null;

  return (
    <main className="game">
      <header className="game__header">
        <span className="code">{state.name}</span>
        {state.phase !== 'lobby' && (
          <div className="meta">
            <span>
              라운드 {state.round}/{state.totalRounds}
            </span>
            <span>
              질문 <b>{state.remaining}</b>/{state.maxQuestions}
            </span>
            {state.deadline && <span className={left <= 10 ? 'urgent' : ''}>{mmss(left)}</span>}
          </div>
        )}
        <button className="btn btn--ghost" onClick={leaveRoom}>
          나가기
        </button>
      </header>

      <div className="game__body">
        <aside className="players">
          <h2>
            참가자 {state.players.length}/{state.limits.maxPlayers}
          </h2>
          <ul>
            {[...state.players]
              .sort((a, b) => b.score - a.score)
              .map((p) => (
                <li key={p.id} className={p.connected ? '' : 'is-offline'}>
                  <span className="players__name">
                    {p.id === state.answererId && <span title="출제자">🎩</span>}
                    {p.name}
                    {p.id === state.you && <em> (나)</em>}
                    {p.id === state.hostId && <span className="tag">방장</span>}
                    {!p.connected && <span className="tag tag--off">끊김</span>}
                  </span>
                  <b>{p.score}</b>
                </li>
              ))}
          </ul>
        </aside>

        <section className="main-panel">
          {state.phase === 'lobby' ? (
            <Lobby state={state} isHost={isHost} send={send} />
          ) : (
            <Feed state={state} nameOf={nameOf} />
          )}
        </section>
      </div>

      <footer className="actions" hidden={state.phase === 'lobby'}>
        {state.phase === 'secret' &&
          (isAnswerer ? (
            <SecretForm send={send} max={state.limits.secretMax} />
          ) : (
            <p className="hint">🎩 {nameOf(state.answererId)}님이 단어를 고르는 중입니다…</p>
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
              정답은 <b>{state.secret ?? '—'}</b> 였습니다.
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
            <p className="result__headline">게임 종료! 🏆 {[...state.players].sort((a, b) => b.score - a.score)[0]?.name}님 우승</p>
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
    </main>
  );
}

function Lobby({ state, isHost, send }) {
  const connected = state.players.filter((p) => p.connected).length;
  return (
    <div className="lobby">
      <h2>친구에게 몇 번 방인지 알려주세요</h2>
      <p className="lobby__code">{state.name}</p>
      <p className="hint">
        {connected}명 참가 중 · {state.limits.minPlayers}명부터 시작할 수 있습니다 (최대 {state.limits.maxPlayers}명)
      </p>
      {isHost ? (
        <button
          className="btn btn--primary btn--big"
          disabled={connected < state.limits.minPlayers}
          onClick={() => send({ type: 'start' })}
        >
          게임 시작
        </button>
      ) : (
        <p className="hint">방장이 시작하기를 기다리는 중…</p>
      )}
    </div>
  );
}

function Feed({ state, nameOf }) {
  const endRef = useRef(null);
  const items = [
    ...state.questions.map((q) => ({ kind: 'q', at: q.at, ...q })),
    ...state.guesses.map((g, i) => ({ kind: 'g', at: g.at, id: `g${i}`, ...g })),
  ].sort((a, b) => a.at - b.at);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items.length, state.pendingId]);

  return (
    <ol className="feed">
      {items.length === 0 && <li className="feed__empty">아직 질문이 없습니다. 첫 질문을 던져보세요!</li>}
      {items.map((item, index) =>
        item.kind === 'q' ? (
          <li key={item.id} className={`feed__item ${item.verdict ? '' : 'is-pending'}`}>
            <span className="feed__no">{index + 1}</span>
            <div>
              <b>{nameOf(item.by)}</b> {item.text}
            </div>
            <span className={`verdict verdict--${item.verdict ?? 'wait'}`}>
              {item.verdict ? VERDICT_LABEL[item.verdict] : '답변 대기'}
            </span>
          </li>
        ) : (
          <li key={item.id} className={`feed__item feed__item--guess ${item.correct ? 'is-correct' : 'is-wrong'}`}>
            <span className="feed__no">!</span>
            <div>
              <b>{nameOf(item.by)}</b> 정답 시도: “{item.text}”
            </div>
            <span className="verdict">{item.correct ? '정답' : '오답'}</span>
          </li>
        ),
      )}
      <li ref={endRef} />
    </ol>
  );
}

function SecretForm({ send, max }) {
  const [text, setText] = useState('');
  return (
    <form
      className="action-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) send({ type: 'secret', text });
      }}
    >
      <label className="field field--inline">
        <span>🎩 당신이 출제자입니다. 맞힐 단어를 정하세요</span>
        <input
          value={text}
          maxLength={max}
          placeholder="예: 고양이"
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button className="btn btn--primary" type="submit" disabled={!text.trim()}>
        확정
      </button>
    </form>
  );
}

function AnswerPanel({ pending, nameOf, secret, send }) {
  return (
    <div className="answer-panel">
      <p className="hint">
        내 단어: <b>{secret}</b>
      </p>
      {pending ? (
        <>
          <p className="answer-panel__q">
            <b>{nameOf(pending.by)}</b>: {pending.text}
          </p>
          <div className="answer-panel__buttons">
            <button className="btn btn--yes" onClick={() => send({ type: 'answer', verdict: 'yes' })}>
              예
            </button>
            <button className="btn btn--no" onClick={() => send({ type: 'answer', verdict: 'no' })}>
              아니오
            </button>
            <button className="btn" onClick={() => send({ type: 'answer', verdict: 'unclear' })}>
              애매함
            </button>
          </div>
        </>
      ) : (
        <p className="hint">질문을 기다리는 중…</p>
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
          value={question}
          maxLength={max}
          disabled={Boolean(pending)}
          placeholder={pending ? `${nameOf(pending.by)}님의 질문에 답변을 기다리는 중…` : '예/아니오로 답할 수 있는 질문'}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button className="btn btn--primary" type="submit" disabled={Boolean(pending) || !question.trim()}>
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
          value={guess}
          maxLength={max}
          placeholder="정답을 외쳐보세요 (틀리면 질문 1개 소모)"
          onChange={(e) => setGuess(e.target.value)}
        />
        <button className="btn btn--accent" type="submit" disabled={!guess.trim()}>
          정답!
        </button>
      </form>
    </div>
  );
}
