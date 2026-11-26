# 비온다? × 날씨봇 (Bionda) 유지보수 · 아키텍처 · 변경 이력서

> 본 문서는 한국도로공사 고령지사 관할 **고속국도 제12호선 광주대구선(`함양IC 95.0k ~ 옥포JC 176.0k`, 기상청 도로노선 `14번` / 위험기상 `012선`)** 실시간 기상·도로살얼음 관제 대시보드의 영구 유지보수 기준서입니다.

---

## 1. 배포 토폴로지 및 저장소 구조

| 구분 | 저장소 / 경로 | 실서버 URL | 역할 |
|---|---|---|---|
| **주 저장소 (Primary)** | `PoeticEcho/bionda` (`main`) | `https://bionda.pages.dev` | Cloudflare Pages 정적 호스팅 + Pages Functions(`/api/*`, `/share/status.json`) + `bionda-api` Worker 자동 배포 |
| **미러 저장소 (Mirror)** | `PoeticEcho/etc` (`bionda/`) | `https://poeticecho.github.io/etc/bionda/` | GitHub Pages 백업 프런트엔드 (`public/*` 동기화) |
| **단일 파일 번들** | `dist/bionda-worker.standalone.js` | `npm run build:worker` | Cloudflare 대시보드 수동 복구용 독립 번들 |

### 핵심 페이지 구성
1. **`/` (`public/index.html`, `public/app.js`, `public/minimap.js`)**: 도로기상 상황판 (8개 관심지역 카드 + 남원~옥포 노선 미니맵 + Windy/기상청 HSR 레이더 + 제설·수방 의사결정)
2. **`/hourly` (`public/hourly.html`, `public/hourly.js`)**: 13개 읍·면·동 1시간 단기·초단기예보 매트릭스 (기본 24시간, 기상청 DFS 12개 고유 격자)
3. **`/rwis` (`public/rwis.html`, `public/rwis.js`, `public/rwis-data.js`)**: 50인치 상황실 TV 전용 도로살얼음상황판 (`1920×1080` 단일 화면 무스크롤, RWIS 8개 구간 양방향 지도 + 7개 관측소 콜아웃 + 13개 지역 날씨 배지 + 6h 실측/2h 예측 스파크라인 + 특이사항 속보 + 62지점 CCTV)
4. **`/diagnostics.html` (`public/diagnostics.js`)**: 전 파이프라인 시각 정합성·불변식 실시간 진단 및 도로공사 격상 알림·차임벨 시뮬레이터
5. **`/history-72h.html` (`public/history-72h.js`)**: 제설근무표(예비살포·본살포) 전·후 기상 매칭 사후분석 및 엑셀 호환 CSV 추출 도구 (**수동 실행 전용 · 평시 API 호출 0**)

---

## 2. 공간 범위 및 데이터 무결성 불변식 (Invariants)

1. **3단계 공간 스코프 분리 (`lib/bionda-core.js` → `buildRoadRiskPayload`)**
   - `allRouteSummary`: `무안IC~옥포JC(012선 전구간)` (`0.0k ~ 176.0k`)
   - `corridorSummary`: `남원(50.0k)~옥포JC(176.0k)` (서→동 기상 유입 선행 감시 포함)
   - `branchSummary`: **`함양IC(95.0k)~옥포JC(176.0k)`** (고령지사 관할 본선 — 8개 RWIS 콘존 `160~230` 및 7개 도로기상관측소 `14206, 14409, 14207, 14208, 14209, 14103, 14410`)
2. **`No False Safety` (결측 `null` vs 유효 `0등급` 엄격 분리)**
   - `normalizeRiskGrade(raw)`: 유효 정수 `0..3`만 등급으로 인정하며, `null / undefined / '' / -999`는 반드시 `null`(`정보 없음`)로 유지합니다.
   - 유효 `0등급` = **`안전`**, 결측 `null` = **`정보 없음`**.
   - **링크 수 불변식**: 모든 공간 요약에서 항상 `total1km === sum(iceCounts) + missingIceCount`가 성립해야 합니다.
3. **도로기상관측(`TR1·TA`) 단일 진실 공급원 (Monotonic SSOT)**
   - `SHARED_ROAD_OBS_KEY` (`weather-watch:shared-road-obs:v1`)를 통해 탭 간 관측시각(`tm1`)이 단조 증가(`incomingTm >= currentTm`)할 때만 갱신하여 페이지 간 온도 역전을 원천 차단합니다.
4. **단기예보 회차 역행 방지 (`Monotonic Forecast Generation`)**
   - `baseShort(now)`는 발표 시각 +11분(`02:11, 05:11, 08:11, 11:11, 14:11, 17:11, 20:11, 23:11 KST`)부터 신규 회차를 조회합니다.
   - `?force=1` 재조회 중 상류 타임아웃이 발생하더라도 `-180분` 과거 회차를 호출하기 전 `kma-stale`(최신 정상 회차) 및 `short12-last-verified`를 우선 보존합니다 (`isoKst` 기준 비교).
5. **한국도로공사 「기상청 도로살얼음 위험정보 대응방법 변경알림」 공식 알림 규격 (`public/ice-alert-modal.js`)**
   - API허브 5분 주기 업데이트에 맞춰 고령지사 관할(`95.0~176.0k`) 구간이 격상될 때 동작합니다:
     - **주의(2단계) 격상**: `⬆ 도로살얼음 위험정보 주의 격상 알림` / `온도, 노면상태 확인 후 예비살포` + 고정식 기상관측소 실시간 `대기온도 · 노면온도 · 노면상태` 병기 + 지도·카드 주황 점멸
     - **위험(3단계) 격상**: `⬆ 도로살얼음 위험정보 위험 격상 알림` / `예비살포 실시` (`선(先)예비살포, 후(後)상황판단회의`) + 지도·카드 적색 점멸
     - `[확인]` 클릭 시 `localStorage`(`weather-watch:ice-alert-ack:v1`)로 탭 간 중복 팝업을 억제하되 점멸은 유지하며, `2→3` 추가 격상 또는 `0/1` 해제 후 재격상 시 즉시 재알림합니다.

---

## 3. 백엔드 API 엔드포인트 및 캐시 정책 요약

| 엔드포인트 | 원천 주기 | Worker / Edge 캐시 | 비고 |
|---|---|---|---|
| `/api/road-obs?line=14` | 1분 | 메모리 `45s`, Edge `45s` (`Last-Good` 백업) | `[1,2,3,5,8]분` 순차 탐색 |
| `/api/road-risk?roadNum=012` | 5분 | 메모리 `4m`, Edge `max-age=120, s-maxage=210` | `FRG`/`FOG` 개별 시각 추출 |
| `/api/rwis/api/rwis` | 5분 | Edge/스트리밍 스캐너 | 5.6MB 위험표 `ReadableStream` 추출 (`FR`/`VR` 분리) |
| `/api/short-term-12?roster=13` | 단기 3h / 초단기 1h | 최대 `5m` (발표 경계·세대혼재 시 단축/`no-store`) | 12개 고유 격자 병렬 + `popSource` 명시 |
| `/api/road-obs-trend?line=14&hours=6` | 30분 슬롯 | 메모리 `5m`, Edge `10m` (과거 슬롯 `6h`) | 8개 구간 카드 `6h 실측 + 2h 예측` 스파크라인용 |
| `/api/road-obs-history` | 수동 호출 | 과거 불변 슬롯 메모리·Edge `6h` | `STEP 5` 72h 제설근무 매칭·CSV 전용 (1회 ≤37슬롯) |
| `/api/data-health` | 진단 호출 | Edge `45s` (`?force=1` 시 `no-store`) | `STEP 4` 6대 파이프라인 통합 건전성 진단 |
| `/api/briefing` & `/share/status.json` | 일 2회 (`08:13`·`18:04` KST) | Edge `30m` / 정적 SHA-256 검증 | `STEP 3` 외부 봇 저호출 브리핑 채널 |

---

## 4. 단계별 개발 및 개선 이력 (Changelog)

- **P0 ~ P2.5 (초기 고도화)**:
  - `rwis.js` 응답 경량화 (`188KB → 13.4KB`), 영하(`<0°C`) vs 결빙경계(`0°C`) 판정 통일, 10분 통신 단절 시 통합인증 확인 팝업(`net-health.js`), 50인치 TV 잔상방지(`tv-guard.js`), 3탭 상단 실시간 배지 통일, 6h 실측 + 2h 열관성·복사냉각 예측 인라인 스파크라인 구축.
- **P3 ~ P4-4 (플래그십 지도 · 강제 새로고침 · 실시간 정합성 일원화)**:
  - RWIS 5.6MB 스트리밍 파서 전환, 7개 관측소 카드 `2·2·1·2` 무충돌 배치 및 최하위 지시선 레이어(`map-leader-underlay`), 5분 내 2회 이상 새로고침 클릭 시 전 계층 캐시 우회(`hard=1`), `SHARED_ROAD_OBS_KEY` SSOT 도입 및 Worker 요청 간 `INFLIGHT` 데드락 제거(`7debf5e2`).
- **3자 정밀 감사 대응 `P0` (`STEP 1` + `STEP 2` + 도로공사 공식 격상 알림, `dc349b02`)**:
  - 단기예보 회차 역행(`17:00 → 14:00`) 차단, RWIS `0(안전)` vs `null(정보 없음)` 분리, 이정 오표기 교정(`함양IC 95.0k ~ 옥포JC 176.0k`), `FR/VR` 및 `FRG/FOG` 개별 시각 병기, 도로공사 공식 `주의`·`위험` 격상 팝업 모달 및 점멸 표시 구현.
- **`STEP 3 · STEP 4 · STEP 5` 완성 (운영 진단 · 브리핑 채널 · 72h 제설 사후분석)**:
  - `STEP 3`: GitHub Actions 정시 큐 병목 회피(`08:13` / `18:04` KST), `publish-share.py` `force=1` 및 `public/api/briefing.json` 동시 갱신, `/api/briefing` Edge 캐시 엔드포인트 추가.
  - `STEP 4`: `/api/data-health` + `/diagnostics.html` 구축 및 메인 상황판 카드 `실측` / `모델` 원천 배지 명확화.
  - `STEP 5`: `/api/road-obs-history` + `/history-72h.html` 구축 (72시간 수동 분할 조회, 예비·본살포 `T-2h / T=0 / T+2h` 기상 근거 자동 매칭, 엑셀 호환 UTF-8 BOM CSV 다운로드).
- **모바일 긴급 버그 수정 (`diagnostics.html` `signal timed out` 해소 & `rwis.html` 모바일 `[지도 크게]` 대화면 뷰어 구현)**:
  - `diagnostics.js` + `worker.js`: 단일 Worker 내 35+개 상류 서브요청·6소켓 동시 경합으로 모바일 콜드 PoP에서 발생하던 `signal timed out`을 원천 차단하기 위해, 프런트엔드를 6개 개별 Edge 캐시 엔드포인트 독립 병렬·점진 렌더링 구조로 전환하고 `/api/data-health`에도 Edge 캐시 우선 재사용 및 파이프라인별 개별 데드라인(`6~11.5s`)을 적용.
  - `rwis.html` + `rwis.css` + `rwis.js` + `rwis-data.js`: 모바일·태블릿(`<= 1320px`)에서 `[⛶ 지도 크게]` 클릭 시 기존 1열 폭(`390px`) 고정으로 지도가 커지지 않던 버그를 수정하여, `100vw × 100dvh` 전체화면 인터랙티브 지도 뷰어(약 `300%+` 세로 높이 채움 고해상도 슬라이드 · 활성 주의/위험 구간 자동 포커스 · 두 손가락 핀치줌 · 세로 고정 상태용 `↻ 가로한눈에` 90° 회전 보기 · 안드로이드 뒤로가기 제스처 연동)를 구현하고 50인치 TV(`1920×1080`) 무스크롤 규격은 그대로 보존.

---

## 5. 유지보수 점검 명령어

```powershell
# 1. 단일 파일 Worker 번들 재생성
npm run build:worker

# 2. 전체 단위 테스트 실행 (Node 20+, 시스템 루트 CA 사용)
node --use-system-ca --test tests/*.test.js
```
