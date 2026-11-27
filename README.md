# 비온다? × 날씨봇 — 고속국도 12호선(광주대구선) 도로기상·도로살얼음·단기예보 통합 관제 시스템

한국도로공사 고령지사 관할 **고속국도 제12호선 광주대구선(`함양IC 95.0k ~ 옥포JC 176.0k`, 서쪽 선행 감시 `남원 50.0k~` 포함)**의 **실시간 도로기상관측(노면온도 `TR1` · 공식 노면상태 `SFS`)**, **기상청 RWIS 및 012선 1km 단위 도로살얼음·안개 위험정보(5분 주기)**, **한국도로공사 공식 대응지침 기반 주의·위험 격상 알림**, **13개 읍·면·동 1시간 초단기·단기예보**, **3단계 제설·수방·교량 횡풍 의사결정**, **72시간 제설근무 사후분석·CSV 추출**을 통합 제공하는 24×7 상황실 TV · 모바일 겸용 웹 시스템입니다.

- **운영 주소 (Primary · Cloudflare Pages + Worker)**: https://bionda.pages.dev
- **백업 미러 (Mirror · GitHub Pages)**: https://poeticecho.github.io/etc/bionda/
- **관련 기술 문서**:
  - 유지보수·불변식·변경 이력서: [`docs/MAINTENANCE_HISTORY.md`](docs/MAINTENANCE_HISTORY.md)
  - 타 지사 전환(Multi-Branch) 설계 가이드: [`docs/BRANCH_MIGRATION_GUIDE.md`](docs/BRANCH_MIGRATION_GUIDE.md)
  - ITS/로드플러스 CCTV 연동 안내: [`README_cctv.md`](README_cctv.md)

---

## 1. 전체 화면 구성 및 배포 아키텍처

| 경로 / 파일 | 화면 및 역할 | 주요 특징 |
| :--- | :--- | :--- |
| `/` (`public/index.html`, `app.js`) | **도로기상 상황판** (메인) | 8개 관심지역 실황·예보·특보 카드 · 노선 미니맵(`minimap.js`) · 11개 도로관측소 스트립 · Windy/KMA 레이더/인근 CCTV · 지역 상세(`#region/...` 12h 타임라인 + ICON 앙상블 6h + 살얼음·제설 지시카드) |
| `/hourly` (`public/hourly.html`, `hourly.js`) | **1시간 단기예보 비교 상황판** | 관내·연계 13개 읍·면·동 × 6h/12h/24h(기본)/내일까지 매트릭스 · **Edge 공유 `Last-Good` 스냅샷 `<0.1s` 즉시표출 + 백그라운드 SWR** · 강수/영하/동시겹침 KPI 셀 강조 |
| `/rwis` (`public/rwis.html`, `rwis.js`) | **도로살얼음 상황판** (50인치 TV · 모바일) | **50인치 TV `1920×1080` 무스크롤** 단일 화면 · 8개 콘존 양방향 살얼음(`FSM`)/안개(`VIR`) 지도 · 7개 관측소 콜아웃(`2·2·1·2`) · 13개소 기온 배지 · `6h 실측 + 2h 예측` 스파크라인 · 62지점 CCTV · **모바일 `[⛶ 지도 크게]` 전체화면 확대·90° 회전 뷰어** |
| `/diagnostics.html` (`public/diagnostics.js`) | **데이터 파이프라인 건전성 진단** | 도로관측(1분)·012선 위험ZIP(5분)·RWIS(`FR/VR`)·13개소 예보·특보·브리핑 6대 채널 개별 병렬 점검 및 **도로공사 주의(2)·위험(3) 격상 알림·차임벨 시뮬레이터** |
| `/history-72h.html` (`public/history-72h.js`) | **72시간 제설근무 매칭 · CSV 추출** | 평시 API 호출 `0`(수동 클릭 시에만 37슬롯 이하 분할 조회) · 예비살포·본살포 투입 시각 기준 **`T-2h → T=0 → T+2h`** 대기·노면온도·노면상태 자동 매칭 분석 및 **엑셀 한글 호환 UTF-8 BOM CSV** 다운로드 |
| `/share/*` (`share.js`, `publish-share.py`) | **08시·18시 정기 브리핑 채널** | 매일 `08:00`·`18:00` KST 자동 생성 (`morning.png`, `night.png`, `/share/status.json`, `/api/briefing`, [`llms.txt`](public/llms.txt)) |
| `/api/*` (`functions/api/[[path]].js` + `cloudflare/worker.js`) | **동일 도메인 API 게이트웨이 & 백엔드** | Cloudflare Pages Service Binding(`env.API_WORKER`)으로 사내 방화벽 `*.workers.dev` 차단 우회 · 단독 배포용 `dist/bionda-worker.standalone.js` 지원 |

---

## 2. 데이터 원천(Data Sources) 및 정합성 원칙

### 2.1 실측 관측 우선 원칙 및 공식 `SFS` 노면상태 코드
메인 상황판·도로살얼음 상황판·격상 팝업에 표시되는 **현재 기온, 습도, 노면온도, 노면상태, 시정, 강수, 풍속**은 예보 모델이 아닌 **실제 관측 API**를 최우선 반영합니다.

1. **1순위 — 기상청 고속도로 도로기상관측망 (`road_stn_obs.php?mode=2&var=14`)**
   - 원천: 기상청 API허브 무안광주대구선(`var=14`, EUC-KR 인코딩, 매 1분 생산).
   - 조회 오프셋: 현재 시각 기준 **`[-1분, -2분, -3분, -5분, -8분]`** 순차 탐색으로 현장 관측과 1~2분 내 동기화하며, `SHARED_ROAD_OBS_KEY` 단조 증가(Monotonic) 규칙으로 탭 간 온도 역전을 원천 차단합니다.
   - **기상청 공식 `SFS` 노면상태 코드 전종 반영 (`SURFACE_STATES`, `lib/bionda-core.js`)**:
     - `01` 건조 · `02` 습윤 · `03` 적설 · `04` 결빙 · `05` 서리 · `06` 슬러시 · `07` 습윤(제설제)
     - `10` 저시정 · `11` 수막 · `12` 화학습윤 · `13` 임계습윤 · **`14` 습기(Damp)** · `15` 눈·결빙
     - 영상 온도에서 `14(습기)`나 `10(저시정)`이 결빙 적색 경보로 오표출되지 않도록 분리하고, 저온(`노면 ≤ 2.0°C · 대기 ≤ 4.0°C`)에서 수분 코드가 감지될 때만 예비살포 조건으로 판정합니다. 복수 관측소 구간은 코드 번호 크기가 아닌 **실제 위험도 순위(`surfaceSeverityRank`)**로 대표 상태를 선정합니다.
   - 결빙취약교량(`목표(결빙)`): 반경 `14km` 이내이면서 최근접 노면관측소와 중복되지 않는 교량 센서만 보조 병기합니다(반경 `28km` 초과 시 노선 외 지역 처리).
2. **2순위 — 기상청 초단기실황 (`getUltraSrtNcst`)**
   - 반경 `28km` 내 도로관측소가 없거나 기온·습도가 결측인 격자에만 조건부 호출해 불필요한 상류 호출을 절감합니다.
3. **시간별 기온 정합성 (`ICON 앙상블` 6시간 표 ↔ 기상청 타임라인)**
   - 상세 화면 `"앞으로 6시간 (ICON 앙상블)"` 표는 비/눈 멤버 확률(`rain ≥ 0.1mm`, `snowfall ≥ 0.1cm`)만 ICON 앙상블에서 가져오고, **기온·습도·풍속·강수확률은 기상청 초단기·단기예보로 동기화**하여 상단 타임라인과의 야간 산간 복사냉각 기온 괴리를 원천 제거했습니다.

### 2.2 전체 API 엔드포인트 및 캐시 정책 일람표

| 구분 | API 경로 / 상류 원천 | 원천 생산 주기 | Worker 메모리 / Edge 캐시 정책 | 비고 |
| :--- | :--- | :--- | :--- | :--- |
| **도로관측(실측)** | `/api/road-obs?line=14` (`road_stn_obs.php`) | **1분** | 메모리 `45s` · Edge `30~45s` + `Last-Good 15m` | 고령지사 본선 7개소 + 서쪽 선행 4개소 |
| **도로관측 6h 추세** | `/api/road-obs-trend?line=14&hours=6` | 30분 슬롯 + 최신분 | 메모리 `5m` · Edge `10m` (과거 슬롯 `6h`) | 구간 카드 `6h 실측 + 2h 예측` 스파크라인 |
| **도로관측 72h 이력** | `/api/road-obs-history` | 수동 호출 전용 | 과거 불변 슬롯 메모리·Edge `6h` | 1회 최대 37슬롯 청크 분할 · 평시 호출 `0` |
| **012선 도로위험 ZIP** | `/api/road-risk?roadNum=012` (`road_file_down.php`) | **5분** | 메모리 `4m` · Edge `120~210s` (stale `25m`) | `0(안전)` vs `null(정보 없음)` 분리 · `FRG/FOG` 개별 시각 · 3단계 공간 스코프 |
| **RWIS 콘존 등급** | `/api/rwis/api/rwis` (`rwis.kma.go.kr`) | **5분** | Edge `120s` (콘존 마스터 `6h`) | 5.6MB 위험표 `ReadableStream` 경량 추출 (`FR`/`VR` 개별 시각) |
| **고속도로 CCTV** | `/api/cctv` & `/api/rwis/api/stream` | 15분 / 실시간 | 목록 `15m` · 로드플러스 HLS `2m` | ITS Open API + 로드플러스 실시간 스트림 |
| **단기·초단기 단건** | `/api/forecast` (`getUltraSrtFcst` + `getVilageFcst`) | 초단기 매시 `:35` / 단기 일 8회(`+11m`) | 초단기 `5m` · 단기 `45m` (`kma-stale` 역행 방지) | `+1~6h` 초단기 우선 + `~12h` 단기 병합 |
| **13개소 시간별예보** | `/api/short-term-12?roster=13` | 초단기 1h / 단기 3h | **Fresh `≤4m`(:00/:35 경계) + 공유 `Last-Good 12h` SWR** | 콜드 만료 시에도 공유 스냅샷 **`<0.1s` 즉시 반환** 후 백그라운드 최신화 |
| **통합 번들 (`index`)** | `/api/overview-bundle` | 요청 시 조합 | 메모리 `45s` · Edge `30~45s` | 8개 관심지역 관측·예보·특보·012위험 단일 호출 |
| **기상특보 + 폴리곤** | `/api/warnings` (`wrn_now` + CAP XML) | 수시 | `90s` (장애 시 stale `20m`) · CAP `30m` | 다중 지점 `places` 1회 일괄 조회 + CAP 폴리곤 판정 |
| **건전성·브리핑** | `/api/data-health`, `/api/briefing`, `/share/status.json` | 진단 시 / 일 2회 | `data-health 45s` · `briefing 30m` · `status no-store` | 파이프라인 불변식 점검 및 외부 봇 브리핑 |

---

## 3. 상황실 운영 UX · 자동 갱신 · 한국도로공사 공식 격상 알림

### 3.1 한국도로공사 도로살얼음 `주의`·`위험` 격상 알림 모달 (`public/ice-alert-modal.js`)
한국도로공사 「기상청 도로살얼음 위험정보 대응방법 변경알림」 공식 기준에 맞춰 고령지사 관할(`함양IC 95.0k ~ 옥포JC 176.0k`, 8개 구간) 등급이 상향(`0/1 → 2/3` 또는 `2 → 3`)되면 즉시 차임벨과 함께 상황실 TV 최적화 팝업을 표출합니다.
- **주의(2단계) 격상**: `⬆ 도로살얼음 위험정보 주의 격상 알림` — *"온도, 노면상태 확인 후 예비살포"* + 해당 구간 고정식 기상관측소 실시간 `[관측소] 대기온도 · 노면온도 · 노면상태` 병기 + 지도·구간카드 주황 점멸.
- **위험(3단계) 격상**: `⬆ 도로살얼음 위험정보 위험 격상 알림` — *"예비살포 실시 (선예비살포 후상황판단회의)"* + 지도·구간카드 적색 점멸.
- **50인치 상황실 TV 무조작 최적화**:
  1. **1분(`60초`) 자동 닫힘 카운트다운**: `확인 (60초)` → `59초` → … → `0초` 도달 시 마우스 클릭 없이도 자동으로 닫히며, 닫힌 뒤에도 지도·카드 점멸은 해제 시까지 계속 유지됩니다.
  2. **8개 전 구간 상단 노선 현황바 + 4칸(`4열`) 무스크롤 그리드**: 스크롤 없이 단일 화면(`4×1` 또는 `4×2`)에서 전체 발효 구간을 한눈에 확인합니다.
  3. **동일 격상 시각 자동 그룹화 (`ICE_ALERT_STATE_KEY`)**: 같은 시각에 격상된 구간들을 하나의 시각 헤더로 묶고 신규 격상과 기존 발효 유지를 구분합니다.

### 3.2 스마트 캐싱 및 2단계 강제 새로고침 (`public/page-cache.js`)
- **`/hourly` 즉시 표출**: 브라우저 `localStorage`(`12시간`) 및 Cloudflare Edge 공유 `Last-Good` 스냅샷(`12시간`)을 통해 첫 진입·재방문 모두 직전 성공 스냅샷을 먼저 즉시 렌더링하고 백그라운드에서 최신 KMA 발표분으로 무중단 교체합니다.
- **2단계 수동 새로고침 (`registerManualRefreshClick`)**:
  - **1회 클릭**: 로컬 캐시를 갱신하며 서버 공유 캐시를 활용하는 스마트 새로고침.
  - **5분 내 2회 이상 연속 클릭 (`hard=1`)**: 브라우저·Edge·Worker 메모리의 전 계층 캐시를 모두 우회해 기상청·ITS 원천 데이터를 즉시 강제 재수신(`⚡ 강제갱신` 배지 표시).
- **24×7 상황실 보호 장치**: 10분 이상 연속 통신 실패 시 중앙 **`! 통합인증 로그인을 확인해 주세요`** 안내 모달(`net-health.js`)을 표출하며, 50인치 TV 번인 방지를 위해 3분 주기 미세 픽셀 시프트·휘도 보호(`tv-guard.js`)가 기본 작동합니다.

---

## 4. 관할 기준 지점 요약 (고령지사 프로파일)

- **관할 이정 범위**: 고속국도 제12호선 광주대구선 **`함양IC(95.0k) ~ 옥포JC(176.0k)`** (8개 RWIS 콘존 `160~230`, 7개 본선 도로기상관측소 `함양 95.0k · 죽산천교 102.9k · 남상졸음 115.3k · 거창휴 134.1k · 양전교 158.2k · 논공휴 169.2k · 논공교 171.3k`) + 서쪽 선행 감시(`남원주차장 50.8k ~ 옥계1교 86.2k`).
- **메인 상황판 8개 거점 (`presets`)**: `대구 달성군남부(현풍읍)`, `함양중부(지곡면)`, `거창군남부(남상면)`, `합천군서북부(야로면)`, `고령군(대가야읍)`, `남원(선행)`, `함양(함양읍)`, `거창(거창읍)`.
- **1시간 단기예보 13개 읍·면·동 (`SHORT_TERM_12_REGIONS`, 서→동 노선순)**: `함양읍 → 지곡면 → 수동면 → 거창읍 → 남상면 → 남하면 → 가조면 → 가야면 → 야로면 → 쌍림면 → 대가야읍 → 성산면 → 옥포읍` (`거창읍`·`남하면` 동일 격자 `(77,86)` 공유로 고유 `12개 격자` 호출).
- *(타 지사로 전환·확장할 때의 데이터 선정 절차는 [`docs/BRANCH_MIGRATION_GUIDE.md`](docs/BRANCH_MIGRATION_GUIDE.md)를 참고하세요.)*

---

## 5. 환경변수(Secrets), 로컬 실행 및 테스트

> **보안 원칙**: 모든 인증키는 코드·HTML·`localStorage`·Git 저장소에 절대 평문 저장하지 않고 서버 환경변수(Cloudflare Secrets / 로컬 `.env`)로만 주입합니다.

| 환경변수 이름 | 필수 여부 | 설명 |
| :--- | :--- | :--- |
| `KMA_SERVICE_KEY` | **필수** | 기상청 API허브 인증키 (단기·초단기·실황·특보·레이더·도로관측 공용 가능) |
| `KMA_ROAD_KEY` | 선택 | 도로기상관측(`road_stn_obs`)·도로위험(`road_file_down`) 별도 키 (미지정 시 `KMA_SERVICE_KEY` 사용) |
| `KMA_RADAR_KEY` | 선택 | 레이더 합성영상 별도 키 (미지정 시 `KMA_SERVICE_KEY` 사용) |
| `ROAD_LINE_CODE` | 선택 | 기상청 도로관측 노선코드 (기본값 `"14"` = 무안광주대구선) |
| `ITS_API_KEY` | 선택 | 국토교통부 국가교통정보센터(ITS) 고속도로 CCTV Open API 인증키 |
| `CCTV_SOURCE_URL` | 선택 | `openapi.its.go.kr:9443` 포트 제한 시 외부 CCTV JSON 미러 URL |
| `RWIS_SOURCE_URL` | 선택 | 사전 추출된 경량 RWIS JSON 미러 URL (미지정 시 `rwis.kma.go.kr` 스트리밍 파싱) |
| `CORS_ORIGINS` | 선택 | 외부 정적 미러 허용 오리진 (예: `https://poeticecho.github.io`) |

```powershell
# 1. 로컬 개발 서버 실행 (Node 20+, 시스템 루트 CA 사용)
npm run dev

# 2. Cloudflare Worker 단독 배포용 번들 재생성 (lib/bionda-core.js 또는 cloudflare/worker.js 수정 시 필수!)
npm run build:worker

# 3. 전체 자동화 단위 테스트 실행 (98개 테스트)
npm test

# 4. 정적 폴백 스냅샷 재생성
npm run snapshot
```

---

## 6. 아침(08시) · 저녁(18시) 정기 브리핑 PNG

- 외부 메신저·수집 봇은 [`llms.txt`](https://bionda.pages.dev/llms.txt) 규격에 따라 [`/share/status.json`](https://bionda.pages.dev/share/status.json)을 먼저 조회합니다(`08:00~18:00` KST = `morning`, `18:00~익일 08:00` KST = `night`).
- GitHub Actions([`.github/workflows/share-briefing.yml`](.github/workflows/share-briefing.yml))가 매일 **`08:00 KST` (`0 23 * * *`)**와 **`18:00 KST` (`0 9 * * *`)**에 [`scripts/publish-share.py`](scripts/publish-share.py)를 실행해 `public/share/{morning,night}.{png,json}`(`200 KiB` 이하 정량화 PNG + SHA-256 영수증, 섹션명 `"기상청 시간별예보"`)을 자동 커밋·배포합니다.
  - **유지보수 주의**: CI의 `git pull --rebase origin main` 단계에서 비스테이징 파일 충돌(`exit code 128`)이 발생하지 않도록 `publish-share.py`는 기본 실행 시 `public/share/*`만 갱신하며, `public/api/briefing.json` 갱신이 필요할 때만 `--write-briefing` 플래그를 명시합니다.
