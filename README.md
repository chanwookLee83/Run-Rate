# Run & Rate

GitHub Pages로 배포해서 웹 URL로 접속할 수 있습니다.

## 1) GitHub 저장소에 올리기

아직 저장소가 없다면:

```powershell
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<사용자명>/<저장소명>.git
git push -u origin main
```

이미 저장소가 있다면:

```powershell
git add .
git commit -m "Add GitHub Pages deployment workflow"
git push
```

## 2) GitHub Pages 활성화

1. GitHub 저장소 > Settings > Pages
2. Build and deployment 의 Source 를 `GitHub Actions`로 선택
3. `main` 브랜치에 push하면 자동 배포

## 3) 접속 주소

배포가 완료되면 아래 주소로 접속:

- `https://<사용자명>.github.io/<저장소명>/`

## 참고

- 이 앱은 `file://` 직접 열기보다 `http(s)` 환경에서 동작하도록 구성되어 있습니다.
- GitHub Pages(`https`)에서는 PWA(Service Worker) 등록이 가능합니다.
