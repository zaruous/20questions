import { useCallback, useEffect, useRef, useState } from 'react';

// 음성 채팅(WebRTC 메시, 2~8명). 서버는 SDP/ICE를 상대 한 사람에게 건네주기만 하고 소리는 브라우저끼리 직접 흐른다.
// 게임 상태를 모르고 소켓(send/subscribe)과 내 id만 받는다. 전용 메시지: voice(참여자 목록), rtc(시그널).

// 참여했던 기억. 자동 재참여는 하지 않는다(권한·자동재생 정책에 걸린다) — 버튼 문구로 힌트만 준다.
const VOICE_KEY = 'livechat.voice';
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function loadRemembered() {
  try {
    return localStorage.getItem(VOICE_KEY) === '1';
  } catch {
    return false;
  }
}
function saveRemembered(on) {
  try {
    localStorage.setItem(VOICE_KEY, on ? '1' : '0');
  } catch {
    /* 무시 */
  }
}

/** STUN은 늘 쓰고, TURN은 빌드 환경변수로 넣었을 때만. 없으면 일부 네트워크(회사망 등)에서 연결이 안 될 수 있다. */
function iceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const { VITE_TURN_URL: urls, VITE_TURN_USERNAME: username, VITE_TURN_CREDENTIAL: credential } = import.meta.env;
  if (urls) servers.push({ urls, username, credential });
  return servers;
}

function micError(e) {
  if (e?.name === 'NotAllowedError') return '마이크 권한이 필요해요';
  if (e?.name === 'NotFoundError') return '마이크를 찾을 수 없어요';
  return '마이크를 켤 수 없어요';
}

export function useVoice({ send, subscribe, you }) {
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false); // 권한 프롬프트를 기다리는 중
  const [members, setMembers] = useState([]); // 서버가 준 [{ id, name }]
  const [micOn, setMicOn] = useState(true);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [streams, setStreams] = useState(() => new Map()); // id → MediaStream
  const [error, setError] = useState(null);
  const [remembered, setRemembered] = useState(loadRemembered);

  // 소켓 콜백은 렌더와 무관하게 오므로 최신 값은 ref로 본다
  const aliveRef = useRef(true);
  const joinedRef = useRef(false);
  const micOnRef = useRef(true);
  const membersRef = useRef([]);
  const localRef = useRef(null); // 내 마이크 MediaStream
  const peersRef = useRef(new Map()); // id → { pc, pending: 원격 설명 전에 도착한 ICE 후보 }

  const dropPeer = useCallback((id) => {
    const entry = peersRef.current.get(id);
    if (!entry) return;
    peersRef.current.delete(id);
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.close();
    setStreams((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const createPeer = useCallback(
    (id) => {
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      const entry = { pc, pending: [] };
      peersRef.current.set(id, entry);

      const local = localRef.current;
      local?.getTracks().forEach((track) => pc.addTrack(track, local));
      pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: 'rtc', to: id, data: { candidate: e.candidate.toJSON() } });
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        setStreams((prev) => new Map(prev).set(id, stream));
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(id);
      };

      // 양쪽이 동시에 offer를 보내 충돌(glare)하지 않도록 id가 앞선 쪽만 offer 한다. 뒤쪽은 offer를 기다린다.
      if (you < id) {
        pc.createOffer()
          .then(async (offer) => {
            await pc.setLocalDescription(offer);
            send({ type: 'rtc', to: id, data: { sdp: pc.localDescription.toJSON() } });
          })
          .catch(() => dropPeer(id));
      }
      return entry;
    },
    [send, you, dropPeer],
  );

  /** 피어와 마이크를 모두 내려놓는다. 참여 상태 플래그는 호출한 쪽이 정한다. */
  const teardown = useCallback(() => {
    for (const id of [...peersRef.current.keys()]) dropPeer(id);
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    setStreams(new Map());
    micOnRef.current = true;
    setMicOn(true);
  }, [dropPeer]);

  const handleVoice = useCallback(
    (list) => {
      membersRef.current = list;
      setMembers(list);
      if (!joinedRef.current) return; // 참여 전에는 목록만 본다

      const ids = new Set(list.map((m) => m.id));
      if (!ids.has(you)) {
        // 서버가 나를 참여자에서 뺐다(다른 탭에서 돌아왔거나 연결이 끊겼다 이어짐). 피어를 이어받을 수 없으니 새로 참여해야 한다.
        teardown();
        joinedRef.current = false;
        setJoined(false);
        setError('음성 연결이 끊겼어요. 다시 참여해 주세요.');
        return;
      }
      for (const id of ids) if (id !== you && !peersRef.current.has(id)) createPeer(id);
      for (const id of [...peersRef.current.keys()]) if (!ids.has(id)) dropPeer(id);
    },
    [you, teardown, createPeer, dropPeer],
  );

  const handleRtc = useCallback(
    async (from, data) => {
      if (!joinedRef.current || typeof from !== 'string' || !data) return;
      if (!membersRef.current.some((m) => m.id === from)) return; // 참여자가 아닌 사람의 신호는 무시
      const entry = peersRef.current.get(from) ?? createPeer(from);
      const { pc } = entry;
      try {
        if (data.sdp) {
          await pc.setRemoteDescription(data.sdp);
          if (data.sdp.type === 'offer') {
            await pc.setLocalDescription(await pc.createAnswer());
            send({ type: 'rtc', to: from, data: { sdp: pc.localDescription.toJSON() } });
          }
          for (const candidate of entry.pending.splice(0)) await pc.addIceCandidate(candidate);
        } else if (data.candidate) {
          if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
          else entry.pending.push(data.candidate);
        }
      } catch {
        /* 상대가 나가는 중이거나 순서가 어긋난 신호. 다음 참여자 목록 갱신에서 정리된다 */
      }
    },
    [send, createPeer],
  );

  useEffect(() => {
    const offVoice = subscribe('voice', (msg) => handleVoice(Array.isArray(msg.members) ? msg.members : []));
    const offRtc = subscribe('rtc', (msg) => handleRtc(msg.from, msg.data));
    send({ type: 'voiceState' }); // 입장 직후 서버가 밀어준 목록은 이 훅이 생기기 전에 지나갔을 수 있다
    return () => {
      offVoice();
      offRtc();
    };
  }, [send, subscribe, handleVoice, handleRtc]);

  const join = useCallback(async () => {
    if (joinedRef.current || joining) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('HTTPS 주소에서만 음성을 쓸 수 있어요');
      return;
    }
    setJoining(true);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO });
    } catch (e) {
      setError(micError(e));
      return;
    } finally {
      setJoining(false);
    }
    if (!aliveRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    localRef.current = stream;
    micOnRef.current = true;
    setMicOn(true);
    joinedRef.current = true;
    setJoined(true);
    setRemembered(true);
    saveRemembered(true);
    send({ type: 'voice', on: true }); // 서버가 돌려주는 참여자 목록을 받으면 그때 피어를 만든다
  }, [send, joining]);

  /**
   * 참여를 끊는다. notify=false는 언마운트(방을 나감)용 — 그때는 소켓이 이미 닫히는 중이라
   * 보내면 "연결이 끊겼다"는 알림만 뜨고, 서버는 세션이 닫히면 알아서 빼준다.
   */
  const leave = useCallback(
    (notify = true) => {
      teardown();
      joinedRef.current = false;
      setJoined(false);
      setError(null);
      setRemembered(false);
      saveRemembered(false);
      if (notify) send({ type: 'voice', on: false });
    },
    [teardown, send],
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      leave(false);
    };
  }, [leave]);

  const toggleMic = useCallback(() => {
    const next = !micOnRef.current;
    micOnRef.current = next;
    localRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = next;
    });
    setMicOn(next);
  }, []);

  // 소리는 상태만 바꾸고 <audio muted>로 반영한다. 피어 연결은 그대로라 다시 켜면 바로 들린다.
  const toggleSpeaker = useCallback(() => setSpeakerOn((on) => !on), []);

  return { joined, joining, members, micOn, speakerOn, streams, error, remembered, join, leave, toggleMic, toggleSpeaker };
}
