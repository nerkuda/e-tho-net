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
# Клиентский архив — ПОДСТАВНОЙ (`etn` — шелл-скрипт): настоящий бинарник
# electron на раннере потребовал бы GUI-библиотек (libgtk-3, libnss3, …) и
# упал бы на проверке ldd, хотя проверяется логика установщика, а не клиент.
# Сборку настоящего клиентского тарбола делает предыдущий шаг CI.
#
# Запуск: bash scripts/install-sh-smoke.sh [версия]
# Версия по умолчанию — из server/package.json. Нужны: bash, tar, sha256sum.

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
cleanup() { rm -rf -- "$work"; }
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

run_installer() { # run_installer <аргументы...>
  env -u XDG_DATA_HOME -u XDG_CONFIG_HOME HOME="$work/home" \
    ETN_RELEASE_BASE_URL="file://$release" bash "$installer" "$@"
}

home="$work/home"
base="$home/.local/opt/etn"
desktop="$home/.local/share/applications/etn.desktop"
config_keep="$home/.config/ETN/keep.txt"
mkdir -p "$home/.config/ETN"
printf 'profiles' > "$config_keep"

# --- 1. Установка ------------------------------------------------------------
make_release "$version"
if run_installer --version "$version" > "$work/install.log" 2>&1; then
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

# --- 2. Повторная установка той же версии ------------------------------------
if run_installer --version "$version" > "$work/reinstall.log" 2>&1; then
  pass "повторная установка: код 0"
else
  fail "повторная установка: ненулевой код"
fi
check "повторная установка не сломала current" \
  test "$(readlink -- "$base/current")" = "$version"

# --- 3. Несовпадение SHA-256: отказ, current не меняется ---------------------
next="9.9.9"
make_release "$next" --corrupt-sum
if run_installer --version "$next" > "$work/badsum.log" 2>&1; then
  fail "битый SHA256SUMS: установка не должна проходить"
else
  pass "битый SHA256SUMS: установка отклонена"
fi
check "после отказа не появилась версия ${next}" test ! -e "$base/$next"
check "после отказа current остался ${version}" \
  test "$(readlink -- "$base/current")" = "$version"
check "сообщение отказа упоминает SHA-256" grep -q 'SHA-256' "$work/badsum.log"

# --- 4. Удаление: каталог и ярлык сняты, конфигурация сохранена --------------
if run_installer --uninstall > "$work/uninstall.log" 2>&1; then
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
