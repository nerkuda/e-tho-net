# Third-party — лицензии бинарных компонентов поставки ETN

Здесь лежат тексты лицензий сторонних бинарников, которые установщик кладёт
в поставку. Версии закреплены в `installer/fetch-payload.ps1`; хеши
загруженных артефактов сверяются при каждой подготовке payload и
записываются в `installer/payload/server-manifest.json`.

## Node.js

| | |
|---|---|
| Версия | 22.23.4 (LTS, линия 22 — см. `.nvmrc`, ADR `01c38213`) |
| Что поставляется | `node.exe` → `{app}\node\node.exe` |
| Источник | https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip |
| SHA-256 архива | `cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20` |
| Проверка | https://nodejs.org/dist/v22.23.4/SHASUMS256.txt |
| Лицензия | MIT и лицензии встроенных зависимостей — `node-LICENSE.txt` (файл `LICENSE` из архива Node, приведён без изменений) |

## WinSW

| | |
|---|---|
| Версия | 2.12.0 |
| Что поставляется | `WinSW-x64.exe` → `{app}\service\etn-service.exe` (имя обязано совпадать с `etn-service.xml`) |
| Источник | https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe |
| SHA-256 | `05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da` (18 243 033 байт) |
| Лицензия | MIT — `winsw-LICENSE.txt` (файл `LICENSE.txt` из репозитория v2.12.0) |

Проект WinSW не публикует файл контрольных сумм к релизу: SHA-256 закреплён
по официальному артефакту GitHub. При обновлении версии WinSW заменяйте
версию, URL и SHA-256 в `installer/fetch-payload.ps1` и в этой таблице
одним изменением.

## Прочие компоненты

`server\node_modules` — prod-зависимости сервера из npm. Тексты их
лицензий поставляются вместе с пакетами (каждый пакет содержит свой
`LICENSE`), отдельных копий здесь не держим. Сводный список версий,
попавших в поставку, — `installer/payload/server-manifest.json` (создаёт
`fetch-payload.ps1`).

WinSW 2.12.0 (`WinSW-x64.exe`) — self-contained сборка под .NET Core 3.1:
отдельный .NET runtime на машине не требуется.
