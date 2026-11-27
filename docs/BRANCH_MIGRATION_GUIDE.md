# 타 지사 전환(Multi-Branch Migration) 기술 검토 및 설계 가이드

> 본 문서는 현재 **한국도로공사 고령지사(고속국도 제12호선 광주대구선 · 함양IC `95.0k` ~ 옥포JC `176.0k`)** 기준으로 최적화된 `bionda` 시스템을 향후 **다른 지사(단일 노선 또는 복수 노선 관할 지사)**로 전환·확장할 때 필요한 데이터 선정 절차, 기상청·ITS 원천 코드 조회법, 코드베이스 내 수정 지점, 표준 프로파일 스키마, 그리고 검증 체크리스트를 정리한 영구 기술 기준서입니다.
> - 관련 문서: [`README.md`](../README.md) · [`docs/MAINTENANCE_HISTORY.md`](MAINTENANCE_HISTORY.md)

---

## 1. 지사 전환 전체 흐름도

```
[1. 관할 노선·이정 확정]  본선·지선 고속국도 번호 및 지사 관할 시·종점(km) + 상류 선행감시 범위 설정
          │
          ▼
[2. 기상청 3종 코드 매핑]  ① 도로관측(var 코드·stnId) ② 위험기상 ZIP(roadNum 3자리) ③ RWIS 콘존(0120CZE...)
          │
          ▼
[3. 예보·특보 거점 선정]   ① 단기예보 10~15개 읍·면·동(고유 격자 ≤15) ② 특보 8개 거점(CAP 세부구역+선행지점)
          │
          ▼
[4. 구간별 CCTV 연계]     국토부 ITS 경위도 박스 추출 + 로드플러스 cctvId 매칭 + 단거리 콘존 인접 카메라 연결
          │
          ▼
[5. 2종 지도 다시 그리기]  통계청 시·군 경계 추출 + 남북 노선 주축 회전 투영(Rotated Projection) + 라벨 무충돌 배치
          │
          ▼
[6. 검수 및 프로파일 배포] 98개 단위 테스트 · 1920×1080 TV 무스크롤 · 모바일 전체화면 지도 · 08/18시 브리핑 검수
```

---

## 2. 지사 전환 시 선정해야 할 6대 핵심 데이터 상세 기준

| 순서 | 항목 | 확인 원천 (공공 API / 현장 자료) | 현행 고령지사 기준값 | 전환 시 핵심 점검 포인트 |
|:---:|---|---|---|---|
| **1** | **관할 노선 및 이정 범위** | 도로공사 지사 관할도 (본선 + 지선 여부, 기점·종점 `km`) | 광주대구선(`012`) 본선 단일<br>관할 `함양IC(95.0k)~옥포JC(176.0k)` + 선행 `남원(50.0k~)` | **2개 이상 노선**(본선+지선, JC 교차선) 관할 지사는 단일 코드가 아닌 `routes[]` 배열로 정의 필요 |
| **2** | **단기·초단기예보 행정구역 (`10~15개소`)** | 기상청 날씨누리 동네예보 (`weather.go.kr/w/rest/zone/dong.do`) 공식 행정동 대표 위경도 | `함양읍`~`옥포읍` 서→동 13개 읍·면·동 (거창읍·남하면 격자 공유로 고유 `12격자`) | Cloudflare Workers 동시 연결(`6개`)·서브요청(`50개`) 한도 준수를 위해 **고유 DFS 격자(`nx, ny`) 기준 10~15개 이내** 유지 권장 |
| **3** | **기상특보 감시 지점 (`8개소` + CAP 세부구역)** | 기상청 `wrn_now_data.php` + 날씨누리 CAP XML 폴리곤 (`kma-cap`) | `함양중부`, `거창군남부`, `합천군서북부`, `고령군`, `대구 달성군남부` + 선행 `남원` 등 `8개소` | **`OO산지`·`OO평지`·`OO서북부/남부`** 등 세부 특보구역 폴리곤 내부에 실제 고속도로 본선 좌표가 들어가는지 검증 + **상류 선행 지점 1~2곳** 필수 포함 |
| **4** | **기상청 3종 도로기상 코드 매핑** | ① `road_stn_obs.php` (`var` 노선코드, `stnId`)<br>② `road_file_down.php` (`roadNum` 3자리)<br>③ `rwis.kma.go.kr` (`0120CZE...` 콘존 ID) | ① `var=14` (`14206`~`14410` 7개소 + 선행 4개소)<br>② `roadNum=012`<br>③ `0120CZE/S` `160~230` (8구간) | **가장 주의할 지점**: 고속국도 노선번호(`12호선`)와 기상청 도로관측 노선코드(`var=14`)는 번호 체계가 전혀 다름! 반드시 사전 대조 필수 |
| **5** | **RWIS 구간별 연계 CCTV** | 국토부 ITS Open API(`openapi.its.go.kr:9443/cctvInfo`) + 로드플러스 `cctvId` | 경위도 박스 내 본선 62지점(123대 카메라) + 주요 매칭 거점 19개소 | **결빙취약교량 → 터널 갱구 → 고개 정상 → 휴게소·IC/JC** 순 우선 매칭. 자체 CCTV가 없는 짧은 콘존(`동고령IC~고령JC 1.47km` 등)은 `nearZones`로 인접 구간 카메라 연결 |
| **6** | **노선 미니맵(`index`) 및 RWIS 대화면 지도(`rwis`)** | 통계청 시·도/시·군 경계(`southkorea-maps`) + 노선 중심선 좌표열(`km, lat, lon`) | `public/route12.js`, `public/minimap.js`, `public/rwis-data.js` (`RWIS_ROUTE_GEO`, `dock`, `dx/dy`) | **남↔북 종단 노선**(경부·중부내륙·서해안·중앙선 등)은 가로형(`1600×700`) TV 캔버스에 맞도록 **주축 회전 투영(Rotated Projection)** 적용 권장 |

---

## 3. 신규 지사 원천 코드 5분 추출 가이드 (사전 조사 방법)

새 지사 관할 노선의 기상청·RWIS·ITS 식별자는 아래 방법으로 즉시 조회할 수 있습니다.

1. **기상청 도로기상관측 `var` 노선코드 및 관측소(`stnId`) 확인**:
   - API허브 `https://apihub.kma.go.kr/api/typ01/url/road_stn_obs.php?mode=2&var=<번호>&help=1&authKey=<키>` 호출 시 노선별 전체 관측소 ID(`stnId`), 관측소명, 위경도, 고도, 센서 유형(`일반` / `목표(결빙)` / `거점`)이 출력됩니다.
2. **기상청 도로위험기상 ZIP `roadNum` 및 1km 링크 확인**:
   - `road_file_down.php`의 노선번호는 고속국도 공식 노선번호 3자리(`경부 001`, `남해 010`, `광주대구 012`, `서해안 015`, `익산포항 020`, `호남 025`, `논산천안 025`, `순천완주 027`, `당진영덕 030`, `중부 035`, `제2중부 037`, `평택제천 040`, `중부내륙 045`, `영동 050`, `중앙 055`, `서울양양 060`, `동해 065` 등)를 사용하며, 압축 내 CSV의 이정(`km`) 컬럼으로 지사 관할 구간 링크 수를 검증합니다.
3. **기상청 RWIS 콘존(`Conzone`) 목록 확인**:
   - `https://rwis.kma.go.kr/map/getConZoneByRoadNo.do`에서 해당 노선의 콘존 ID(예: `0120CZE160` = 대구방향, `0120CZS160` = 광주방향)와 IC~IC 구간명·이정을 추출하여 [`ZONE_INTEGRATION_MAP`](../public/rwis-data.js)을 구성합니다.
4. **국토부 ITS 고속도로 CCTV 목록 추출**:
   - `https://openapi.its.go.kr:9443/cctvInfo?apiKey=<키>&type=ex&cctvType=1&minX=...&maxX=...&minY=...&maxY=...&getType=json` 호출로 관할 경위도 박스 내 카메라명·좌표를 내려받아 노선 폴리라인에 투영해 정확한 `km` 이정을 부여합니다.

---

## 4. 현행 코드베이스 내 지사 종속(고령지사 하드코딩) 파일 전수 목록

살얼음·제설 의사결정(`public/ice.js`), 제설 타이머(`public/snow-directive.js`), 캐싱·SWR(`public/page-cache.js`, `lib/hourly-roster.mjs`), 파이프라인 진단 로직은 이미 **노선 무관 범용 엔진**으로 분리되어 있으며, 지사 고유 데이터는 아래 **10개 지점**에만 집중되어 있습니다.

| 계층 | 파일 경로 | 주요 상수 / 심볼 | 역할 |
|---|---|---|---|
| **공통 코어** | `lib/bionda-core.js` | `ROUTE12_MILEPOST_BY_STN`, `CORRIDOR_ANCHOR_STATIONS`, `CORRIDOR_WATCHED_PLACES`, `SHORT_TERM_12_REGIONS`, `buildRoadRiskPayload` (`50~176k`, `95~176k`) | 도로관측소 이정 매핑, 단기예보 13개소 좌표·격자, 도로위험 3단계 스코프 집계 |
| **백엔드 설정** | `wrangler.toml`, `cloudflare/worker.js`, `server.js` | `ROAD_LINE_CODE = "14"`, 기본 `roadNum = "012"`, `BRANCH_STN_ID_SET` | 기상청 도로관측 `var` 노선코드, 도로위험 ZIP 노선번호, 진단 대상 관측소 집합 |
| **RWIS 워커** | `cloudflare/rwis-worker.js` | `BOUNDS`, `ROAD` (`012` / `0120`), `RWIS_DIRS` (`대구`/`광주`), `MASTER` | 기상청 RWIS 콘존 스트리밍 필터링 및 로드플러스 CCTV 스트림 매핑 |
| **ITS CCTV** | `lib/cctv-its.js` | `CCTV_BOUNDS`, `CCTV_SITES` (관심지역 8 + 도로관측소 11) | 메인 상황판·미니맵 클릭 시 최인접/보조 고속도로 CCTV 자동 연결 |
| **메인 상황판** | `public/app.js`, `public/index.html` | `presets` (기본 8개 관심지역), 노선 배지(`route12.svg`) 및 헤더 문구 | 초기 진입 시 기본 8개 감시 카드 및 지역 관리 프리셋 |
| **노선 미니맵** | `public/route12.js`, `public/minimap.js`, `public/route12.svg` | `ROUTE12_POLYLINE_KM`, `ROUTE12_ICS`, `ROUTE12_STN_KM_FALLBACK`, `PLACE_SLOT_MAP` | 메인 화면 노선 미니맵 SVG(`540×242`) 및 하단 관측소 스트립 |
| **RWIS 상황판** | `public/rwis-data.js`, `public/rwis.js`, `public/rwis.html` | `RWIS_MASTER`, `RWIS_ROUTE_GEO`, `PROVINCE_LABELS_FIXED`, `COUNTY_LABELS`, `ROUTE_NODES`, `CORRIDOR_MAP_STATIONS`, `SHORT13_MAP_LOCATIONS`, `ZONE_INTEGRATION_MAP` | 50인치 TV 도로살얼음 지도(`1600×700`), 시·군 경계, 콘존 카드, 관측소 콜아웃(`dock`) 및 예보 배지(`dx/dy`) |
| **격상 알림창** | `public/ice-alert-modal.js` | 콘존 목록 수신부 (`corridorOverview`, 4열 그리드, 범위 문구) | 주의·위험 격상 시 1분 카운트다운 팝업 및 상단 전 구간 현황바 |
| **72h 분석** | `public/history-72h.js`, `public/history-72h.html` | `BRANCH_STN_ORDER`, `ALL11_STN_ORDER`, 관측소 드롭다운 옵션 | 제설근무표 매칭·CSV 추출 시 지사 관할 관측소 목록 및 최저 노면온도 기준 |
| **공유 이미지** | `public/share.js`, `scripts/publish-share.py`, `public/llms.txt` | 노선명·지사 범위 안내 문구 (`광주대구선 · 고령지사`) | 08시·18시 정기 브리핑 PNG(예보 섹션명은 이미 범용 `"기상청 시간별예보"`로 통일 완료) |

---

## 5. 핵심 기술 이슈 4가지 및 권장 해결 방안

### 이슈 A. 남↔북 방향 노선(경부·중부내륙·서해안·중앙선)의 지도 비율 문제
- **문제**: 광주대구선은 동서 방향 노선(`가로 1.2° × 세로 0.4°`)이라 `1600×700` 와이드 TV 지도와 `540×242` 미니맵에 바로 들어맞지만, 남↔북 방향 노선을 북쪽 고정으로 그리면 화면 중앙에 좁은 세로선만 생기고 좌우 여백이 낭비됩니다.
- **해결책 (`주축 회전 투영 + 회전 방위표 표기`)**:
  - 기점 `(lon1, lat1)` → 종점 `(lon2, lat2)` 주축이 항상 화면 **좌측 → 우측 대각선**을 향하도록 회전각 $\theta$를 적용해 시·군 경계 폴리곤과 노선 좌표를 함께 회전 투영하고, 지도 우측 상단에 회전된 방위표(`🧭 N ↖`)를 함께 표시합니다.
  - 이렇게 하면 **전국 어느 방향의 노선이든 현행 50인치 TV 상·하단 도킹 콜아웃(`2·2·1·2`)과 모바일 `[⛶ 지도 크게]` 슬라이드 뷰어를 레이아웃 변경 없이 100% 재사용**할 수 있습니다.

### 이슈 B. 관측소 콜아웃(`dock`) 및 예보 배지(`dx, dy`) 라벨 겹침 자동화
- **해결책 (`자동 레이아웃 빌드 스크립트`)**: 관측소 카드(6~8개)는 이정(`km`) 순서대로 상단(`y=110`)·하단(`y=638`) 슬롯에 교차 배치하고, 읍·면·동 예보 배지는 노선 폴리라인·IC 라벨과 최소 `14px` 이상 떨어지도록 반발력 탐색(Force-directed placement) 스크립트로 1회 산출하여 JSON에 고정합니다.

### 이슈 C. 복수 노선 관할 지사 (본선 + 지선/교차선 동시 관할)
- **해결책**: 지사 설정 스키마에서 노선을 단일 문자열이 아닌 `routes[]` 배열로 정의하여, 백엔드가 관할 노선들의 `road_stn_obs`·`road_file_down`·`RWIS` 결과를 병합 집계하도록 확장합니다.

### 이슈 D. 구간(콘존) 개수 가변 대응 (`8개` 외 `5~12개` 지사)
- **해결책**: `rwis.css` 우측 구간 패널은 `--zone-count` CSS 변수 기반 `flex: 1 1 0` 균등 높이 분할(10개 이상일 때는 컴팩트 2열 그리드 자동 전환)을 적용하고, `ice-alert-modal.js` 상단 노선 현황바는 `repeat(var(--branch-zone-count), minmax(0, 1fr))`로 유동 대응합니다.

---

## 6. 권장 아키텍처: 코드 포크(Fork) 대신 `Branch Profile Pack` 설정 분리

지사마다 저장소를 따로 복사(Fork)하면 기상청 API 코드 추가(예: `SFS=14 습기`)나 UI 개선 때마다 모든 저장소를 수동 패치해야 합니다. 따라서 **단일 엔진 코드베이스 + 지사별 선언형 프로파일 JSON** 구조를 권장합니다.

```json
// 예시: config/branches/goryeong.json (표준 지사 프로파일 스키마 초안)
{
  "branchId": "goryeong",
  "branchName": "고령지사",
  "title": "광주대구선 도로기상·도로살얼음 상황판",
  "routes": [
    {
      "roadNo": "012",
      "rwisRoadNoN2": "0120",
      "routeName": "광주대구선",
      "kmaRoadVar": "14",
      "dirs": { "E": "대구방향", "S": "광주방향" },
      "corridorKm": [50.0, 176.0],
      "branchKm": [95.0, 176.0],
      "rangeLabel": "함양IC(95.0k)~옥포JC(176.0k)"
    }
  ],
  "mapProjection": {
    "center": [128.1003, 35.6573],
    "rotationDeg": 0,
    "scale": 1900
  },
  "forecastRegions": [ "... 10~15개 읍·면·동 (고유 DFS 격자 ≤15) ..." ],
  "watchPlaces": [ "... 메인 8개 거점 (상류 선행 1~2곳 포함) ..." ],
  "rwisZones": [ "... 관할 콘존 및 ZONE_INTEGRATION_MAP ..." ],
  "roadStations": [ "... 관할 도로기상관측소 stnId · km · 교량 여부 ..." ],
  "cctvBounds": { "minX": 127.25, "maxX": 128.65, "minY": 35.3, "maxY": 35.9 }
}
```

---

## 7. 타 지사 전환 완료 후 필수 검수 체크리스트 (10개 항목)

- [ ] **1. 고유 DFS 격자 수**: 단기예보 대상 지역의 고유 `(nx, ny)` 격자 수가 `15개 이하`인가?
- [ ] **2. CAP 세부특보 매칭**: 산지·평지·방위 분할 특보구역 폴리곤 내부에 대표 감시 좌표가 정확히 위치하는가?
- [ ] **3. 3종 도로코드 일치**: `road_stn_obs(var)`, `road_file_down(roadNum)`, `RWIS(roadNo)`가 모두 동일 노선·이정 범위를 가리키는가?
- [ ] **4. 링크 합계 불변식**: `/api/road-risk`의 `branchSummary`에서 `total1km === sum(iceCounts) + missingIceCount`가 성립하는가?
- [ ] **5. `SFS` 노면상태 정합성**: 영상 온도에서 `SFS=14(습기)`·`10(저시정)` 오경보 없이 저온(`≤2°C`) 시에만 예비살포 알림이 동작하는가?
- [ ] **6. CCTV 폴백 연결**: 모든 RWIS 콘존 클릭 시 최소 1대 이상의 인근/인접 구간 CCTV가 정상 재생되는가?
- [ ] **7. 50인치 TV 무스크롤**: `1920×1080` 뷰포트에서 `/rwis.html`의 `scrollHeight === 1080`이고 지도 위 라벨 겹침이 `0건`인가?
- [ ] **8. 모바일 대화면 지도**: `390×844` 모바일에서 `[⛶ 지도 크게]` 및 `↻ 가로한눈에` 90° 회전 뷰어가 정상 동작하는가?
- [ ] **9. 격상 팝업 1분 자동닫힘**: `/diagnostics.html` 시뮬레이터에서 주의(2)·위험(3) 팝업이 4열 무스크롤로 뜨고 `60초→0초` 자동 닫힘이 작동하는가?
- [ ] **10. 정기 브리핑 PNG**: `08:00`·`18:00` KST 공유 PNG가 `200 KiB` 이하로 생성되고 `/share/status.json` 해시 검증을 통과하는가?
