#!/usr/bin/env bash
#
# Функциональная проверка scripts/install.sh — Linux-джоба CI (П4, 00345091).
#
# Проверяется контракт установщика Linux-клиента: локальный file://-источник
# релиза, раскладка ~/.local/opt/etn/<версия> + симлинк current, файл установки
# `.etn-install`, ярлык .desktop, сохранение ~/.config/ETN, повторная установка
# и отказ при несовпадении SHA-256 (текущая версия не меняется), удаление
# (`--uninstall`) без потери конфигурации.
#
# Отдельно проверяется одношная установка (задача 20a56c57):
#   * пайп-режим `cat install.sh | bash` — скрипт приходит на stdin и не должен
#     его читать (иначе команда съедает остаток скрипта);
#   * версия из статического файла <base>/releases/latest — по HTTP-раздаче
#     (как у зеркала) и по file:// (локальная раздача), без --version;
#   * одношные команды `curl -fsSL <base>/install.sh | bash` и
#     `wget -qO- <base>/install.sh | bash`; первая — как есть, вторая — с PATH
#     без curl (минимальная Ubuntu 24.04: там curl нет, установщик обязан
#     скачать через wget);
#   * отсутствие и curl, и wget — понятная ошибка с подсказкой установить один
#     из клиентов (а не пустой stdin и код 0);
#   * повторный запуск без --version обновляет клиент; битый SHA-256 — отказ.
#
# Клиентский архив — ПОДСТАВНОЙ (`etn` — шелл-скрипт): настоящий бинарник
# electron на раннере потребовал бы GUI-библиотек (libgtk-3, libnss3, …) и
# упал бы на проверке ldd, хотя проверяется логика установщика, а не клиент.
# Сборку настоящего клиентского тарбола делает предыдущий шаг CI.
#
# Запуск: bash scripts/install-sh-smoke.sh [версия]
# Версия по умолчанию — из server/package.json. Нужны: bash, tar, sha256sum,
# node (статический HTTP-сервер для зеркала).

set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
installer="$repo_root/scripts/install.sh"
version="${1:-}"

if [ -z "$version" ]; then
  version="$(cd "$repo_root" && node -p "require('./server/package.json').version")"
fi
case "$version" in
  v*) version="${version#v}" ;;
esac

work="$(mktemp -d "${TMPDIR:-/tmp}/etn-install-smoke.XXXXXX")"
http_pid=""
cleanup() {
  if [ -n "$http_pid" ]; then
    kill "$http_pid" 2>/dev/null || true
    wait "$http_pid" 2>/dev/null || true
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

failures=0
checks=0
pass() { checks=$((checks + 1)); printf 'ok   %s\n' "$*"; }
fail() { checks=$((checks + 1)); failures=$((failures + 1)); printf 'FAIL %s\n' "$*"; }
check() { # check <описание> <команда...>
  local desc="$1"
  shift
  if "$@"; then pass "$desc"; else fail "$desc"; fi
}

# --- Локальный источник релиза ----------------------------------------------
# install.sh строит URL как <base>/releases/download/v<версия>/<asset>.
release="$work/release"
make_release() { # make_release <версия> [--corrupt-sum]
  local v="$1" corrupt="${2:-}" dir asset
  dir="$release/releases/download/v${v}"
  asset="ETN-Client-${v}-linux-x64.tar.gz"
  mkdir -p "$dir" "$work/stub-$v"
  cat > "$work/stub-$v/etn" <<'STUB'
#!/bin/sh
exit 0
STUB
  chmod +x "$work/stub-$v/etn"
  printf 'png' > "$work/stub-$v/etn.png"
  tar -czf "$dir/$asset" -C "$work/stub-$v" .
  ( cd "$dir" && sha256sum "$asset" > SHA256SUMS )
  if [ "$corrupt" = "--corrupt-sum" ]; then
    # Подменяем хеш: установка обязана прерваться до распаковки и не менять current.
    ( cd "$dir" && sed -i 's/^./0/' SHA256SUMS )
  fi
}

set_latest() { # set_latest <версия>
  mkdir -p "$release/releases"
  printf '%s\n' "$1" > "$release/releases/latest"
}

run_installer() { # run_installer <home> <base-url> [аргументы...]
  local home="$1" base="$2"
  shift 2
  env -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$home" \
    ETN_RELEASE_BASE_URL="$base" bash "$installer" "$@"
}

# Статический HTTP-сервер как у зеркала: отдаёт файлы из каталога релиза.
# Порт 0 — свободный; фактический порт пишется в файл, чтобы не гадать.
start_http_server() { # start_http_server <корень> <файл-порт>; печатает PID
  node -e '
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(process.argv[1]);
const portFile = process.argv[2];
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const file = path.resolve(root, "." + url);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.end(data);
  });
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
' "$1" "$2" >/dev/null 2>&1 &
  echo $!
}

wait_for_file() { # wait_for_file <файл> — до 10 с
  local f="$1" i
  for i in $(seq 1 100); do
    if [ -s "$f" ]; then return 0; fi
    sleep 0.1
  done
  return 1
}

# PATH-песочница: симлинки на утилиты из /usr/bin и /bin, кроме перечисленных.
# Проверяет установку на «минимальной Ubuntu 24.04», где нет curl.
make_tool_path() { # make_tool_path <каталог> [исключённые имена...]
  local dir="$1" src name excluded skip
  shift
  mkdir -p "$dir"
  for src in /usr/bin/* /bin/*; do
    if [ ! -e "$src" ] || [ -d "$src" ]; then
      continue
    fi
    name="${src##*/}"
    skip=0
    for excluded in "$@"; do
      if [ "$name" = "$excluded" ]; then
        skip=1
      fi
    done
    if [ "$skip" -eq 0 ]; then
      ln -sf -- "$src" "$dir/$name"
    fi
  done
  return 0
}

home="$work/home"
base="$home/.local/opt/etn"
desktop="$home/.local/share/applications/etn.desktop"
config_keep="$home/.config/ETN/keep.txt"
mkdir -p "$home/.config/ETN"
printf 'profiles' > "$config_keep"

# --- 1. Пайп-режим: `cat install.sh | bash` ---------------------------------
# Скрипт приходит на stdin. Любая команда, читающая stdin, съест остаток
# скрипта — установка оборвётся. Это ровно путь `curl … | bash`.
make_release "$version"
pipe_home="$work/home-pipe"
if cat "$installer" | env -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$pipe_home" \
    ETN_RELEASE_BASE_URL="file://$release" bash -s -- --version "$version" \
    > "$work/pipe.log" 2>&1; then
  pass "пайп-режим (cat install.sh | bash): код 0"
else
  fail "пайп-режим (cat install.sh | bash): ненулевой код"
  sed -n '1,20p' "$work/pipe.log"
fi
check "пайп-режим: версия установлена" \
  test "$(readlink -- "$pipe_home/.local/opt/etn/current")" = "$version"

# --- 2. Обычная установка ----------------------------------------------------
if run_installer "$home" "file://$release" --version "$version" > "$work/install.log" 2>&1; then
  pass "install.sh --version ${version}: код 0"
else
  fail "install.sh --version ${version}: ненулевой код"
  sed -n '1,20p' "$work/install.log"
fi

check "раскладка ${base}/${version}/etn" test -x "$base/$version/etn"
check "симлинк current -> ${version}" \
  test "$(readlink -- "$base/current")" = "$version"
check "файл установки .etn-install пишет версию" \
  grep -qx "version=$version" "$base/.etn-install"
check "ярлык .desktop создан" test -f "$desktop"
check "ярлык помечен установщиком ETN" grep -qx 'X-ETN-Installer=true' "$desktop"
check "ярлык указывает на current/etn" \
  grep -qx "Exec=\"$base/current/etn\"" "$desktop"

# --- 3. Версия из статического releases/latest по file:// (локальная раздача) -
set_latest "$version"
file_home="$work/home-file"
if run_installer "$file_home" "file://$release" > "$work/file-latest.log" 2>&1; then
  pass "file://releases/latest без --version: код 0"
else
  fail "file://releases/latest без --version: ненулевой код"
  sed -n '1,20p' "$work/file-latest.log"
fi
check "file://releases/latest: установлена ${version}" \
  test "$(readlink -- "$file_home/.local/opt/etn/current")" = "$version"

# --- 4. Версия из статического releases/latest по HTTP (зеркало) -------------
# Раздача содержит и сам install.sh: одношные команды скачивают его отсюда.
cp -- "$installer" "$release/install.sh"
port_file="$work/http-port"
http_pid="$(start_http_server "$release" "$port_file")"
if wait_for_file "$port_file"; then
  http_port="$(cat "$port_file")"
  http_base="http://127.0.0.1:${http_port}"
  http_home="$work/home-http"
  if run_installer "$http_home" "$http_base" > "$work/http-latest.log" 2>&1; then
    pass "HTTP-раздача releases/latest без --version: код 0"
  else
    fail "HTTP-раздача releases/latest без --version: ненулевой код"
    sed -n '1,20p' "$work/http-latest.log"
  fi
  check "HTTP releases/latest: установлена ${version}" \
    test "$(readlink -- "$http_home/.local/opt/etn/current")" = "$version"

  # --- 4a. Одношная команда по HTTP: curl и wget ----------------------------
  # Пользовательский путь: `curl -fsSL <base>/install.sh | bash`.
  if command -v curl >/dev/null 2>&1; then
    curl_home="$work/home-curl-pipe"
    if curl -fsSL "$http_base/install.sh" \
        | env -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$curl_home" \
            ETN_RELEASE_BASE_URL="$http_base" bash -s -- \
            > "$work/curl-pipe.log" 2>&1; then
      pass "curl -fsSL <base>/install.sh | bash: код 0"
    else
      fail "curl -fsSL <base>/install.sh | bash: ненулевой код"
      sed -n '1,20p' "$work/curl-pipe.log"
    fi
    check "curl-пайп: установлена ${version}" \
      test "$(readlink -- "$curl_home/.local/opt/etn/current")" = "$version"
  else
    fail "curl не найден в среде smoke-теста: одношную команду через curl проверить нельзя"
  fi

  # Минимальная Ubuntu 24.04 идёт без curl: тот же путь через wget,
  # а установщик внутри видит PATH без curl и обязан скачать через wget.
  nocurl_bin="$work/nocurl-bin"
  make_tool_path "$nocurl_bin" curl
  check "PATH-песочница без curl: curl недоступен" test ! -e "$nocurl_bin/curl"
  check "PATH-песочница без curl: wget доступен" test -x "$nocurl_bin/wget"
  nocurl_home="$work/home-nocurl-pipe"
  if wget -qO- "$http_base/install.sh" \
      | env -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$nocurl_home" \
          PATH="$nocurl_bin" ETN_RELEASE_BASE_URL="$http_base" bash -s -- \
          > "$work/nocurl-pipe.log" 2>&1; then
    pass "wget -qO- <base>/install.sh | bash без curl: код 0"
  else
    fail "wget -qO- <base>/install.sh | bash без curl: ненулевой код"
    sed -n '1,20p' "$work/nocurl-pipe.log"
  fi
  check "wget-пайп без curl: установлена ${version}" \
    test "$(readlink -- "$nocurl_home/.local/opt/etn/current")" = "$version"

  # Ни curl, ни wget: отказ с понятной подсказкой до первой загрузки.
  noclient_bin="$work/noclient-bin"
  make_tool_path "$noclient_bin" curl wget
  if env -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$work/home-noclient" \
      PATH="$noclient_bin" ETN_RELEASE_BASE_URL="$http_base" bash "$installer" \
      > "$work/noclient.log" 2>&1; then
    fail "без curl и wget: установка не должна проходить"
  else
    pass "без curl и wget: установка отклонена"
  fi
  check "сообщение без curl и wget называет оба клиента" \
    grep -Eq 'curl.*wget|wget.*curl' "$work/noclient.log"

  # --- 5. Повтор без --version обновляет клиент ------------------------------
  set_latest 9.9.9
  make_release 9.9.9
  if run_installer "$http_home" "$http_base" > "$work/http-update.log" 2>&1; then
    pass "повтор без --version (обновление): код 0"
  else
    fail "повтор без --version (обновление): ненулевой код"
    sed -n '1,20p' "$work/http-update.log"
  fi
  check "обновление переключило current на 9.9.9" \
    test "$(readlink -- "$http_home/.local/opt/etn/current")" = "9.9.9"

  # --- 6. Битый SHA-256 у версии из releases/latest: отказ ------------------
  set_latest 9.9.8
  make_release 9.9.8 --corrupt-sum
  if run_installer "$http_home" "$http_base" > "$work/http-badsum.log" 2>&1; then
    fail "битый SHA256SUMS в releases/latest: установка не должна проходить"
  else
    pass "битый SHA256SUMS в releases/latest: установка отклонена"
  fi
  check "после отказа не появилась версия 9.9.8" \
    test ! -e "$http_home/.local/opt/etn/9.9.8"
  check "после отказа current остался 9.9.9" \
    test "$(readlink -- "$http_home/.local/opt/etn/current")" = "9.9.9"
  check "сообщение отказа упоминает SHA-256" grep -q 'SHA-256' "$work/http-badsum.log"
else
  fail "HTTP-сервер не поднялся за 10 с"
fi

# --- 7. Повторная установка той же версии ------------------------------------
if run_installer "$home" "file://$release" --version "$version" > "$work/reinstall.log" 2>&1; then
  pass "повторная установка: код 0"
else
  fail "повторная установка: ненулевой код"
fi
check "повторная установка не сломала current" \
  test "$(readlink -- "$base/current")" = "$version"

# --- 8. Несовпадение SHA-256: отказ, current не меняется ---------------------
next="9.9.9"
make_release "$next" --corrupt-sum
if run_installer "$home" "file://$release" --version "$next" > "$work/badsum.log" 2>&1; then
  fail "битый SHA256SUMS: установка не должна проходить"
else
  pass "битый SHA256SUMS: установка отклонена"
fi
check "после отказа не появилась версия ${next}" test ! -e "$base/$next"
check "после отказа current остался ${version}" \
  test "$(readlink -- "$base/current")" = "$version"
check "сообщение отказа упоминает SHA-256" grep -q 'SHA-256' "$work/badsum.log"

# --- 9. Удаление: каталог и ярлык сняты, конфигурация сохранена --------------
if run_installer "$home" "file://$release" --uninstall > "$work/uninstall.log" 2>&1; then
  pass "install.sh --uninstall: код 0"
else
  fail "install.sh --uninstall: ненулевой код"
  sed -n '1,20p' "$work/uninstall.log"
fi
check "каталог установки удалён" test ! -e "$base"
check "ярлык удалён" test ! -e "$desktop"
check "конфигурация ~/.config/ETN не тронута" test -f "$config_keep"

printf '\nИтого: %d проверок, провалено %d\n' "$checks" "$failures"
if [ "$failures" -ne 0 ]; then
  exit 1
fi
printf 'install.sh: все проверки пройдены\n'
