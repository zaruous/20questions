import { afterEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ cleanups: [] }));

vi.mock('react', () => ({
  useCallback: (fn) => fn,
  useEffect: (fn) => {
    const cleanup = fn();
    if (cleanup) effects.cleanups.push(cleanup);
  },
  useRef: (value) => ({ current: value }),
  useState: (value) => [typeof value === 'function' ? value() : value, vi.fn()],
}));

import { useVoice } from './useVoice.js';

const PEER_RETRY_MS = 1000;

class FakePeerConnection {
  static instances = [];

  constructor() {
    this.connectionState = 'new';
    this.localDescription = null;
    FakePeerConnection.instances.push(this);
  }

  addTrack() {}
  close() {
    this.connectionState = 'closed';
  }
  async createOffer() {
    return { type: 'offer', sdp: 'offer' };
  }
  async setLocalDescription(value) {
    this.localDescription = { ...value, toJSON: () => value };
  }
}

describe('음성 피어 복구', () => {
  afterEach(() => {
    effects.cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
    FakePeerConnection.instances = [];
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('연결 실패를 상대에게 알리고 같은 참여자와 새 피어를 만든다', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
    });
    const handlers = new Map();
    const sent = [];
    const voice = useVoice({
      you: 'a',
      send: (message) => sent.push(message),
      subscribe: (type, handler) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    });

    await voice.join();
    handlers.get('voice')({ members: [{ id: 'a' }, { id: 'b' }] });
    await Promise.resolve();
    const first = FakePeerConnection.instances[0];

    first.connectionState = 'failed';
    first.onconnectionstatechange();
    expect(sent).toContainEqual({ type: 'rtc', to: 'b', data: { restart: true } });
    expect(first.connectionState).toBe('closed');

    await vi.advanceTimersByTimeAsync(PEER_RETRY_MS);
    expect(FakePeerConnection.instances).toHaveLength(2);
  });
});
