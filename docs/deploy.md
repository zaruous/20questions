# 배포와 외부 접속

[← README로](../README.md)

서버 한 대가 화면(정적 파일)과 실시간 통신(WebSocket)을 모두 처리합니다. 방 상태가 프로세스 메모리에 있으므로
**상시 떠 있는 Node 프로세스 1개**가 필요합니다. 서버리스(Vercel·Netlify·Cloudflare Pages)에는 올릴 수 없고,
인스턴스를 여러 대로 늘려도 안 됩니다.

## Render 무료 플랜 (권장)

`render.yaml` 블루프린트가 포함되어 있습니다. [Render 대시보드](https://dashboard.render.com)에서
**New → Blueprint**로 이 저장소를 연결하면 설정 입력 없이 서비스가 만들어지고, 이후 `main`에 푸시할 때마다
자동 배포됩니다. 수동으로 만들 때는 아래 값을 그대로 넣으세요.

| 항목 | 값 |
| --- | --- |
| Runtime | Node (`.node-version` = 22) |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |
| Region | Singapore (무료 리전 중 한국에서 가장 가까움) |

`--include=dev`가 **반드시** 필요합니다. Render는 빌드 중에도 `NODE_ENV=production`이라 `npm ci`만 쓰면
`devDependencies`의 `vite`가 설치되지 않아 빌드가 깨집니다. 로컬에서 재현하면:

```bash
NODE_ENV=production npm ci && npm run build                # 실패: vite 없음
NODE_ENV=production npm ci --include=dev && npm run build  # 성공
```

`PORT`는 Render가 주입하고 서버가 그대로 읽습니다. `https`로 열리면 클라이언트도 자동으로 `wss`로 붙습니다.

무료 플랜에서 알아 둘 것:

- **15분간 트래픽이 없으면 잠듭니다.** 다시 깨는 데 1분쯤 걸리므로 첫 접속자만 기다립니다.
  WebSocket 메시지도 트래픽으로 세기 때문에 게임하는 동안에는 잠들지 않습니다.
  약속 시간 몇 분 전에 미리 한 번 열어 두면 바로 시작할 수 있습니다.
- **깨어날 때 메모리가 비워집니다.** 방 3개는 다시 만들어지지만 진행 중이던 판은 사라집니다.
- **인스턴스를 늘리지 마세요.** 방 목록이 프로세스 메모리에 있어서 여러 대로 늘리면 갈라집니다.
  (무료 플랜은 어차피 1대 고정입니다.)

## 다른 호스팅

| 서비스 | 가능 여부 |
| --- | --- |
| Google Cloud Run | 가능. `--max-instances=1 --timeout=3600` 필수, 카드 등록 필요 |
| Oracle Cloud Always Free VM | 가능. nginx·TLS·pm2를 직접 관리 |
| Hugging Face Spaces (Docker) | 가능. 48시간 무접속 시 슬립 |
| Vercel / Netlify / Cloudflare Pages | 불가 (서버리스, 상시 WebSocket 서버 없음) |
| Fly.io / Koyeb / Railway / Northflank | 무료 티어 종료·중단 또는 WebSocket 미지원 (2026년 기준) |

## 같은 와이파이의 폰에서 접속

`npm start`는 `0.0.0.0`에 열리므로 같은 네트워크의 폰에서 바로 접속할 수 있습니다.

```bash
hostname -I            # Linux — PC의 내부 IP
ipconfig getifaddr en0 # macOS
ipconfig               # Windows (IPv4 주소)
# 폰 브라우저에서 http://<PC의 내부 IP>:3001
```

## 터널로 잠깐 공개

배포하지 않고 한 판만 할 때는 `cloudflared` / `ngrok` 같은 터널을 **`npm start`(3001)** 에 연결하세요.
Vite 개발 서버(5173)는 외부 도메인 접근을 차단하므로 터널 대상으로 쓰지 마세요.

## 환경변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3001` | HTTP/WebSocket 포트 |
| `ROOM_COUNT` | `3` | 서버가 열어 두는 방의 개수 |
| `VITE_TURN_URL` | 없음 | 음성 채팅용 TURN 서버 주소 (예: `turn:turn.example.com:3478`) |
| `VITE_TURN_USERNAME` | 없음 | TURN 사용자 이름 |
| `VITE_TURN_CREDENTIAL` | 없음 | TURN 비밀번호 |

## 음성 채팅(WebRTC)

라이브채팅의 음성은 브라우저끼리 직접(P2P) 연결되고 서버는 연결 정보만 중계합니다. TURN 변수 3개가 없으면
구글 공개 STUN만 쓰는데, 이 경우 일부 네트워크(회사망·일부 이동통신망)에서는 서로 연결되지 않을 수 있습니다.
`VITE_` 변수는 **빌드 시점에** 클라이언트 번들에 들어가므로(Render에서는 환경변수에 넣으면 빌드에 적용)
브라우저에 노출됩니다 — TURN은 시간제한 자격증명을 발급하는 서비스를 쓰는 것이 안전합니다.
음성은 `https`(또는 `localhost`)에서만 켤 수 있습니다.
