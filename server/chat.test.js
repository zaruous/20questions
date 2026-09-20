import { describe, it, expect } from 'vitest';
import * as c from './chat.js';

const T0 = 1_700_000_000_000;
const me = { by: 'p0', name: '플레이어0' };

describe('라이브채팅', () => {
  it('빈 메시지와 너무 긴 메시지는 거절한다', () => {
    const chat = c.createChat();
    expect(c.postMessage(chat, me, '   ', T0).ok).toBe(false);
    expect(c.postMessage(chat, me, 'a'.repeat(c.CHAT_TEXT_MAX + 1), T0).ok).toBe(false);
    expect(chat.messages).toHaveLength(0);
  });

  it('보낸 사람 이름과 시각을 함께 남기고 앞뒤 공백은 지운다', () => {
    const chat = c.createChat();
    const { message } = c.postMessage(chat, me, '  안녕  ', T0);
    expect(message).toEqual({ id: 1, by: 'p0', name: '플레이어0', text: '안녕', at: T0 });
    expect(chat.messages).toEqual([message]);
  });

  it('최근 50개만 남기고, 번호는 계속 올라간다', () => {
    const chat = c.createChat();
    for (let i = 1; i <= c.CHAT_MAX + 5; i += 1) c.postMessage(chat, me, `m${i}`, T0 + i);
    expect(chat.messages).toHaveLength(c.CHAT_MAX);
    expect(chat.messages[0].text).toBe('m6');
    expect(chat.messages.at(-1).id).toBe(c.CHAT_MAX + 5);
  });
});
