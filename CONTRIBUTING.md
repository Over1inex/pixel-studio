# Разработка Pixel Studio

Репозиторий: https://github.com/Over1inex/pixel-studio. Код приложения распространяется по MIT. Внешние зависимости сохраняют собственные лицензии; уведомления WebView2 находятся в `desktop/`, инструментов Sites — в `scripts/` и `vendor/`.

## Сборка Windows-приложения

Требования для разработки: Windows x64, Node.js 22.13+, npm и компилятор .NET Framework 4 с поддержкой зависимостей .NET Framework 4.6.2+. Для запуска готового EXE нужен Microsoft WebView2 Runtime. Node.js и сервер конечному пользователю не требуются.

Из корня проекта:

```powershell
npm run install:ci
npm run build:desktop
powershell -NoProfile -File .\desktop\build-launcher.ps1
& '.\Pixel Studio.exe' --self-test
```

`build:desktop` собирает React-интерфейс в `desktop-ui-dist/`. Скрипт Windows загружает SDK WebView2 из официального NuGet, если его ещё нет в локальном кеше, и встраивает интерфейс и зависимости клиента в `Pixel Studio.exe`. `--self-test` проверяет runtime, ресурсы и локальное хранение сеанса без открытия окна.

Обычный запуск EXE использует встроенный интерфейс и облачный API из `desktop/DesktopApp.cs`. Встроенный адрес `https://pixel-studio.local` обслуживается нативным клиентом; это не сайт в интернете. Сетевые запросы `/api/*` проходят через нативный посредник. Перед каждой пересборкой EXE выполняйте `npm run build:desktop`, чтобы включить актуальный интерфейс.

## Проверки кода

```powershell
npx tsc --noEmit
node --test tests/*.test.mjs
npm run build
```

`npm run build` собирает серверный Worker для Sites. Это отдельная сборка API, она не нужна для обычного запуска EXE.

## Локальный API

Для разработки сервера сначала выполните `npm run build`. Примените только ещё не применённые SQL-миграции из `drizzle/` по порядку к локальной D1. Для новой локальной базы:

```powershell
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_great_paper_doll.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_flashy_wendell_vaughn.sql
npm run dev -- --hostname 127.0.0.1
```

В другом окне PowerShell запустите:

```powershell
& '.\Pixel Studio.exe' --local
```

Флаг `--local` переключает API на `http://127.0.0.1:5173/`; интерфейс по-прежнему встроен в EXE. Локальная база и облачная база разделены. Локальная имитация аккаунта Sites предназначена только для тестов и не заменяет производственный Google-вход.

При работающем локальном API команда `node tests/api-integration.mjs` проверяет операции и изоляцию проектов. Тест ограничен loopback-адресом, создаёт временный проект и удаляет свои данные после проверки.

## Свой хостинг и учётные данные

Для отдельной копии создайте собственный проект Sites. Идентификатор в `.openai/hosting.json` должен принадлежать этому проекту; URL API в `DesktopApp.cs` — соответствовать ему. Подключите свои D1/R2, Google OAuth и разрешённый аккаунт. Сохраните закрытую политику доступа Sites. Публикацию выполняйте через инструменты Sites.

Служебный ключ доступа не включается в исходники или EXE. Нативный клиент читает `%LOCALAPPDATA%\PixelStudio\service-access.bin`, зашифрованный DPAPI `CurrentUser`. Для другого ПК или пользователя Windows владелец сервиса отдельно настраивает доступ. Подробности — в [GOOGLE-SETUP.md](GOOGLE-SETUP.md).

Не добавляйте в коммиты или исходные архивы секреты, `.dev.vars`, `service-access.bin`, файлы сеансов, локальные базы, профили WebView2, `node_modules`, `work`, `dist`, `desktop-ui-dist`, EXE или личные изображения. Готовые исполняемые файлы поставляются отдельно от исходного кода.
