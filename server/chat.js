// 라이브채팅의 순수 로직. 게임 규칙(game.js)을 전혀 모르고, I/O도 없다.
// 방마다 하나씩 두고, 방이 대기실로 되돌아갈 때 함께 비운다.

export const CHAT_MAX = 50; // 남겨두는 최근 메시지 수
export const CHAT_TEXT_MAX = 200;

const ok = (extra = {}) => ({ ok: true, ...extra });
const err = (message) => ({ ok: false, error: message });

export function createChat() {
  // seq: 오래된 메시지를 잘라내도 계속 올라가는 번호. 클라이언트가 안 읽은 개수를 세는 기준.
  return { messages: [], seq: 0 };
}

/** 이름을 함께 남겨, 보낸 사람이 나간 뒤에도 누가 한 말인지 보인다. */
export function postMessage(chat, { by, name }, text, now = Date.now()) {
  const clean = String(text ?? '').trim();
  if (!clean) return err('메시지를 입력하세요.');
  if (clean.length > CHAT_TEXT_MAX) return err(`메시지는 ${CHAT_TEXT_MAX}자 이하로 입력하세요.`);

  chat.seq += 1;
  const message = { id: chat.seq, by, name, text: clean, at: now };
  chat.messages.push(message);
  if (chat.messages.length > CHAT_MAX) chat.messages.splice(0, chat.messages.length - CHAT_MAX);
  return ok({ message });
}
