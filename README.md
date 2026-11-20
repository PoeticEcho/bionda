# 비온다? × 날씨봇 — 고속국도 12호선(광주대구선) 도로기상·단기예보 통합 상황판

고속국도 12호선(무안광주대구선 · 고령지사 관할 중심)의 **실시간 도로기상관측(노면온도 `TR1`·노면상태 `SFS`)**, **012선 1km 단위 도로살얼음·안개 위험(5분 단위)**, **기상청 초단기·단기예보 12시간 병합 분석**, **3단계 제설·수방·교량 횡풍 의사결정**, **고령지사 관내·연계 13개 읍·면·동 1시간 단기예보 비교 상황판**을 통합 제공하는 도로관리·생활기상 웹서비스입니다.

---

## 1. 페이지 및 배포 아키텍처

| 경로 / 페이지 | 주요 역할 | 비고 |
| :--- | :--- | :--- |
| `/` (`public/index.html`, `app.js`) | **도로기상 상황판** (메인) | 최대 8개 관심지역 · 모바일 2×4 무스크롤 · PC 상하(4×2)/좌우 FHD 분할 · 미니맵 · Windy/HSR 레이더 · 공용 PNG 미리보기·저장·공유 |
| `/hourly` (`public/hourly.html`, `hourly.js`) | **1시간 단기예보 비교 상황판** | 고령지사 관내·연계 13개 읍면동 × 6h/12h(FHD 1화면)/24h/내일까지 · 강수/영하/겹침 KPI 강조 · KMA 원본형 상세표 |
| `/hero-preview` (`public/hero-preview.html`) | **상세 배너 동적 연출 검수 시안** | 주야간·9종 날씨·음력 달령·구름 투과·살얼음/한파 시뮬레이터 (운영 `index.html` 미연동 독립 검수용) |
| `/api/*` (`functions/api/[[path]].js`) | **Cloudflare Pages Functions 게이트웨이** | Service Binding(`env.API_WORKER`)으로 Worker `bionda`에 0ms 내부 RPC 전달 → 사내망 `*.workers.dev` TLS 차단 회피 |
| `cloudflare/worker.js` + `lib/bionda-core.js` | **백엔드 API 서버** | Workers & Node(`server.js`) 공통 엔진 · Single-file Quick Edit 배포용 `dist/bionda-worker.standalone.js` 생성 |

> **정적 미러링(GitHub Pages)**: `PoeticEcho/etc/bionda/` 접속 시 `public/config.js`의 `DEFAULT_API_BASE`가 자동으로 `https://bionda.pages.dev`로 연결됩니다(기존 `*.workers.dev` 저장값도 자동 마이그레이션). 백엔드 장애 시에는 정적 스냅샷(`api/snapshot.json`, `api/short-term-12.json`) + 브라우저 Direct Open-Meteo Fallback으로 무중단 동작합니다.

---

## 2. 정보 원천(Data Sources) 및 실측 vs 예보 우선순위

### 2.1 실측 관측 우선 원칙 (도로기상 상황판 현재 상태)
메인 상황판의 카드·상세 헤더에 표시되는 **현재 기온, 습도, 오늘 강수, 적설, 풍속, 시정, 노면온도, 노면상태**는 **예보 모델이 아닌 실제 관측 API**에서 우선 가져옵니다.

1. **1순위 — 기상청 고속도로 도로기상관측망 (`road_stn_obs.php?mode=2&var=14`)**
   - 원천: API허브 고속도로 노선 관측(무안광주대구선 API코드 `var=14`, 20개 관측소 매분 자료, EUC-KR 인코딩).
   - 조회 오프셋: 현재 시각 기준 `[-2분, -5분, -9분]` 순으로 재시도(지연·결측 시 직전 유효 관측소 반환).
   - 실측 필드: 대기기온(`TA`), 습도(`HM`), 광학 노면온도(`TR1`), 노면상태(`SFS`: `1 건조 / 2 습윤 / 3 수막 / 4 적설 / 5 결빙 / 6 슬러시 / 7 소금물`), 시정(`VS`), 일 누적강수(`RN_DAY`), 적설(`SD`), 풍속(`WS1`)·돌풍(`WS_INS`).
   - 매칭 규칙(`matchRoadStation`): 일반 기온(`primary`)은 유효 기온 보유 최근접 관측소, 노면온도(`nearestRoad`)는 유효 `TR1` 보유 최근접 관측소, **결빙취약교량**(KMA 분류명 `목표(결빙)`)은 동일 권역 반경 `14km` 이내에 위치하고 최근접 노면관측소 자체와 중복되지 않는 교량 집중감시 지점만 추가 병기합니다(`거창휴(도)` 권역 야로면에 24km 밖 `논공교(도)`가 오매칭되거나 현풍읍에 `논공교(도)`가 중복 표기되지 않도록 차단; 거리 `28km` 초과 시 노선 외 지역 간주).
2. **2순위 — 기상청 초단기실황 (`getUltraSrtNcst`)**
   - 반경 `28km` 내에 도로관측소가 없거나(`서울` 등 사용자 추가 지역) 도로관측소에 기온/습도가 누락된 격자(`gridNeedsNcst`)에만 **조건부 호출**하여 AWS/ASOS 실측(`T1H`, `REH`, `PTY`, `RN1`, `WSD`)을 병합합니다.
3. **3순위(Fallback) — Open-Meteo / 정적 스냅샷**
   - 관측 API(`o`)가 모두 실패한 경우에만 Open-Meteo `current` 또는 빌드 타임 스냅샷을 최후 폴백으로 사용합니다.
   - *(참고)* 도로기상관측소는 하늘 상태(운량)를 관측하지 않으므로, 강수가 없는 평소 하늘 문구(`대체로 맑음`, `구름많음` 등)는 예보 `description`/`skyLabel`을 참고합니다.

### 2.2 전체 API 원천 및 업데이트 주기·캐시 TTL 일람표

| 구분 | API 엔드포인트 / 원천 | KMA 실생산 주기 및 지연 | 백엔드 메모리 TTL | Edge / CDN 캐시(`s-maxage`) | 비고 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **도로관측(매분)** | `apihub.../road_stn_obs.php` (`var=14`) | **1분마다** 생산 (`-2/-5/-9분` 조회) | **2분** (stale 20분) | `60s / 90s` (`road-obs`, `bundle`) | 실측 노면 `TR1`·`SFS`·기온 |
| **012 도로위험기상** | `apihub.../road_file_down.php` (`roadNum=012`) | **5분마다** UTC 슬롯 ZIP (`-5/-10/-15/-20분`) | **9분** (stale 25분) | `480s / 540s` | `_1KM_FRG_`(살얼음)·`_1KM_FOG_`(안개) `0~3단계` |
| **초단기실황** | `VilageFcstInfoService_2.0/getUltraSrtNcst` | **매시 정시(`HH:00`)** · +25분 제공 | `kma\|...` **5분** | `/api/forecast` `300s` | 도로관측 결측·노선 외 지점만 호출 |
| **초단기예보** | `VilageFcstInfoService_2.0/getUltraSrtFcst` | **매시 `:30` 기준** · **`:35~:45`분 공개** | `kma\|...` **5분** | **동적 cap** (`:35` 경계 · 정시 · 미공개 시 `45s`) | `+1~+6시간` 1시간 단위 실예측 |
| **단기예보** | `VilageFcstInfoService_2.0/getVilageFcst` | **일 8회(`02,05,08,11,14,17,20,23`시)** · +20분 공개 | `kma\|...` **45분** | 정시/`35분` 경계 이하 (`max 300s`) | 오늘~모레(~48h) `TMP/POP/SKY/PTY/PCP/SNO/LGT` |
| **기상특보 + 폴리곤** | `wrn_now_data.php` + `weather.go.kr/w/rss/cap/warning.do` | 수시 발표 (특보 텍스트 + CAP XML) | `wrn` **90초** (장애 시 stale **20분**) · CAP **120초** | `55s / 90s` (`stale` 시 `30s`) | 단건(`name`) + **일괄(`places`) 1회 조회** · CAP 폴리곤 교차 판정 |
| **레이더 영상** | `apihub.../nph-rdr_cmp1_img` (HSR 합성) | **5분마다** | **4분** | `240s` (파라미터 `t` 정규화) | 매직바이트 검증 후 바이너리 응답 |
| **Open-Meteo 보조** | `/api/open-meteo` (`forecast`, `ensemble` `icon_seamless`) | 1시간 / 모델 주기 | `forecast` 5분 · `ensemble` **30분** | `300s` / `1800s` | 다중좌표 일괄 1회 호출, `429` 시 15분 쿨다운 |
| **통합 번들 (`index`)** | `/api/overview-bundle` | 요청 시 조합 | **90초** | `60s / 90s` (`force=1` 시 `no-store`) | 8지역 관측·예보·특보·도로·012위험 **1회 통합** (좌표 정렬 캐시키) |
| **13지역 단기 (`hourly`)** | `/api/short-term-12` | 요청 시 조합 | **5분** (초단기 대기 중 **45초**) | `max 300s` (정시·`:35` 초과 불가, 대기 중 **45s**) | 13개소 → 고유 **12격자** 3격자씩 분할 병렬 조회 |

---

## 3. 프론트엔드 자동 갱신 및 `[↻ 새로고침]` 강제 재조회 로직

### 3.1 도로기상 상황판 (`public/app.js`)
- **페이지 전환 0ms 로컬 캐시 · 3분 머무름 SWR (`public/page-cache.js`)**:
  - 최근 응답을 `localStorage`(`weather-watch:cache:overview:v1`) 및 백엔드 상태 캐시(`weather-watch:cache:health:v1`)에 보관합니다.
  - 단기예보 등 다른 페이지를 오갔을 때 **5분 이내·동일 KST 정시**라면 `0ms` 즉시 복원하고 불필요한 API 재호출을 생략하며, 해당 화면에 **3분 이상 머무르면** 백그라운드에서 조용히 최신화(SWR)합니다. (5분~20분 경과 또는 정시 변경 시에도 직전 값을 먼저 표출한 채 즉시 백그라운드 갱신)
- **매 5분(`300,000ms`)**: `!document.hidden`일 때 백그라운드 `refresh({ silent: true })` 실행 → `bundle`(90초 TTL) 및 `road-obs`(2분 TTL)가 만료되어 매 5분마다 **항상 최신 1분 도로관측 및 5분 도로위험**을 수신합니다.
- **매 2분(`120,000ms`)**: `!document.hidden`일 때 `pollWarnings()`가 전 지점을 `/api/warnings?places=...` **단일 일괄 호출**로 감시(직전 번들이 105초 내 이미 수신했으면 중복 생략)하고, 특보 등급 상승 시 상단 토스트 + Web Audio 경보음/기기 알림을 발동합니다.
- **탭 복귀(`visibilitychange`)**: 화면 WakeLock 재획득 + 마지막 라이브 동기화 기준 **5분 경과 또는 정시 변경 시**에만 `refresh()` 수행(짧은 탭 전환 시 중복 호출 방지).
- **상단/상세 `[↻ 새로고침]` (`refresh(true)`)**: `force=1`로 Edge·Worker 메모리 캐시(`bundle`, `road-obs`) 및 Open-Meteo `forecast` 캐시를 즉시 우회하여 재조회합니다.

### 3.2 1시간 단기예보 (`public/hourly.js`)
KMA 초단기예보는 매시 정각이 아닌 **`HH:30` 발표분(`HH:35~:45` API 공개)**으로 갱신되고 단기예보는 1시간 단위이므로, **즉시 전환 캐싱 + 3중 자동 갱신(정시 · 36분 · 10분)** 을 조합합니다.

1. **페이지 전환 0ms 로컬 캐시 · 3분 머무름 SWR**: `localStorage`(`weather-watch:cache:hourly:v1`)가 **5분 이내 · 동일 KST 정시 · 초단기 신규 발표 전**이면 즉시 렌더링해 전환 지연을 없애고, **3분 이상 머무르면** 백그라운드에서 조용히 최신화합니다.
2. **정시 롤오버 (`scheduleTopOfHourRefresh`)**: 매시 `HH:00:01.5 KST`에 `?force=1&refreshShort=1&refreshUltra=1`로 호출해 표의 시간축(`06시~` → `07시~`)을 정각에 즉시 전환(백그라운드 절전 시 `visibilitychange` + 1분 체크로 즉시 보정).
3. **초단기 신규 발표 픽업 (`scheduleUltraPickupRefresh`)**: 매시 **`HH:36:15 KST`**에 `refreshUltra=1`로 자동 호출하여 방금 공개된 `HH:30` 초단기예보를 즉시 반영.
4. **10분 주기 갱신 (`600,000ms`, visible 탭 한정)**: `isUltraUpdateDue()`(`ultraBase + 66분` 경과 여부, 예: `05:30` 자료 유지 상태에서 `06:36` 도달)를 검사해 신규 발표 시각이 지났으면 자동으로 `force=1&refreshUltra=1` 우회 조회합니다.
5. **상단 `[↻ 새로고침]` 수동 클릭 규칙 (`computeManualRefreshFlags`)**:
   - **단기예보 (`refreshShort`)**: 현재 표시된 `shortBase`로부터 **3시간(180분) 이상** 경과 시 Worker `getVilageFcst` 12격자 캐시까지 완전히 우회해 강제 재조회 (`3시간 미만`이면 Worker 격자 캐시 활용).
   - **초단기예보 (`refreshUltra`)**: 현재 표시된 `ultraBase`로부터 **10분 초과** 경과 시 Worker `getUltraSrtFcst` 12격자 캐시까지 완전히 우회해 기상청 직접 재조회 (`force=1`로 Cloudflare Edge Cache는 항상 우회).

---

## 4. 핵심 도메인 로직 및 13개/8개 기준 지점

### 4.1 8개 기본 감시 거점 (`CORRIDOR_WATCHED_PLACES`, `index.html`)
1. **대구 달성군남부**(현풍읍 `35.697, 128.447`, `(86,87)`) · 2. **함양중부**(지곡면 `35.566, 127.774`, `(74,83)`) · 3. **거창군남부**(남상면 `35.644, 127.910`, `(77,85)`) · 4. **합천군서북부**(야로면 `35.706, 128.168`, `(81,87)`) · 5. **고령군**(대가야읍 `35.728, 128.263`, `(83,87)`) · 6. **남원**(남원시청 `35.416, 127.390`, `(68,80)`) · 7. **함양**(함양읍 `35.520, 127.725`, `(74,82)`) · 8. **거창**(거창읍 `35.687, 127.910`, `(77,86)`).

### 4.2 1시간 단기예보 13개 읍·면·동 (`SHORT_TERM_12_REGIONS`, `hourly.html`)
고령지사 관내·연계 13개 읍면동을 KMA 날씨누리 공식 동네예보 대표 좌표·DFS 격자에 정합했으며, **`거창군 거창읍`과 `거창군 남하면`은 동일 격자 `(77, 86)`를 공유**하므로 실제 백엔드 API 호출은 **고유 12개 격자**만 수행합니다.
- **고령권역**: 쌍림면(`35.6768, 128.2441`), 성산면(`35.7469, 128.3621`), 대가야읍(`35.7305, 128.2679`)
- **합천권역**: 가야면(`35.762683, 128.139463`), 야로면(`35.7022, 128.1699`)
- **거창권역**: 거창읍(`35.6849, 127.9060`), 남하면(`35.6647, 127.9458`), 남상면(`35.6402, 127.9122`), 가조면(`35.7080, 128.0169`)
- **함양권역**: 수동면(`35.5191, 127.7899`), 지곡면(`35.5632, 127.7764`), 함양읍(`35.5166, 127.7288`)
- **달성권역**: 옥포읍(`35.7866, 128.4660`)

### 4.3 주요 기상·도로 판단 알고리즘
- **비·눈 시작/종료 추정 (`analyze`, `lib/bionda-core.js`)**: 초단기(`+1~6h`) 우선 + 단기(`~12h`) 병합 시계열에서 첫 `wet` 시각을 시작으로 잡고, 이후 **연속 2시간 무강수**가 확인되는 첫 시각을 종료 추정치로 판정합니다. 구간 요약(`horizonRanges`)은 `향후 3시간(1~3h)`, `3~6시간(4~6h)`, `향후 6~12시간(7~12h)` 비중복 구간으로 분리됩니다.
- **도로 살얼음·제설·수방 의사결정 (`iceOutlook`, `public/ice.js`)**: 실측 기온·습도·광학 노면온도(`bridgeRoadTemp`/`roadTemp`), Magnus 이슬점 차(`T - Td ≤ 1.5°C`), 야간 교량 복사냉각(`기온 - 3.0°C` 추정 vs 실측 최소값), 직전 24h 적설 후 재결빙(`≤ 0.5°C`)을 조합하여 **1시간 전 예비살포(`🚜`) / 3시간 전 시동·예열(`🔑`) / 본제설(`🚨`) / 수방·교량 횡풍(`🌊/💨`)** 4개 의사결정 카드를 생성합니다. (설정 `[⚙]`에서 지시 카드 표시 ON/OFF 전환 가능)
- **통합 색상 등급 (`classifySeverityTier`)**: `0 평온(청록)` → `1 관심(노랑)` → `2 지시·주의(주황)` → `3 긴급·경고(빨강: 현재 눈·심한 비≥10mm/h·살얼음 주의/012선 3단계·대설/호우/태풍 특보)`로 카드·미니맵 핀·알림을 일관 색상으로 표출합니다.
- **세부 특보구역 CAP 폴리곤 판정 (`warningMatchesPlace`)**: KMA 특보 `함양서북부` 등 세부 구역 문자열만으로는 `함양중부(지곡면)` 포함 여부를 가릴 수 없으므로 날씨누리 CAP XML 폴리곤 좌표를 ray-casting(`inPolygon`)으로 검사해 오매칭을 차단합니다.
- **누락·부분결측 방어 (`collectShortTerm12`, `alignHourlyMatrix`)**: 병렬 조회 중 누락된 격자는 3개 단위 1회 보완 재시도하고, 전 격자의 `+1h` 시프트 여부를 `uniformStartK`로 통일합니다. 프론트엔드는 전 지역 시간 키 합집합을 기준으로 열을 고정하고 누락 지역/시간대는 `.is-missing` 플레이스홀더(`자료 누락` / `— 미수신`)로 채워 첫 행이 비어도 테이블 격자가 깨지지 않습니다.

---

## 5. 해결 완료된 주요 이슈 및 유지보수 주의사항 (필독)

운영·개발 중 실제 발생했던 이슈와 재발 방지를 위한 핵심 체크포인트입니다.

1. **`workers.dev` 사내망 차단 대응 (`Pages Functions` 프록시 + 정적 자산 패스스루)**
   - *이슈*: 사내·기관 네트워크 방화벽에서 `*.workers.dev` TLS 연결이 차단되나 Cloudflare `*.pages.dev`는 정상 통과함. 단, 초기 `[[path]].js`가 `/api/*` 전체를 Worker로 넘겨 `public/api/*.json`·`radar.png` 정적 스냅샷이 `bionda.pages.dev`에서 `404`가 되는 문제가 있었음.
   - *해결*: [`functions/api/[[path]].js`](functions/api/%5B%5Bpath%5D%5D.js)가 정적 자산 확장자(`.json`, `.png`, `.jpg` 등)는 `context.next()`로 통과시키고 동적 API만 Service Binding(`env.API_WORKER`)으로 Worker `bionda`에 0ms 내부 RPC 전달합니다. `DEFAULT_API_BASE`는 `https://bionda.pages.dev`를 기본 사용합니다.
2. **Cloudflare Workers 무료 한도(6 동시연결 · 50 서브요청 · 일 10만 req) & 타임아웃 연쇄 방어**
   - *이슈*: ① 콜드 조회 시 6개 초과 동시 아웃바운드 연결이 큐에서 대기하다 5초 타임아웃에 걸리고, ② ApiHub 전용 키로 `data.go.kr` HTTP 403 폴백을 불필요하게 재시도하며, ③ `pollWarnings()`가 분당 8회 호출 + `502` 시 CAP 18 XML 연쇄 호출을 유발함.
   - *해결*: ① `collectShortTerm12`(`3격자` 단위) 및 `fetchOverviewBundle`(`2격자` 단위) 분할로 6연결 한도 내 타임아웃 방지, ② ApiHub 키의 `data.go.kr` `401/403` 응답 60분 스킵 캐싱 + KMA 직전 수신 `kma-stale`·특보 `wrn-now` 20분 stale 복원, ③ 특보 `/api/warnings?places=...` **1회 일괄 통합 + 2분 주기**(CAP fallback 3분 쿨다운) 및 `/api/overview-bundle`·`places` 좌표 정렬 정규화로 Edge 캐시 공유율 극대화, ④ 프런트 `overview-bundle`/`short-term-12` 타임아웃을 `26초`로 상향해 콜드 완료 전 조기 중단(`status: 0`) 차단.
3. **`hourly`와 기상청 날씨누리 단기예보 값 차이**
   - *이슈*: 단기예보(`getVilageFcst`, 3시간마다 발표)만 사용하면 향후 6시간 이내 기온·강수가 날씨누리 상세 화면과 다름.
   - *해결*: 날씨누리처럼 `+1~+6시간` 구간은 **`getUltraSrtFcst`(초단기예보)** 를 우선 덮어쓰고, 전 격자 시작 시각을 `uniformStartK`로 맞췄습니다.
4. **KMA 초단기 발표 시차(`:30` 발표 / `:35~:45` API 반영) 체감 오해 & 캐시 고착**
   - *이슈*: 예를 들어 `06:26` 조회 시 `초단기 05:30`이 뜨고, `:35` 직후 KMA 반영이 몇 분 지연될 경우 Worker 5분 캐시가 직전 fallback(`05:30`)을 계속 붙잡을 수 있음. 또한 `[새로고침]`(`force=1`) 시 `fetchKma` 내부 격자 캐시를 우회하지 않던 문제가 있었음.
   - *해결*: ① 미반영 fallback 응답은 캐시 TTL `45초`로 단축하고 `Cache-Control`이 `:35` 경계를 넘지 못하도록 제한, ② 매시 `HH:36:15` 자동 픽업 타이머 + `66분` 경과 자동 우회, ③ `[새로고침]` 시 **단기≥3시간(`refreshShort=1`) · 초단기>10분(`refreshUltra=1`)** 기준 `fetchKma` 내부 격자 캐시까지 직접 우회하도록 수정했습니다.
5. **특정 지역(예: 0번 행 `쌍림면`) 일시 누락 시 `hourly` 테이블 1열 붕괴**
   - *이슈*: `regions[0].hours` 길이를 그대로 `--hr-cols`로 쓰다 0번 행이 빈 배열일 때 전체 표가 1열로 무너짐.
   - *해결*: `alignHourlyMatrix()`가 13개 지역의 타임스탬프 합집합으로 열 수를 산정하고 결측 칸을 `.is-missing`으로 패딩합니다.
6. **`bionda-core.js` / `worker.js` 수정 후 Standalone 번들 동기화 필수**
   - *주의*: Cloudflare Quick Edit용 [`dist/bionda-worker.standalone.js`](dist/bionda-worker.standalone.js)는 빌드 산출물입니다. **`lib/bionda-core.js` 또는 `cloudflare/worker.js`를 수정한 뒤에는 반드시 `npm run build:worker`를 실행**해야 `worker.test.js` 및 단독 배포본이 최신 상태를 유지합니다.
7. **기업망 TLS 환경 및 `git.exe` 제한 환경 주의**
   - Windows 기업 프록시 환경에서 Node `fetch` 실행 시 루트 인증서 검증을 위해 `--use-system-ca` 플래그를 사용합니다(`package.json`의 `dev`/`test`/`snapshot` 스크립트 반영됨).
   - 동일 HTML 내에 여러 동적 SVG(`hero-scenes.js`)를 렌더링할 때는 `<linearGradient>`/`<clipPath>` ID 충돌을 막기 위해 반드시 인스턴스별 고유 ID 접두사(`uid`)를 유지해야 합니다.

---

## 6. 환경변수(Secrets), 로컬 실행 및 테스트

> **보안 원칙**: 모든 API 인증키는 코드·HTML·`localStorage`·Git 저장소에 절대 저장하지 않고 서버 환경변수(Secrets)로만 관리합니다. API허브(`apihub.kma.go.kr`) 통합 키 1개를 `KMA_SERVICE_KEY`에 등록하면 단기예보·초단기·도로관측(`var=14`)·도로위험(`roadNum=012`)·특보·HSR 레이더에 공용 적용됩니다.

| 환경변수 이름 | 필수 여부 | 설명 |
| :--- | :--- | :--- |
| `KMA_SERVICE_KEY` | **필수** | 기상청 API허브 인증키 또는 공공데이터포털 단기예보 서비스키 |
| `KMA_RADAR_KEY` | 선택 | 레이더 HSR 별도 키 (미입력 시 `KMA_SERVICE_KEY` 자동 공용) |
| `KMA_ROAD_KEY` | 선택 | 도로기상관측·012 위험기상 별도 키 (미입력 시 `KMA_SERVICE_KEY` 자동 공용) |
| `ROAD_LINE_CODE` | 선택 | 고속도로 API 노선 코드 (기본 `14` = 무안광주대구선) |
| `CORS_ORIGINS` | 선택 | 외부 정적 호스팅 허용 오리진 (예: `https://poeticecho.github.io`) |

```powershell
# 1. 개발 서버 실행 (.env는 .gitignore 제외)
npm run dev

# 2. Cloudflare Worker 단독 배포용 번들 재생성 (core/worker 수정 시 필수)
npm run build:worker

# 3. 전체 단위 테스트 실행 (API 모킹 · 핵심 로직 · 살얼음 · 13개소 · Worker · 히어로 시안)
npm test

# 4. 정적 폴백 스냅샷 재생성
npm run snapshot
```

## 아침·저녁 공유 PNG

봇은 한국시간 아침에 [morning.png](https://bionda.pages.dev/share/morning.png), 저녁에 [night.png](https://bionda.pages.dev/share/night.png)를 받습니다. 각각 8개 관심지역의 도로 현황과 13개 지역의 12시간 예보를 한 장에 담습니다. 파일에는 조회 시각과 기상청 발표 시각이 표시됩니다. 같은 회차를 반복 확인할 때는 응답의 ETag로 조건부 GET을 사용할 수 있습니다.

GitHub Actions가 매일 08:00과 18:00 KST에 생성을 예약합니다. 오전에는 당일 08시 단기예보, 저녁에는 17시 단기예보 발표를 확인합니다. 자료가 지연되면 예보 조회를 3분 간격으로 재시도하고, 생성에 실패하면 직전 파일을 유지합니다. 예약 실행과 Pages 배포에는 지연이 생길 수 있습니다. 워크플로 이름은 `Publish road weather PNG`이며 수동 실행도 가능합니다. 이미지 커밋에는 저장소의 Actions 쓰기 권한이 필요합니다.

대시보드·개별 지점·시간별예보 페이지의 공유 버튼은 현재 열린 자료로 브라우저에서 PNG를 만듭니다. 개별 지점 이미지는 요청한 브라우저에서만 생성합니다.
