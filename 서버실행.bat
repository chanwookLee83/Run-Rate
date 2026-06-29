@echo off
REM Run & Rate PWA 로컬 서버 실행기
REM file:// 프로토콜에서는 localStorage가 불안정하므로 로컬 서버로 실행합니다.

cd /d "%~dp0"
echo ============================================
echo  RUN ^& RATE PWA 서버를 시작합니다...
echo  브라우저에서 아래 주소로 접속하세요:
echo  http://localhost:8765
echo ============================================
echo  종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요.
echo.

start http://localhost:8765

REM 환경에 따라 python 대신 py 런처만 있는 경우가 있어 우선 py를 시도합니다.
where py >nul 2>nul
if %ERRORLEVEL%==0 (
	py -m http.server 8765
	goto :eof
)

where python >nul 2>nul
if %ERRORLEVEL%==0 (
	python -m http.server 8765
	goto :eof
)

echo [오류] Python 실행 명령을 찾을 수 없습니다.
echo 아래 중 하나를 설치/활성화한 뒤 다시 실행하세요.
echo 1^) Python for Windows (python 명령)
echo 2^) Python Launcher (py 명령)
echo.
echo 임시 대안: VS Code 터미널에서 다음 명령 실행
echo   py -m http.server 8765

pause
