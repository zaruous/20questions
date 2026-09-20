import { describe, it, expect } from 'vitest';
import * as rtc from './rtc.js';

describe('음성 참여자 목록', () => {
  it('참여와 이탈은 여러 번 해도 결과가 같고, 바뀌었을 때만 true를 돌려준다', () => {
    const v = rtc.createVoice();
    expect(rtc.join(v, 'a')).toBe(true);
    expect(rtc.join(v, 'a')).toBe(false);
    rtc.join(v, 'b');
    expect(rtc.membersOf(v)).toEqual(['a', 'b']);

    expect(rtc.leave(v, 'a')).toBe(true);
    expect(rtc.leave(v, 'a')).toBe(false);
    expect(rtc.leave(v, '없는사람')).toBe(false);
    expect(rtc.membersOf(v)).toEqual(['b']);
  });

  it('시그널은 참여 중인 서로 다른 두 사람 사이에서만 중계한다', () => {
    const v = rtc.createVoice();
    rtc.join(v, 'a');
    rtc.join(v, 'b');
    expect(rtc.canRelay(v, 'a', 'b')).toBe(true);
    expect(rtc.canRelay(v, 'a', 'a')).toBe(false); // 자기 자신에게
    expect(rtc.canRelay(v, 'a', 'c')).toBe(false); // 참여하지 않은 사람에게
    expect(rtc.canRelay(v, 'c', 'a')).toBe(false); // 참여하지 않은 사람이
  });
});
