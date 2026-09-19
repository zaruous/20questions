import React, { useState } from 'react';

export default function Home({ status, createRoom, joinRoom }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
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

        <button className="btn btn--primary" disabled={!ready} onClick={() => createRoom(name)}>
          새 방 만들기
        </button>

        <div className="divider">또는</div>

        <form
          className="join-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && code.trim()) joinRoom(code, name);
          }}
        >
          <input
            className="join-row__code"
            value={code}
            maxLength={4}
            placeholder="방 코드"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button className="btn" type="submit" disabled={!ready || !code.trim()}>
            참가하기
          </button>
        </form>
      </div>

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
