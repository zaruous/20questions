// 음성 채팅의 서버 측 순수 로직. 게임 규칙(game.js)을 모르고, I/O도 없다.
// 소리는 브라우저끼리 직접(WebRTC) 흐르고, 서버는 "누가 참여 중인지"와
// "이 시그널(SDP/ICE)을 저 사람에게 건네줘도 되는지"만 안다.

export const RTC_DATA_MAX = 16 * 1024; // 릴레이하는 시그널 payload(JSON) 길이 상한

export function createVoice() {
  return { members: new Set() };
}

/** 참여. 이미 참여 중이면 false — 호출한 쪽이 알림을 생략할 수 있게. */
export function join(voice, id) {
  if (voice.members.has(id)) return false;
  voice.members.add(id);
  return true;
}

/** 이탈. 참여 중이 아니었으면 false. */
export function leave(voice, id) {
  return voice.members.delete(id);
}

export const membersOf = (voice) => [...voice.members];

/** 시그널은 참여 중인 서로 다른 두 사람 사이에서만 오간다. */
export function canRelay(voice, from, to) {
  return from !== to && voice.members.has(from) && voice.members.has(to);
}
