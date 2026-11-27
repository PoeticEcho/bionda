# 비온다? × 날씨봇 (Bionda) 유지보수 · 아키텍처 · 변경 이력서

> 본 문서는 한국도로공사 고령지사 관할 **고속국도 제12호선 광주대구선(`함양IC 95.0k ~ 옥포JC 176.0k`, 기상청 도로노선 `var=14` / 위험기상 `012선`)** 실시간 기상·도로살얼음 관제 대시보드의 영구 유지보수 기준서입니다.
> - 전체 시스템 개요 및 실행 방법: [`README.md`](../README.md)
> - 타 지사 전환(Multi-Branch) 설계 기준서: [`docs/BRANCH_MIGRATION_GUIDE.md`](BRANCH_MIGRATION_GUIDE.md)

---

## 1. 배포 토폴로지 및 안정판(`v1.0.0-stable`) 보존 현황

### 1.1 실운영 저장소 및 배포 경로

| 구분 | 저장소 / 경로 | 실서버 URL | 역할 |
|---|---|---|---|
| **주 저장소 (Primary)** | `PoeticEcho/bionda` (`main`) | `https://bionda.pages.dev` | Cloudflare Pages 정적 호스팅 + Pages Functions(`/api/*`, `/share/status.json`) + `API_WORKER` Service Binding 연동 |
| **미러 저장소 (Mirror)** | `PoeticEcho/etc` (`bionda/`) | `https://poeticecho.github.io/etc/bionda/` | GitHub Pages 정적 백업 프런트엔드 (`public/*` 동기화, API는 `bionda.pages.dev` 기본 호출) |
| **단일 파일 번들** | `dist/bionda-worker.standalone.js` | `npm run build:worker` | Cloudflare Worker 대시보드 Quick Edit 수동 복구용 독립 번들 |

### 1.2 기능 안정판(`v1.0.0-stable` · 2026-11-27) 보존 좌표
24×7 실운영 검증 기준이 되는 기능 안정판은 `main` 브랜치의 일일 브리핑 이미지 자동 커밋이나 향후 기능 작업과 무관하게 언제든 즉시 복원할 수 있도록 아래 브랜치·태그·릴리스로 동결 보존되어 있습니다.

| 구분 | 보존 브랜치 | 고정 태그 / 릴리스 | 기준 커밋 SHA (동결 시점) |
|---|---|---|---|
| **주 저장소 (`PoeticEcho/bionda`)** | `release/v1.0-stable-20261127` | [`v1.0.0-stable`](https://github.com/PoeticEcho/bionda/releases/tag/v1.0.0-stable) | `758c47238437279ccea100596b3163f026640f6b` |
| **미러 저장소 (`PoeticEcho/etc`)** | `release/bionda-v1.0-stable-20261127` | `bionda-v1.0.0-stable` | `1be6a39cac51ac4339ba94bfb0f158ed8f54fdc1` |

### 1.3 5대 핵심 화면 구성
1. **`/` (`public/index.html`, `public/app.js`, `public/minimap.js`)**: 도로기상 상황판 (8개 관심지역 카드 + 남원~옥포 노선 미니맵 + 11개 도로관측소 스트립 + Windy/KMA HSR 레이더/CCTV + 지역 상세 `#region/...` 12h 타임라인·ICON 앙상블 6h·살얼음/제설 의사결정)
2. **`/hourly` (`public/hourly.html`, `public/hourly.js`)**: 13개 읍·면·동 1시간 단기·초단기예보 매트릭스 (기본 24시간, 고유 12격자, Edge 공유 `Last-Good` 스냅샷 `<0.1s` 즉시표출 + 백그라운드 SWR)
3. **`/rwis` (`public/rwis.html`, `public/rwis.js`, `public/rwis-data.js`)**: 50인치 상황실 TV 전용 도로살얼음상황판 (`1920×1080` 단일 화면 무스크롤, RWIS 8개 콘존 양방향 지도 + 7개 관측소 콜아웃 + 13개 지역 기온 배지 + `6h 실측 + 2h 예측` 스파크라인 + 특이사항 속보 + 62지점 CCTV + 모바일 `[⛶ 지도 크게]` 회전·확대 뷰어)
4. **`/diagnostics.html` (`public/diagnostics.js`)**: 6대 데이터 파이프라인 시각 정합성·불변식 독립 병렬 진단 및 도로공사 공식 격상 알림·차임벨 시뮬레이터
5. **`/history-72h.html` (`public/history-72h.js`)**: 제설근무표(예비살포·본살포) 전·후 기상 매칭(`T-2h / T=0 / T+2h`) 사후분석 및 엑셀 호환 UTF-8 BOM CSV 추출 (**수동 실행 전용 · 평시 API 호출 `0`**)

---

## 2. 공간 범위 및 데이터 무결성 7대 불변식 (Invariants)

유지보수나 기능 수정 후에도 아래 **7가지 불변식**은 절대 깨져서는 안 됩니다 (`npm test` 98개 단위 테스트로 상시 검증).

1. **3단계 공간 스코프 분리 (`lib/bionda-core.js` → `buildRoadRiskPayload`)**
   - `allRouteSummary`: `무안IC~옥포JC(012선 전구간)` (`0.0k ~ 176.0k`)
   - `corridorSummary`: `남원(50.0k)~옥포JC(176.0k)` (서→동 기상 유입 선행 감시 포함)
   - `branchSummary`: **`함양IC(95.0k)~옥포JC(176.0k)`** (고령지사 관할 본선 — 8개 RWIS 콘존 `160~230` 및 7개 도로기상관측소 `14206, 14409, 14207, 14208, 14209, 14103, 14410`)
2. **`No False Safety` (결측 `null` vs 유효 `0등급` 엄격 분리)**
   - `normalizeRiskGrade(raw)`: 유효 정수 `0..3`만 등급으로 인정하며, `null / undefined / '' / -999`는 반드시 `null`(`정보 없음`)로 유지합니다 (`0등급 = 안전` vs `null = 정보 없음`).
   - **링크 합계 불변식**: 모든 공간 요약에서 항상 `total1km === sum(iceCounts) + missingIceCount`가 성립해야 합니다.
3. **기상청 공식 `SFS` 노면상태 코드(`1~15`) 및 위험도 순위(`surfaceSeverityRank`)**
   - `1:건조`, `2:습윤`, `3:적설`, `4:결빙`, `5:서리`, `6:슬러시`, `7:습윤(제설제)`, `10:저시정`, `11:수막`, `12:화학습윤`, `13:임계습윤`, **`14:습기(Damp)`**, `15:눈·결빙`.
   - 단순 수치 비교(`surfaceCode >= 4`)를 금지하며(영상 구간에서 `14 습기` 적색 오경보 방지), 복수 관측소 병합 시 반드시 `surfaceSeverityRank`(`결빙 9 > 임계습윤/서리 8 > 적설/슬러시 7 > 수막 6 > 습윤 5 > 화학습윤 4 > 습기 3 > 저시정 2 > 건조 1`)를 사용합니다.
4. **도로기상관측(`TR1·TA`) 단일 진실 공급원 (Monotonic SSOT)**
   - `SHARED_ROAD_OBS_KEY` (`weather-watch:shared-road-obs:v1`)를 통해 탭 간 관측시각(`tm1`)이 단조 증가(`incomingTm >= currentTm`)할 때만 갱신하여 페이지 간 온도 역전을 원천 차단합니다.
5. **단기예보 회차 역행 방지 (`Monotonic Forecast Generation`) 및 시간별 기온 일치**
   - `baseShort(now)`는 발표 시각 +11분(`02:11, 05:11, ..., 23:11 KST`)부터 신규 회차를 조회하며, 상류 일시 타임아웃 시에도 `-180분` 구회차로 후퇴하기 전에 `kma-stale` 및 `short12-last-verified` 최신 회차를 우선 보존합니다.
   - 지역 상세 `"앞으로 6시간 (ICON 앙상블)"` 표의 기온은 항상 기상청 초단기·단기예보 기온(`kh.temp`)으로 병합하여 상단 타임라인과 `0.0°C` 오차로 일치해야 합니다.
6. **한국도로공사 공식 격상 알림 및 50인치 TV 무조작 규격 (`public/ice-alert-modal.js`, `public/rwis.css`)**
   - `rwis.html`은 `1920×1080` 해상도에서 항상 `document.documentElement.scrollHeight === 1080` 무스크롤을 유지해야 합니다.
   - 주의(2단계)·위험(3단계) 격상 팝업은 **1분(`60초`) 카운트다운 후 자동 닫힘**, **상단 8구간 현황바**, **4칸(`4열`) 동시 격상 시각 그룹 그리드**를 유지하며 닫힌 후에도 지도·카드 점멸은 지속됩니다.
7. **정기 브리핑 워킹트리 무결성 (`scripts/publish-share.py`)**
   - 매일 `08:00`·`18:00` KST GitHub Actions(`share-briefing.yml`) 실행 시 `git add` 대상(`public/share/{morning,night}.{png,json}`) 외의 파일을 수정하면 `git pull --rebase origin main`이 `exit code 128`로 실패하므로, `public/api/briefing.json` 생성은 반드시 `--write-briefing` 플래그가 명시된 경우에만 수행합니다.

---

## 3. 백엔드 API 엔드포인트 및 캐시 정책 요약

| 엔드포인트 | 원천 주기 | Worker / Pages Edge 캐시 | 비고 |
|---|---|---|---|
| `/api/road-obs?line=14` | 1분 | 메모리 `45s`, Edge `30~45s` (`Last-Good 15m` 백업) | `[1,2,3,5,8]분` 순차 탐색 |
| `/api/road-risk?roadNum=012` | 5분 | 메모리 `4m`, Edge `max-age=120, s-maxage=210` | `FRG`/`FOG` 개별 시각 추출 · 3종 공간 요약 |
| `/api/rwis/api/rwis` | 5분 | Edge `120s` · 콘존 마스터 `6h` | 5.6MB 위험표 `ReadableStream` 추출 (`FR`/`VR` 분리) |
| `/api/cctv` | 15분 | Pages/Worker Edge `15m` + Stale 백업 | ITS Open API 19개 거점 + 본선 62지점 |
| `/api/short-term-12?roster=13` | 단기 3h / 초단기 1h | **Fresh `≤4m`(:00/:35 경계) + 공유 `Last-Good 12h` SWR** | 콜드 시 공유 스냅샷 `<0.1s` 즉시 반환 + `waitUntil`/`revalidate=1` 갱신 |
| `/api/road-obs-trend?line=14&hours=6` | 30분 슬롯 | 메모리 `5m`, Edge `10m` (과거 불변 슬롯 `6h`) | 8개 구간 카드 `6h 실측 + 2h 예측` 스파크라인용 |
| `/api/road-obs-history` | 수동 호출 | 과거 불변 슬롯 메모리·Edge `6h` | 72h 제설근무 매칭·CSV 전용 (1회 ≤37슬롯 제한) |
| `/api/data-health` | 진단 호출 | Edge `45s` (`?force=1` 시 `no-store`) | 파이프라인별 개별 데드라인(`6~11.5s`) 적용 |
| `/api/briefing` & `/share/status.json` | 일 2회 (`08:00`·`18:00` KST) | `/api/briefing` Edge `30m` · `status.json` `no-store` | `200 KiB` 이하 PNG + SHA-256 해시 검증 |

---

## 4. 단계별 개발 및 개선 이력 (Changelog)

- **P0 ~ P2.5 (초기 고도화)**:
  - `rwis.js` 응답 경량화 (`188KB → 13.4KB`), 영하(`<0°C`) vs 결빙경계(`0°C`) 판정 통일, 10분 통신 단절 시 통합인증 확인 팝업(`net-health.js`), 50인치 TV 잔상방지(`tv-guard.js`), 3탭 상단 실시간 배지 통일, 6h 실측 + 2h 열관성·복사냉각 예측 인라인 스파크라인 구축.
- **P3 ~ P4-4 (플래그십 지도 · 강제 새로고침 · 실시간 정합성 일원화)**:
  - RWIS 5.6MB 스트리밍 파서 전환, 7개 관측소 카드 `2·2·1·2` 무충돌 배치 및 최하위 지시선 레이어(`map-leader-underlay`), 5분 내 2회 이상 새로고침 클릭 시 전 계층 캐시 우회(`hard=1`), `SHARED_ROAD_OBS_KEY` SSOT 도입 및 Worker 요청 간 `INFLIGHT` 미결 Promise 교착 제거(`7debf5e2`).
- **3자 정밀 감사 대응 `P0` (`STEP 1` + `STEP 2` + 도로공사 공식 격상 알림, `dc349b02`)**:
  - 단기예보 회차 역행(`17:00 → 14:00`) 차단, RWIS `0(안전)` vs `null(정보 없음)` 분리, 이정 오표기 교정(`함양IC 95.0k ~ 옥포JC 176.0k`), `FR/VR` 및 `FRG/FOG` 개별 시각 병기, 도로공사 공식 `주의`·`위험` 격상 팝업 모달 및 점멸 표시 구현.
- **`STEP 3 · STEP 4 · STEP 5` 완성 (운영 진단 · 브리핑 채널 · 72h 제설 사후분석)**:
  - `STEP 3`: `publish-share.py` `force=1` 원천 강제 조회, `/api/briefing` 실시간 Edge 캐시 엔드포인트 추가 및 `llms.txt` 정비.
  - `STEP 4`: `/api/data-health` + `/diagnostics.html` 구축 및 메인 상황판 카드 `실측` / `모델` 원천 배지 명확화.
  - `STEP 5`: `/api/road-obs-history` + `/history-72h.html` 구축 (72시간 수동 분할 조회, 예비·본살포 `T-2h / T=0 / T+2h` 기상 근거 자동 매칭, 엑셀 호환 UTF-8 BOM CSV 다운로드).
- **모바일 긴급 버그 수정 (`e24b734b`)**:
  - `diagnostics.js` + `worker.js`: 모바일 콜드 PoP에서 발생하던 `signal timed out`을 해소하기 위해 프런트엔드를 6개 개별 Edge 캐시 엔드포인트 독립 병렬·점진 렌더링으로 전환하고 `/api/data-health`에 Edge 캐시 재사용 및 파이프라인별 개별 데드라인 적용.
  - `rwis.html` + `rwis.css` + `rwis.js` + `rwis-data.js`: 모바일·태블릿(`<= 1320px`) `[⛶ 지도 크게]` 클릭 시 `100vw × 100dvh` 전체화면 인터랙티브 지도 뷰어(`340%` 세로 채움 슬라이드 · 주의/위험 구간 자동 포커스 · 핀치줌 · `↻ 가로한눈에` 90° 회전 보기 · 안드로이드 뒤로가기 연동) 구현.
- **도로살얼음 격상 알림 팝업 50인치 TV 무조작 고도화 (`cc17e290`)**:
  - 확인 버튼 `확인 (60초)` → `0초` 1분 자동 닫힘 카운트다운, 상단 8개 전 구간 노선 현황바, 4칸(`4열`) 무스크롤 그리드 및 동일 격상 시각 자동 그룹화(`ICE_ALERT_STATE_KEY`) 반영.
- **실운영 모니터링 4대 개선 및 안정판 동결 (`b31fbf0b` → `758c4723` / `v1.0.0-stable`)**:
  - **`/hourly` 공유 Last-Good 스냅샷 즉시표출(`7~11초 → 51~82ms`) + 백그라운드 SWR**: Edge 공유 `Last-Good`(`12h`) 및 브라우저 로컬 캐시(`12h`) 도입, `alignShortTermSnapshotToNow` 시간열 자동 정렬, `mixedGeneration` 시 캐시 비활성화 병목 해소.
  - **`"앞으로 6시간 (ICON 앙상블)"` 기온 괴리 해소**: `weather.js`에서 기상청 시간별 예보 기온·습도·풍속을 병합하여 상단 타임라인과 `0.0°C` 오차로 일치.
  - **기상청 `SFS` 공식 코드(`1~15`) 정립 및 `SFS=14(습기)` 오표기·적색 오경보 수정**: `14: '습기'` 정식 반영 및 위험도 순위 `surfaceSeverityRank` 적용.
  - **`morning.png`·`night.png` 정기 발행 복구 및 `"기상청 시간별예보"` 문구 통일**: `publish-share.py`의 `--write-briefing` 분리로 CI `git pull --rebase` 충돌(`exit code 128`) 근절, 공유 PNG 섹션명을 `"기상청 시간별예보"`로 통일.
  - **타 지사 전환 설계 가이드 수립 (`docs/BRANCH_MIGRATION_GUIDE.md`)** 및 `v1.0.0-stable` 보존 브랜치·태그·릴리스 생성.

---

## 5. 일상 유지보수 및 장애 대응 명령어

### 5.1 빌드 및 전체 단위 테스트 (`98개`)
```powershell
# 1. lib/bionda-core.js 또는 cloudflare/worker.js 수정 시 단독 번들 동기화 (필수)
npm run build:worker

# 2. 전체 단위 테스트 실행 (Node 20+, Windows 시스템 루트 CA 사용)
node --use-system-ca --test tests/*.test.js
```

### 5.2 `git.exe` 차단 환경에서의 배포 및 안정판 복원 (`gitless-github`)
사내 보안 정책으로 `git.exe` / `gh.exe`가 제한된 환경에서는 `gh_api_helper.py`를 사용하여 원격 커밋·푸시 및 안정판 다운로드를 수행합니다.

```powershell
# A. 변경 파일 원자적 커밋 & 푸시 (PoeticEcho/bionda)
python "$env:USERPROFILE\.gemini\config\skills\gitless-github\scripts\gh_api_helper.py" commit `
  --repo "PoeticEcho/bionda" `
  --branch "main" `
  --base-dir "c:\Download\bionda" `
  --message "유지보수 내역 요약" `
  --files "수정한파일1" "수정한파일2"

# B. 비상시 v1.0.0-stable 보존 브랜치 전체 원본 내려받기
python "$env:USERPROFILE\.gemini\config\skills\gitless-github\scripts\gh_api_helper.py" download `
  --repo "PoeticEcho/bionda" `
  --branch "release/v1.0-stable-20261127" `
  --dest "c:\Download\bionda-restore"
```
