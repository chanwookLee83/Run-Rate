# Run & Rate

양산 초기 검증(사이클타임 · Rate% · 불량률 · CPK)을 현장에서 바로 기록하고 분석하는 PWA(Progressive Web App)입니다. Firebase Firestore를 백엔드로 사용해 여러 기기에서 실시간으로 데이터가 동기화되며, 오프라인에서도 캐시된 데이터로 계속 사용할 수 있습니다.

## 주요 기능

- **개요**: 라인 전체 Rate%(병목공정 기준), 최저 CPK 공정, 불량률/양품률 등 핵심 지표를 한 화면에서 확인
- **공정 등록**: 품번별로 공정(장비명, 목표 사이클타임 등)을 순서대로 등록/관리
- **공정별 분석**: 공정을 선택해 스톱워치 타이머로 사이클타임을 측정·기록하고, 불량 유형/수량을 입력. 공정별·전체 그래프로 추이 확인
- **CPK 품질측정**: 공정별 규격(상/하한)과 측정값(개별 원시값 또는 통계값 직접 입력)으로 CPK/CPU/CPL 계산 및 시각화
- **Run & Rate 결과(이력)**: 측정 이력 조회 및 CSV 내보내기
- **오프라인 지원**: Service Worker(`sw.js`) 기반 네트워크 우선 캐싱, 앱 업데이트 시 자동 새로고침 안내

## 기술 스택

- 순수 HTML/CSS/JavaScript (별도 빌드 과정 없음)
- [Firebase Firestore](https://firebase.google.com/docs/firestore) — 데이터 저장 및 실시간 동기화(오프라인 영속 캐시 포함)
- PWA (Web App Manifest + Service Worker)

## 데이터 구조 (Firestore)

```
projects/{projectId}                     프로젝트 메타 (품번, 품명, 목표 UPH ...)
projects/{projectId}/processes/{id}      공정 (순서, 이름, 설비, 목표 C/T)
projects/{projectId}/cycles/{id}         사이클타임 측정 기록 (공정ID, 시각, C/T)
projects/{projectId}/defects/{id}        불량 기록 (공정ID, 시각, 불량유형, 수량, 총생산수)
projects/{projectId}/cpkData/{processId} 공정별 CPK 규격 + 측정값 (공정당 문서 1개)
```

Firebase 설정은 [firebase-init.js](firebase-init.js)에 있습니다. 개인 사용 전용 프로젝트로 구성되어 있으니, 다른 환경에 배포할 경우 `firebaseConfig`를 본인 프로젝트 값으로 교체하세요.

## 실행 방법

`file://`로 직접 열면 `localStorage`/PWA 동작이 불안정하므로 로컬 HTTP 서버로 실행합니다.

### Windows에서 빠르게 실행

[서버실행.bat](서버실행.bat)을 더블클릭하면 `http://localhost:8765`로 브라우저가 열립니다. (Python 또는 `py` 런처 필요)

### 수동 실행

```powershell
py -m http.server 8765
# 또는
python -m http.server 8765
```

이후 브라우저에서 `http://localhost:8765` 접속.

### GitHub Pages 배포

1. 저장소를 GitHub에 push
2. 저장소 Settings > Pages > Build and deployment의 Source를 `GitHub Actions`로 선택
3. `main` 브랜치에 push하면 자동 배포되며, `https://<사용자명>.github.io/<저장소명>/`으로 접속 가능

GitHub Pages(`https`)에서는 PWA(Service Worker) 등록 및 오프라인 캐싱이 정상 동작합니다.

## 프로젝트 구조

```
index.html          앱 셸(레이아웃/스타일) — PWA 진입점
app.js               상태 관리, 렌더링, 사이클타임/Rate%/CPK 계산, CSV 내보내기 등 전체 로직
firebase-init.js     Firebase 초기화 및 Firestore 핸들 노출
manifest.json        PWA 매니페스트 (아이콘, 테마 컬러 등)
sw.js                Service Worker (네트워크 우선 캐싱, 버전 관리)
서버실행.bat          로컬 서버 실행 스크립트 (Windows)
Run&rate.html        초기 프로토타입 버전 (참고용, 현재는 index.html 사용)
```

## 버전 관리

새 버전 배포 시 `app.js`의 `APP_VERSION`과 `sw.js`의 `CACHE_NAME`을 함께 올려야 사용자 화면에 최신 변경사항이 즉시 반영됩니다.
