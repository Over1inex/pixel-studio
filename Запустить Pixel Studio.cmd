@echo off
setlocal
chcp 65001 >nul
title Pixel Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Не найден Node.js. Установите Node.js 22.13 или новее и повторите запуск.
  pause
  exit /b 1
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22 || major===22 && minor>=13 ? 0 : 1)"
if errorlevel 1 (
  echo Нужен Node.js версии 22.13 или новее.
  pause
  exit /b 1
)

if not exist "node_modules\vinext\dist\cli.js" (
  echo Устанавливаю зависимости Pixel Studio...
  call npm run install:ci
  if errorlevel 1 (
    echo Не удалось установить зависимости. Проверьте подключение к интернету.
    pause
    exit /b 1
  )
)

echo Запускаю Pixel Studio: http://127.0.0.1:5173
echo Оставьте это окно открытым. Для остановки нажмите Ctrl+C.
start "" /b powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -File "%~dp0desktop\open-local.ps1"
call npm run dev -- --hostname 127.0.0.1
if errorlevel 1 (
  echo Сервер остановлен с ошибкой. Подробности приведены выше.
  pause
)
endlocal
