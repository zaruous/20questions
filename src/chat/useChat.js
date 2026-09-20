import { useCallback, useEffect, useState } from 'react';

/**
 * 라이브채팅 상태. 게임 상태(state)와 별개로 전용 메시지(chat / chatHistory)만 듣는다.
 * 마운트되면 이력을 한 번 요청한다 — 입장 직후 서버가 밀어주는 이력은 이 훅이 아직 없을 때 지나갈 수 있어서다.
 */
export function useChat({ send, subscribe }) {
  const [messages, setMessages] = useState([]);
  const [loaded, setLoaded] = useState(false); // 이력을 한 번 받았는지. 그 전에는 안 읽은 개수를 셀 수 없다
  const [textMax, setTextMax] = useState(null);

  useEffect(() => {
    const offHistory = subscribe('chatHistory', (msg) => {
      setMessages(msg.messages);
      setTextMax(msg.textMax);
      setLoaded(true);
    });
    const offChat = subscribe('chat', (msg) =>
      setMessages((prev) => (prev.some((m) => m.id === msg.message.id) ? prev : [...prev, msg.message])),
    );
    send({ type: 'chatHistory' });
    return () => {
      offHistory();
      offChat();
    };
  }, [send, subscribe]);

  const sendText = useCallback((text) => send({ type: 'chat', text }), [send]);
  return { messages, loaded, textMax, send: sendText };
}
