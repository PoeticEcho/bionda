# 광주대구선(남원~대구) CCTV 관제 — 배포·연동 메모

관심지역 8곳 + 도로관측소 11곳 = **19개 지점**의 최인접/보조 고속도로 CCTV를 한 화면에서 보고, 클릭하면 순수 HLS `<video>` 팝업에서 바로 재생합니다.

| 파일 | 역할 |
| --- | --- |
| `lib/cctv-its.js` | ITS Open API 응답 파싱, 19개 지점 이름 매칭(`exact`/`partial`), `CCTV_SOURCE_URL` 폴백 공통 모듈 |
| `cloudflare/worker.js` + `server.js` | `GET /api/cctv` (15분 캐시) 및 `GET /api/cctv?refresh=1` 엔드포인트 통합 제공 |
| `public/cctv-preview.html` + `public/cctv-preview.js` | 19개 지점 표 + 최인접/보조 CCTV 칩 + 로컬 `vendor/hls.min.js` 기반 `<video>` 팝업(방향 전환 탭, 실패 시 캐시 새로고침 재시도) |
| `README_cctv.md` | 이 문서 |

> 영상 트래픽은 Worker를 지나가지 않습니다. 목록(JSON)만 Worker가 15분 캐시로 중계하고 `.m3u8`/영상 조각은
> 브라우저의 `hls.js`가 각 스트리밍 서버(`*.hscdn.com` 등)에서 직접 받습니다.

---

## 1. 시크릿 등록 및 배포 (Cloudflare Workers / Pages)

### API 키 등록 (코드에 하드코딩 금지)

기존 `bionda` Cloudflare Worker(또는 Pages Functions 환경변수)에 `ITS_API_KEY` 시크릿을 등록합니다.

```bash
wrangler secret put ITS_API_KEY      # 프롬프트에 발급받은 ITS Open API 키 붙여넣기
```

- Cloudflare 대시보드: `Workers & Pages → bionda → Settings → Variables and Secrets`에서 `ITS_API_KEY` 추가(Secret 권장).
- 로컬 Node 테스트: 프로젝트 루트 `.env` 파일에 한 줄 추가 (`.env`는 `.gitignore`로 커밋 제외):
  ```
  ITS_API_KEY=발급받은키
  ```
- 단일 파일 번들(Quick Edit용) 생성:
  ```bash
  npm run build:worker
  # → dist/bionda-worker.standalone.js
  ```

### 바로 확인

```bash
curl -s "https://bionda.pages.dev/api/cctv" | head -40
curl -s "https://bionda.pages.dev/api/cctv?refresh=1" | head -5
```

정상이면 `"ok": true`, `"count": <CCTV 수>`, `"sites": [19개]` 가 보입니다.
`"cache": "MISS" → "HIT"` 로 바뀌면 15분 캐시가 동작하는 것입니다.

---

Pages는 연결된 Worker가 서버 오류를 반환하면 Pages에 설정된 CCTV 원본으로 다시 조회합니다. 원본 조회가 실패할 때는 같은 엣지에 보관한 최근 30분 이내 목록을 사용할 수 있습니다. 이때 응답은 `X-Cache: STALE`과 원래 수신 시각을 표시합니다. 처음 목록을 여는 뷰어는 502·503·504 응답을 최대 두 번 재시도합니다.

## 2. 대시보드 사용

- Cloudflare Pages: `https://bionda.pages.dev/cctv-preview` (기본 주소 `/api/cctv` 자동 연결)
- GitHub Pages 미러: `https://poeticecho.github.io/etc/bionda/cctv-preview.html` (기본 주소 `https://bionda.pages.dev/api/cctv` 자동 연결)
- 별도 단독 Worker를 배포한 경우에도 상단 **Worker 주소** 칸에 `https://<별도워커>.workers.dev/api/cctv` 를 입력하고 **저장**하면 브라우저 `localStorage`에 유지됩니다.

### 조작 방법
1. **목록 불러오기** → 19개 지점 표가 채워지고, 각 칩에 방향/후보 개수(`×2`)가 표시됩니다.
2. 칩을 누르면 순수 CCTV 영상 팝업에서 바로 재생됩니다.
   - 같은 이름의 방향별 CCTV가 여러 개면 팝업 상단 탭(예: `상행`, `하행`, `#1`)으로 전환
   - 재생 실패 시 **캐시 새로고침 후 다시 시도** → `?refresh=1` 로 최신 목록을 다시 받아 재시도
   - 목록에 이름이 없으면(개명·폐쇄) 비슷한 이름 후보를 추천
3. 키보드 `Esc` 또는 배경 클릭으로 팝업을 닫습니다.

---

## 3. 9443 포트가 막힐 때 (`CCTV_SOURCE_URL` 대안)

Cloudflare Workers에서 `https://openapi.its.go.kr:9443` 처럼 **비표준 포트**로 나가는 연결이
환경에 따라 막히거나 타임아웃될 수 있습니다. 그때 `/api/cctv` 는 `502`와 `UPSTREAM_UNREACHABLE` / `UPSTREAM_TIMEOUT`을 돌려줍니다.

이 경우 Worker 코드는 그대로 두고 **JSON만 다른 곳에서 받아** `CCTV_SOURCE_URL` 환경변수로 넘깁니다.
Worker가 그 주소에서 같은 형식(ITS 원본 JSON 또는 `{"cctvs":[…]}`)을 받아 똑같이 15분 캐시·매칭합니다.

```bash
wrangler secret put CCTV_SOURCE_URL   # 예: https://내NAS/cctv/its.json
```

### 3-1. 시놀로지 NAS 작업 스케줄러 (15분마다)

```sh
#!/bin/sh
# 키는 스크립트에 직접 쓰지 말고 /volume1/web/cctv/env.sh (chmod 600)에 ITS_API_KEY=... 보관
. /volume1/web/cctv/env.sh

OUT=/volume1/web/cctv/its.json
TMP=$OUT.tmp
/usr/bin/curl -sS --max-time 20 \
  "https://openapi.its.go.kr:9443/cctvInfo?apiKey=${ITS_API_KEY}&type=ex&cctvType=1&minX=127.25&maxX=128.65&minY=35.30&maxY=35.90&getType=json" \
  -o "$TMP" && [ -s "$TMP" ] && mv "$TMP" "$OUT"
```

### 3-2. GitHub Actions 스케줄러 (15분마다)

```yaml
name: fetch-its-cctv
on:
  schedule: [{ cron: "*/15 * * * *" }]
  workflow_dispatch:
jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Fetch ITS CCTV list
        env:
          ITS_API_KEY: ${{ secrets.ITS_API_KEY }}
        run: |
          curl -sS --max-time 30 \
            "https://openapi.its.go.kr:9443/cctvInfo?apiKey=${ITS_API_KEY}&type=ex&cctvType=1&minX=127.25&maxX=128.65&minY=35.30&maxY=35.90&getType=json" \
            -o its.json
          test -s its.json
```

---

## 4. 문제 해결

| 증상 | 원인 / 조치 |
| --- | --- |
| `ITS_API_KEY_MISSING` (500) | `wrangler secret put ITS_API_KEY` 로 시크릿 설정 후 재배포 |
| `UPSTREAM_UNREACHABLE` / `UPSTREAM_TIMEOUT` (502) | 9443 포트 차단 가능성 → 3장의 `CCTV_SOURCE_URL` 대안 사용 |
| `UPSTREAM_BAD_JSON` (502) | 업스트림이 HTML(차단 페이지) 등을 반환. 키 상태·요청 URL 확인 |
| `ITS_API_ERROR` (502) | ITS가 오류 코드 반환(키 만료/트래픽 초과 등). `detail.resultMsg` 확인 |
| 칩이 "목록에 없음"으로 표시 | ITS에 그 이름이 없음(개명·폐쇄) → 캐시 새로고침 후 재확인, 팝업의 추천 후보 사용 |
| 영상만 안 나옴 | 스트림 서버 일시 장애 또는 주소 만료 → 팝업의 **캐시 새로고침 후 다시 시도** |
| `⚠ HTTP 스트림` 표시 / 영상 차단 | ITS가 `http://` 주소를 줄 때 https 페이지에서 브라우저가 혼합 콘텐츠로 차단 → 새 탭 열기 또는 HTTP 환경 확인 |
