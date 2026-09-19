import React from 'react';
import { useGameSocket } from './useGameSocket.js';
import Home from './screens/Home.jsx';
import Game from './screens/Game.jsx';

export default function App() {
  const game = useGameSocket();

  return (
    <div className="app">
      {game.status !== 'online' && (
        <div className="banner banner--warn">
          {game.status === 'offline' ? '연결이 끊겼습니다. 다시 연결하는 중…' : '서버에 연결하는 중…'}
        </div>
      )}
      {game.notice && <div className="banner banner--notice">{game.notice}</div>}
      {game.state ? <Game {...game} /> : <Home {...game} />}
    </div>
  );
}
