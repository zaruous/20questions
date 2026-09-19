import React, { useState } from 'react';

function statusText(room) {
  if (room.phase === 'lobby') return room.players === 0 ? '비어 있음' : `${room.players}/${room.capacity}명 대기 중`;
  // 게임 중이지만 접속자가 0명 = 다들 나갔고 곧 대기실로 돌아올 방
  if (room.players === 0) return '정리 중…';
  return `${room.players}명 게임 중`;
}

function buttonText(room) {
  if (room.joinable) return '들어가기';
  if (room.phase === 'lobby') return '가득 참';
  return room.players === 0 ? '정리 중' : '게임 중';
}

export default function Home({ status, rooms, joinRoom }) {
  const [name, setName] = useState('');
  const ready = status === 'online' && name.trim().length > 0;

  return (
    <main className="home">
      <h1 className="home__title">20고개</h1>
      <p className="home__subtitle">2~8명이 함께 하는 실시간 스무고개</p>

      <div className="card">
        <label className="field">
          <span>닉네임</span>
          <input
            value={name}
            maxLength={12}
            placeholder="12자 이내"
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
      </div>

      <section className="rooms">
        <h2>방 고르기</h2>
        {rooms.length === 0 ? (
          <p className="hint">방 목록을 불러오는 중…</p>
        ) : (
          <ul>
            {rooms.map((room) => (
              <li key={room.code} className={room.joinable ? '' : 'is-locked'}>
                <div className="rooms__info">
                  <b>{room.name}</b>
                  <span className="hint">{statusText(room)}</span>
                </div>
                <button
                  className={room.joinable ? 'btn btn--primary' : 'btn'}
                  disabled={!ready || !room.joinable}
                  onClick={() => joinRoom(room.code, name)}
                >
                  {buttonText(room)}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">{name.trim() ? '들어갈 방을 고르세요.' : '닉네임을 먼저 입력하세요.'}</p>
      </section>

      <section className="rules">
        <h2>규칙</h2>
        <ol>
          <li>매 라운드 한 명이 <b>출제자</b>가 되어 단어를 정합니다. 다른 사람에게는 보이지 않습니다.</li>
          <li>나머지는 <b>예 / 아니오</b>로 답할 수 있는 질문을 합니다. 답변을 기다리는 동안에는 다음 질문을 받지 않습니다.</li>
          <li>질문은 라운드당 <b>20개</b>. 정답을 말했다가 틀리면 질문 1개를 소모합니다.</li>
          <li>맞힌 사람 <b>+3점</b>, 출제자는 누군가 맞히면 <b>+1점</b>, 아무도 못 맞히면 <b>+2점</b>.</li>
          <li>모두가 한 번씩 출제하면 게임이 끝납니다.</li>
        </ol>
      </section>
    </main>
  );
}
