#!/usr/bin/env bash
#
# ETN — установка, обновление и удаление Linux-клиента.
#
# Скрипт скачивает архив клиента из GitHub-релиза, сверяет его с SHA256SUMS
# (единственный источник хешей), распаковывает рядом с предыдущими версиями
# и атомарно переключает симлинк `current`. Профили и ключи в ~/.config/ETN
# не трогаются никогда.
#
# Запуск:
#   curl -fsSL https://github.com/nerkuda/e-tho-net/releases/latest/download/install.sh | bash
#   bash install.sh --version 0.15.1        # конкретная версия
#   sudo bash install.sh --system           # системная установка (/opt/etn)
#   bash install.sh --uninstall              # удалить (конфигурация сохраняется)
#
# Раскладка:
#   пользовательский режим: ~/.local/opt/etn/<версия> + ~/.local/opt/etn/current,
#                           ярлык в ~/.local/share/applications/etn.desktop;
#   системный режим:        /opt/etn/<версия> + /opt/etn/current,
#                           /usr/local/bin/etn, /usr/share/applications/etn.desktop.
#
# Переменные окружения:
#   ETN_RELEASE_BASE_URL — база релизов (по умолчанию https://github.com/nerkuda/e-tho-net);
#                          зеркало или локальный каталог (file://) для проверки.
#
# Задача 6d93fe6f (0.15.1), компонент 42830b8c; контракт — карточка задачи.

set -euo pipefail

readonly PROG="install.sh"
readonly DEFAULT_RELEASE_BASE_URL="https://github.com/nerkuda/e-tho-net"
readonly MARKER_NAME=".etn-install"
readonly DESKTOP_MARKER="X-ETN-Installer=true"
# Код возврата, когда установка найдена, но удалить её не удалось (права).
readonly REMOVE_FAILED_CODE=10

RELEASE_BASE_URL="${ETN_RELEASE_BASE_URL:-$DEFAULT_RELEASE_BASE_URL}"
RELEASE_BASE_URL="${RELEASE_BASE_URL%/}"

MODE="user"          # user | system
ACTION="install"     # install | uninstall
VERSION=""           # X.Y.Z; пусто — последняя стабильная
WORKDIR=""

die() {
  printf '%s: ошибка: %s\n' "$PROG" "$*" >&2
  exit 1
}

warn() {
  printf '%s: предупреждение: %s\n' "$PROG" "$*" >&2
}

info() {
  printf '%s\n' "$*"
}

cleanup() {
  # Код возврата фиксируется до уборки: без явного exit его затёр бы статус
  # последней команды trap'а (bash берёт его как код завершения скрипта).
  local status=$?
  if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
    rm -rf -- "$WORKDIR" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Установка и обновление Linux-клиента ETN.

Использование: install.sh [--version X.Y.Z] [--system] [--uninstall]

  --version X.Y.Z  поставить указанную версию (по умолчанию — последний релиз);
  --system         системная установка в /opt/etn, /usr/local/bin/etn и
                   /usr/share/applications (нужны права root);
  --uninstall      удалить установку ETN; ~/.config/ETN (профили и ключи)
                   сохраняется;
  -h, --help       эта справка.

Без --system установка идёт в домашний каталог (~/.local/opt/etn) и не требует
root. Повторный запуск обновляет клиент: новая версия ставится рядом со старой,
симлинк `current` переключается только после проверки SHA-256 и распаковки.
EOF
}

# --- Разбор аргументов -------------------------------------------------------

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "для --version нужно значение X.Y.Z"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#--version=}"
      shift
      ;;
    --system)
      MODE="system"
      shift
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      printf '%s: ошибка: неизвестный параметр: %s\n' "$PROG" "$1" >&2
      exit 2
      ;;
  esac
done

case "$VERSION" in
  v*) VERSION="${VERSION#v}" ;;
esac

if [ "$ACTION" = "uninstall" ] && [ -n "$VERSION" ]; then
  die "--uninstall не принимает --version"
fi

if [ -n "$VERSION" ] && ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$'; then
  die "некорректная версия: $VERSION (ожидается X.Y.Z)"
fi

EUID_NOW="$(id -u)"
[ -n "${HOME:-}" ] || die "не задан HOME — некуда ставить клиент"

# Пользовательский режим под sudo: предупреждаем (сценарий 7cbbf51c) и ставим
# в домашний каталог пользователя, вызвавшего sudo, а не в /root. Созданные
# каталоги цепочки (~/.local, ~/.local/opt, ~/.local/share/applications)
# передаются этому пользователю: root-овые родители не дают ни удалить
# установку без sudo, ни переустановить её (вердикт приёмки 2026-10-30).
SUDO_TARGET_USER=""
if [ "$EUID_NOW" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$MODE" = "user" ]; then
  SUDO_TARGET_USER="$SUDO_USER"
  warn "пользовательский режим не требует sudo — ставлю в каталог пользователя ${SUDO_USER}"
fi

target_home() {
  if [ -n "$SUDO_TARGET_USER" ]; then
    local home
    home="$(getent passwd "$SUDO_TARGET_USER" 2>/dev/null | cut -d: -f6 || true)"
    if [ -n "$home" ]; then
      printf '%s\n' "$home"
      return 0
    fi
    eval "printf '%s\\n' ~${SUDO_TARGET_USER}" 2>/dev/null && return 0
  fi
  printf '%s\n' "$HOME"
}

TARGET_HOME="$(target_home)"
if [ "$MODE" = "user" ]; then
  BASE="$TARGET_HOME/.local/opt/etn"
  if [ -n "$SUDO_TARGET_USER" ]; then
    DATA_HOME="$TARGET_HOME/.local/share"
    CONFIG_DIR="$TARGET_HOME/.config/ETN"
  else
    DATA_HOME="${XDG_DATA_HOME:-$TARGET_HOME/.local/share}"
    CONFIG_DIR="${XDG_CONFIG_HOME:-$TARGET_HOME/.config}/ETN"
  fi
  DESKTOP_DIR="$DATA_HOME/applications"
  BIN_LINK=""
else
  BASE="/opt/etn"
  DATA_HOME=""
  CONFIG_DIR="$TARGET_HOME/.config/ETN"
  DESKTOP_DIR="/usr/share/applications"
  BIN_LINK="/usr/local/bin/etn"
fi
DESKTOP_FILE="$DESKTOP_DIR/etn.desktop"

# --- Каталоги и владелец ------------------------------------------------------

# Ошибка удаления: установка найдена, но снять её не удалось. Отдельный код
# отличает «не смогли удалить» (права, занятость) от «не удалось поставить».
remove_failed() {
  printf '%s: ошибка: %s\n' "$PROG" "$*" >&2
  exit "$REMOVE_FAILED_CODE"
}

# Существующие каталоги установки в sudo-режиме обязаны принадлежать
# SUDO_USER. Иначе root-овый родитель останется недоступным пользователю:
# --uninstall без sudo не сможет убрать установку, а повторная установка
# упадёт на mkdir. Такой каталог скрипт починить не вправе (он его не создал)
# — отказываем до скачивания и подсказываем команду возврата прав.
check_owner_chain() {
  local dir owner
  [ -n "$SUDO_TARGET_USER" ] || return 0
  for dir in "$@"; do
    [ -d "$dir" ] || continue
    owner="$(stat -c '%U' -- "$dir" 2>/dev/null || true)"
    if [ -n "$owner" ] && [ "$owner" != "$SUDO_TARGET_USER" ]; then
      die "каталог ${dir} принадлежит ${owner}, а не ${SUDO_TARGET_USER}: установка под sudo оставит его недоступным. Верните права (sudo chown -R ${SUDO_TARGET_USER}: '${dir}') или запустите скрипт без sudo"
    fi
  done
}

# Создать каталог и всю недостающую цепочку родителей. В sudo-режиме каждый
# созданный скриптом каталог сразу передаётся SUDO_USER — вплоть до $HOME, но
# не выше и только те, которых до вызова не было. Не удалось передать —
# отказываем: иначе установка завершится «успешно», а пользователь не сможет
# ни запустить обновление, ни удалить её без sudo.
make_dirs() {
  local dir="$1" probe="$1" created owner_group
  local -a missing=()
  while [ ! -d "$probe" ] && [ "$probe" != "/" ]; do
    missing+=("$probe")
    probe="$(dirname -- "$probe")"
  done
  mkdir -p -- "$dir" || return 1
  if [ "${#missing[@]}" -eq 0 ] || [ -z "$SUDO_TARGET_USER" ]; then
    return 0
  fi
  owner_group="$(id -gn "$SUDO_TARGET_USER" 2>/dev/null || true)"
  for created in "${missing[@]}"; do
    if [ -n "$owner_group" ]; then
      chown "${SUDO_TARGET_USER}:${owner_group}" -- "$created" \
        || die "не удалось передать ${created} пользователю ${SUDO_TARGET_USER}: запустите скрипт без sudo"
    else
      chown "${SUDO_TARGET_USER}:" -- "$created" \
        || die "не удалось передать ${created} пользователю ${SUDO_TARGET_USER}: запустите скрипт без sudo"
    fi
  done
}

# --- Инструменты -------------------------------------------------------------

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "не найдена команда $1 — установите её и повторите запуск"
}

sha256_of() {
  case "${SHA256_TOOL:-}" in
    sha256sum) sha256sum -- "$1" | awk '{print $1}' ;;
    shasum) shasum -a 256 -- "$1" | awk '{print $1}' ;;
    *) die "не найден инструмент SHA-256" ;;
  esac
}

detect_sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    SHA256_TOOL="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA256_TOOL="shasum"
  else
    die "не найдены sha256sum или shasum — без проверки SHA-256 установка невозможна"
  fi
}

# --- Проверка архитектуры и зависимостей -------------------------------------

check_architecture() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) ;;
    aarch64|arm64)
      die "сборки для arm64 нет: доступен только Linux x64"
      ;;
    *)
      die "неподдерживаемая архитектура ${machine}: доступен только Linux x64"
      ;;
  esac
}

detect_distro_family() {
  local id="" like=""
  if [ -r /etc/os-release ]; then
    id="$(. /etc/os-release; printf '%s' "${ID:-}")"
    like="$(. /etc/os-release; printf '%s' "${ID_LIKE:-}")"
  fi
  case " ${id,,} ${like,,} " in
    *" debian "*|*" ubuntu "*|*" linuxmint "*|*" pop "*) printf '%s\n' apt ;;
    *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*) printf '%s\n' dnf ;;
    *" arch "*|*" manjaro "*|*" endeavouros "*) printf '%s\n' pacman ;;
    *) printf '%s\n' unknown ;;
  esac
}

# Соответствие «soname | пакет apt | пакет dnf | пакет pacman». Таблица нужна
# только для подсказки пользователю: скрипт сам ничего не устанавливает.
library_package() {
  local soname="$1"
  while IFS='|' read -r name apt_pkg dnf_pkg pacman_pkg; do
    if [ "$name" = "$soname" ]; then
      printf '%s|%s|%s\n' "$apt_pkg" "$dnf_pkg" "$pacman_pkg"
      return 0
    fi
  done <<'TABLE'
libgtk-3.so.0|libgtk-3-0|gtk3|gtk3
libgdk-3.so.0|libgtk-3-0|gtk3|gtk3
libglib-2.0.so.0|libglib2.0-0|glib2|glib2
libgobject-2.0.so.0|libglib2.0-0|glib2|glib2
libgio-2.0.so.0|libglib2.0-0|glib2|glib2
libnss3.so|libnss3|nss|nss
libnssutil3.so|libnss3|nss|nss
libsmime3.so|libnss3|nss|nss
libnspr4.so|libnspr4|nspr|nspr
libasound.so.2|libasound2|alsa-lib|alsa-lib
libgbm.so.1|libgbm1|mesa-libgbm|mesa
libdrm.so.2|libdrm2|libdrm|libdrm
libxkbcommon.so.0|libxkbcommon0|libxkbcommon|libxkbcommon
libatk-1.0.so.0|libatk1.0-0|atk|atk
libatk-bridge-2.0.so.0|libatk-bridge2.0-0|at-spi2-atk|at-spi2-atk
libatspi.so.0|libatspi2.0-0|at-spi2-core|at-spi2-core
libcups.so.2|libcups2|cups-libs|libcups
libpango-1.0.so.0|libpango-1.0-0|pango|pango
libpangocairo-1.0.so.0|libpango-1.0-0|pango|pango
libcairo.so.2|libcairo2|cairo|cairo
libX11.so.6|libx11-6|libX11|libx11
libX11-xcb.so.1|libx11-xcb1|libX11|libx11
libXcomposite.so.1|libxcomposite1|libXcomposite|libxcomposite
libXdamage.so.1|libxdamage1|libXdamage|libxdamage
libXfixes.so.3|libxfixes3|libXfixes|libxfixes
libXrandr.so.2|libxrandr2|libXrandr|libxrandr
libXext.so.6|libxext6|libXext|libxext
libxcb.so.1|libxcb1|libxcb|libxcb
libexpat.so.1|libexpat1|expat|expat
libsecret-1.so.0|libsecret-1-0|libsecret|libsecret
libdbus-1.so.3|libdbus-1-3|dbus-libs|dbus
libudev.so.1|libudev1|systemd-libs|systemd-libs
libuuid.so.1|libuuid1|libuuid|util-linux-libs
libz.so.1|zlib1g|zlib|zlib
libstdc++.so.6|libstdc++6|libstdc++|gcc-libs
libgcc_s.so.1|libgcc-s1|libgcc|gcc-libs
TABLE
  return 1
}

report_missing_libraries() {
  local missing="$1"
  local family apt_pkgs="" dnf_pkgs="" pacman_pkgs="" unmapped="" lib mapping
  family="$(detect_distro_family)"

  while IFS= read -r lib; do
    [ -n "$lib" ] || continue
    if mapping="$(library_package "$lib")"; then
      IFS='|' read -r apt_pkg dnf_pkg pacman_pkg <<<"$mapping"
      case " $apt_pkgs " in *" $apt_pkg "*) ;; *) apt_pkgs="$apt_pkgs $apt_pkg" ;; esac
      case " $dnf_pkgs " in *" $dnf_pkg "*) ;; *) dnf_pkgs="$dnf_pkgs $dnf_pkg" ;; esac
      case " $pacman_pkgs " in *" $pacman_pkg "*) ;; *) pacman_pkgs="$pacman_pkgs $pacman_pkg" ;; esac
    else
      unmapped="$unmapped $lib"
    fi
  done <<<"$missing"

  printf '%s: не хватает библиотек Electron:\n' "$PROG" >&2
  while IFS= read -r lib; do
    [ -n "$lib" ] && printf '  - %s\n' "$lib" >&2
  done <<<"$missing"

  case "$family" in
    apt)
      [ -n "${apt_pkgs# }" ] && info "Установите: sudo apt install -y${apt_pkgs}"
      ;;
    dnf)
      [ -n "${dnf_pkgs# }" ] && info "Установите: sudo dnf install -y${dnf_pkgs}"
      ;;
    pacman)
      [ -n "${pacman_pkgs# }" ] && info "Установите: sudo pacman -S --needed${pacman_pkgs}"
      ;;
    *)
      info "Дистрибутив не распознан. Установите пакеты, содержащие перечисленные библиотеки, средствами своего дистрибутива."
      ;;
  esac
  if [ -n "${unmapped# }" ]; then
    info "Для этих библиотек готового имени пакета нет:${unmapped} — найдите их в репозитории дистрибутива."
  fi
  info "Скрипт сам ничего не устанавливает; после установки библиотек запустите его снова."
}

check_dependencies() {
  local exe="$1" output missing
  if ! command -v ldd >/dev/null 2>&1; then
    warn "ldd не найден — проверка библиотек пропущена"
    return 0
  fi
  output="$(ldd "$exe" 2>&1 || true)"
  case "$output" in
    *"not a dynamic executable"*|*"not a dynamic object"*)
      warn "проверить библиотеки через ldd не удалось — проверка пропущена"
      return 0
      ;;
  esac
  missing="$(printf '%s\n' "$output" | awk '/not found$/ {print $1}' | sort -u)"
  if [ -z "$missing" ]; then
    return 0
  fi
  report_missing_libraries "$missing"
  return 1
}

# --- Скачивание и проверка ----------------------------------------------------

fetch_url() {
  local url="$1" dest="$2"
  case "$url" in
    file://*) cp -- "${url#file://}" "$dest" ;;
    https://*)
      curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 2 \
        --connect-timeout 20 -o "$dest" "$url"
      ;;
    *)
      curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 -o "$dest" "$url"
      ;;
  esac
}

resolve_latest_version() {
  local effective
  case "$RELEASE_BASE_URL" in
    file://*)
      die "для локального источника релизов укажите версию: --version X.Y.Z"
      ;;
  esac
  effective="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    --connect-timeout 20 "$RELEASE_BASE_URL/releases/latest" || true)"
  case "$effective" in
    */tag/v*) printf '%s\n' "${effective##*/tag/v}" ;;
    *)
      die "не удалось определить последнюю версию релиза (${RELEASE_BASE_URL}/releases/latest)"
      ;;
  esac
}

# Ожидаемый хеш ассета из SHA256SUMS. Формат — `<64 hex>  <имя>`; допускается
# `*` перед именем (бинарный режим sha256sum). Нет строки или хеш битый —
# установка прерывается так же, как при несовпадении (сценарий efd88e99).
expected_sha256() {
  local sums_file="$1" asset="$2"
  awk -v name="$asset" '
    {
      candidate = $2
      sub(/^\*/, "", candidate)
      sub(/\r$/, "", candidate)
      if (candidate == name) { print tolower($1); exit }
    }
  ' "$sums_file"
}

verify_archive() {
  local sums_file="$1" archive="$2" asset="$3"
  local expected actual
  expected="$(expected_sha256 "$sums_file" "$asset")"
  if ! printf '%s' "$expected" | grep -Eq '^[0-9a-f]{64}$'; then
    rm -f -- "$archive"
    die "в SHA256SUMS нет хеша для ${asset} — установка прервана, текущая версия не изменена"
  fi
  actual="$(sha256_of "$archive")"
  if [ "$actual" != "$expected" ]; then
    rm -f -- "$archive"
    die "SHA-256 не совпал для ${asset}: ожидалось ${expected}, получено ${actual}. Файл удалён, текущая версия не изменена"
  fi
  info "SHA-256 совпал: ${asset}"
}

# --- Установка ----------------------------------------------------------------

ensure_managed_base() {
  if [ -e "$BASE" ] && [ ! -e "$BASE/$MARKER_NAME" ]; then
    if [ -n "$(ls -A -- "$BASE" 2>/dev/null || true)" ]; then
      die "каталог ${BASE} занят посторонними файлами — установка не начата"
    fi
  fi
}

install_version() {
  local asset="ETN-Client-${VERSION}-linux-x64.tar.gz"
  local version_url="${RELEASE_BASE_URL}/releases/download/v${VERSION}"
  local staging final old

  ensure_managed_base

  # Владелец существующих каталогов проверяется до скачивания: root-овый
  # родитель из прошлой sudo-установки сделает результат непригодным.
  check_owner_chain "$TARGET_HOME/.local" "$TARGET_HOME/.local/opt" \
    "$TARGET_HOME/.local/share" "$DESKTOP_DIR" "$BASE"

  case "$RELEASE_BASE_URL" in
    file://*) ;;
    *) need_cmd curl ;;
  esac
  need_cmd tar
  detect_sha256_tool

  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/etn-install.XXXXXX")"

  info "ETN ${VERSION}: скачивание ${asset}"
  fetch_url "${version_url}/SHA256SUMS" "$WORKDIR/SHA256SUMS" \
    || die "не удалось скачать SHA256SUMS для версии ${VERSION} — установка не начата"
  fetch_url "${version_url}/${asset}" "$WORKDIR/${asset}" \
    || die "не удалось скачать ${asset} — установка не начата"

  verify_archive "$WORKDIR/SHA256SUMS" "$WORKDIR/${asset}" "$asset"

  staging="$WORKDIR/unpacked"
  mkdir -p "$staging"
  tar -xzf "$WORKDIR/${asset}" -C "$staging" \
    || die "не удалось распаковать ${asset} — архив повреждён"

  if [ ! -x "$staging/etn" ]; then
    die "в архиве ${asset} нет исполняемого файла etn — установка не начата"
  fi

  if ! check_dependencies "$staging/etn"; then
    die "не хватает системных библиотек — установка не начата, текущая версия не изменена"
  fi

  make_dirs "$BASE" || die "не удалось создать ${BASE}"
  final="$BASE/$VERSION"
  old="$BASE/.old-${VERSION}.$$"
  if [ -e "$final" ]; then
    mv -- "$final" "$old"
  fi
  mv -- "$staging" "$final"
  if [ -e "$old" ]; then
    rm -rf -- "$old"
  fi

  # Атомарное переключение current: новый симлинк создаётся рядом и
  # переименовывается поверх старого одной операцией rename(2).
  ln -sfn "$VERSION" "$BASE/.current.$$"
  mv -Tf -- "$BASE/.current.$$" "$BASE/current"

  printf 'version=%s\nsource=%s\ninstalled_at=%s\n' \
    "$VERSION" "$version_url" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$BASE/$MARKER_NAME"

  write_desktop_entry

  if [ -n "$BIN_LINK" ]; then
    make_dirs "$(dirname -- "$BIN_LINK")" || die "не удалось создать ${BIN_LINK%/*}"
    ln -sfn "$BASE/current/etn" "$BIN_LINK"
  fi

  if [ -n "$SUDO_TARGET_USER" ]; then
    chown -R "$SUDO_TARGET_USER:" "$BASE" "$DESKTOP_FILE" \
      || die "не удалось передать установленные файлы пользователю ${SUDO_TARGET_USER}: запустите скрипт без sudo"
  fi

  info "Установлено: ${BASE}/${VERSION} (симлинк current переключён)"
  info "Запуск из меню приложений или: ${BASE}/current/etn"
  info "Конфигурация клиента: ${CONFIG_DIR} (не изменялась)"
}

write_desktop_entry() {
  local icon_line="" executable
  executable="$BASE/current/etn"
  make_dirs "$DESKTOP_DIR" || die "не удалось создать ${DESKTOP_DIR}"
  if [ -f "$BASE/current/etn.png" ]; then
    icon_line="Icon=$BASE/current/etn.png"
  fi
  cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=ETN
Comment=ETN — графовая база знаний
Exec="$executable"
Terminal=false
Categories=Office;Utility;
StartupWMClass=ETN
$DESKTOP_MARKER
$icon_line
EOF
  chmod 644 "$DESKTOP_FILE"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true
  fi
}

# --- Удаление -----------------------------------------------------------------

desktop_file_is_ours() {
  [ -f "$1" ] && grep -q "^${DESKTOP_MARKER}$" "$1" 2>/dev/null
}

# Удаление требует записи в родительский каталог, а не в сам объект. Проверка
# до rm: иначе rm -rf сносит содержимое и только потом упирается в root-ового
# родителя — установка остаётся полуразобранной, без маркера, и повторить
# удаление уже нельзя. Root проходит проверку всегда.
can_unlink() {
  local parent
  parent="$(dirname -- "$1")"
  [ -d "$parent" ] && [ -w "$parent" ]
}

remove_scope() {
  local scope="$1" base desktop bin removed=0
  if [ "$scope" = "system" ]; then
    base="/opt/etn"
    desktop="/usr/share/applications/etn.desktop"
    bin="/usr/local/bin/etn"
  else
    base="$TARGET_HOME/.local/opt/etn"
    desktop="$TARGET_HOME/.local/share/applications/etn.desktop"
    if [ -z "$SUDO_TARGET_USER" ]; then
      desktop="${XDG_DATA_HOME:-$TARGET_HOME/.local/share}/applications/etn.desktop"
    fi
    bin=""
  fi

  if [ -e "$base" ]; then
    if [ ! -e "$base/$MARKER_NAME" ]; then
      warn "пропускаю ${base}: каталог не создан этим установщиком"
    elif [ "$scope" = "system" ] && [ "$EUID_NOW" -ne 0 ]; then
      die "удаление системной установки требует прав: sudo bash ${PROG} --uninstall"
    else
      # rm печатает причину (Permission denied и т. п.) в stderr. Код возврата
      # проверяется явно: вызов из `if remove_scope` отключает set -e, и раньше
      # скрипт сообщал «Удалено» на неудалённом каталоге, теряя маркер и
      # оставляя root-овый остаток, который нельзя убрать из-под пользователя.
      if ! can_unlink "$base"; then
        remove_failed "не удалось удалить ${base}: нет прав на запись в ${base%/*}. Каталог и его родители должны принадлежать пользователю; root-овую установку снимайте через sudo bash ${PROG} --uninstall"
      fi
      if ! rm -rf -- "$base"; then
        remove_failed "не удалось удалить ${base}: см. причину выше. Каталог и его родители должны принадлежать пользователю; root-овую установку снимайте через sudo bash ${PROG} --uninstall"
      fi
      if [ -e "$base" ]; then
        remove_failed "не удалось удалить ${base}: каталог остался на месте"
      fi
      info "Удалено: ${base}"
      removed=1
    fi
  fi

  if desktop_file_is_ours "$desktop"; then
    if [ "$scope" = "system" ] && [ "$EUID_NOW" -ne 0 ]; then
      die "удаление системного ярлыка требует прав: sudo bash ${PROG} --uninstall"
    fi
    if ! can_unlink "$desktop"; then
      remove_failed "не удалось удалить ${desktop}: нет прав на запись в ${desktop%/*}. Ярлык и его каталог должны принадлежать пользователю; root-овый ярлык снимайте через sudo bash ${PROG} --uninstall"
    fi
    if ! rm -f -- "$desktop"; then
      remove_failed "не удалось удалить ${desktop}: см. причину выше. Ярлык должен принадлежать пользователю; root-овый ярлык снимайте через sudo bash ${PROG} --uninstall"
    fi
    if [ -e "$desktop" ]; then
      remove_failed "не удалось удалить ${desktop}: файл остался на месте"
    fi
    info "Удалено: ${desktop}"
    removed=1
  fi

  if [ -n "$bin" ] && [ -L "$bin" ]; then
    case "$(readlink -- "$bin" 2>/dev/null || true)" in
      /opt/etn/*)
        if [ "$EUID_NOW" -eq 0 ]; then
          if ! rm -f -- "$bin"; then
            remove_failed "не удалось удалить ${bin}: см. причину выше"
          fi
          if [ -L "$bin" ]; then
            remove_failed "не удалось удалить ${bin}: симлинк остался на месте"
          fi
          info "Удалено: ${bin}"
          removed=1
        else
          die "удаление ${bin} требует прав: sudo bash ${PROG} --uninstall"
        fi
        ;;
      *) warn "пропускаю ${bin}: симлинк указывает не в /opt/etn" ;;
    esac
  fi

  if [ "$removed" -eq 1 ]; then
    return 0
  fi
  return 1
}

# Есть ли что удалять в системном режиме (для проверки прав до удаления).
system_removal_required() {
  if [ -e /opt/etn ] && [ -e "/opt/etn/$MARKER_NAME" ]; then
    return 0
  fi
  if desktop_file_is_ours /usr/share/applications/etn.desktop; then
    return 0
  fi
  if [ -L /usr/local/bin/etn ]; then
    case "$(readlink -- /usr/local/bin/etn 2>/dev/null || true)" in
      /opt/etn/*) return 0 ;;
    esac
  fi
  return 1
}

uninstall_client() {
  local removed_any=0 scope scopes

  if [ "$MODE" = "system" ]; then
    scopes="system"
  else
    scopes="user system"
  fi

  # Права проверяются до удаления, чтобы не оставить частично снятую установку.
  if [ "$EUID_NOW" -ne 0 ] && system_removal_required; then
    die "удаление системной установки требует прав: sudo bash ${PROG} --uninstall"
  fi

  for scope in $scopes; do
    if remove_scope "$scope"; then
      removed_any=1
    fi
  done

  if [ "$removed_any" -eq 0 ]; then
    info "Нечего удалять: установка ETN не найдена."
  elif [ -d "$CONFIG_DIR" ]; then
    info "Конфигурация сохранена: ${CONFIG_DIR}"
  fi
  exit 0
}

# --- Точка входа --------------------------------------------------------------

if [ "$ACTION" = "uninstall" ]; then
  uninstall_client
fi

check_architecture

if [ "$MODE" = "system" ] && [ "$EUID_NOW" -ne 0 ]; then
  die "системная установка требует прав root: sudo bash ${PROG} --system"
fi

if [ -z "$VERSION" ]; then
  need_cmd curl
  VERSION="$(resolve_latest_version)"
  if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$'; then
    die "не удалось разобрать версию последнего релиза: ${VERSION}"
  fi
fi

install_version
