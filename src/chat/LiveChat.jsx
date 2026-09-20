import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Avatar from '../components/Avatar.jsx';
import { useChat } from './useChat.js';
import './chat.css';

// 열림 상태는 브라우저에 남긴다. 라운드가 바뀌어도, 새로고침해도 열어둔 채로 돌아온다.
const OPEN_KEY = 'livechat.open';
function loadOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}
function saveOpen(open) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* 저장 못 해도 이번 세션에서는 열려 있다 */
  }
}

const hhmm = (at) => new Date(at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * 라이브채팅: 헤더의 토글 버튼 + 패널. 게임 상태를 모르고 소켓(send/subscribe)과 내 id만 받는다.
 * 패널 자리는 CSS가 잡는다 — 폰에서는 아래에서 올라오는 시트, 넓은 화면에서는 .game 오른쪽에 붙는 열.
 * 음성(2단계) 컨트롤은 상단 바의 chat__tools 자리에 들어간다.
 */
export default function LiveChat({ send, subscribe, you, onOpenChange }) {
  const { messages, loaded, textMax, send: sendChat } = useChat({ send, subscribe });
  const [open, setOpen] = useState(loadOpen);
  const lastId = messages.at(-1)?.id ?? 0;
  const [seenId, setSeenId] = useState(null); // null: 이력을 아직 못 받음. 처음 받은 이력은 읽은 것으로 친다

  useEffect(() => {
    if (open || (seenId === null && loaded)) setSeenId(lastId);
  }, [open, loaded, lastId, seenId]);
  // 레이아웃(has-chat)이 첫 그림부터 맞도록 paint 전에 알린다
  useLayoutEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  const unread = open || seenId === null ? 0 : messages.filter((m) => m.id > seenId).length;
  const toggle = (next) => {
    setOpen(next);
    saveOpen(next);
  };

  return (
    <>
      <button
        className={`btn btn--ghost btn--sm chat-toggle${open ? ' is-on' : ''}`}
        aria-pressed={open}
        aria-label={unread ? `라이브채팅, 새 메시지 ${unread}개` : '라이브채팅'}
        onClick={() => toggle(!open)}
      >
        <span aria-hidden="true">💬</span>
        <span className="chat-toggle__label">라이브채팅</span>
        {unread > 0 && <span className="chat-toggle__badge">{unread}</span>}
      </button>
      {open && (
        <ChatPanel messages={messages} you={you} textMax={textMax} onSend={sendChat} onClose={() => toggle(false)} />
      )}
    </>
  );
}

function ChatPanel({ messages, you, textMax, onSend, onClose }) {
  const [text, setText] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  return (
    <>
      <div className="chat-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="chat" aria-label="라이브채팅">
        <div className="chat__head">
          <b className="chat__title">💬 라이브채팅</b>
          <span className="chat__tools" />
          <button className="btn btn--ghost btn--sm" onClick={onClose} aria-label="채팅 닫기">
            ✕
          </button>
        </div>

        <ol className="chat__list">
          {messages.length === 0 && <li className="chat__empty">아직 대화가 없어요. 먼저 인사해 보세요!</li>}
          {messages.map((m) => (
            <li key={m.id} className={`chat__msg${m.by === you ? ' is-mine' : ''}`}>
              <Avatar name={m.name} size="sm" />
              <div className="chat__body">
                <span className="chat__meta">
                  <b>{m.name}</b>
                  <time dateTime={new Date(m.at).toISOString()}>{hhmm(m.at)}</time>
                </span>
                <p className="chat__text">{m.text}</p>
              </div>
            </li>
          ))}
          <li ref={endRef} aria-hidden="true" />
        </ol>

        <form
          className="chat__form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) {
              onSend(text);
              setText('');
            }
          }}
        >
          <input
            className="input"
            aria-label="채팅 메시지"
            value={text}
            maxLength={textMax ?? undefined}
            placeholder="메시지 보내기…"
            autoComplete="off"
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn btn--secondary" type="submit" disabled={!text.trim()}>
            보내기
          </button>
        </form>
      </aside>
    </>
  );
}
