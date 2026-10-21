#!/usr/bin/env bash
# Installe Cornelius sur Linux : Debian, Ubuntu, Arch et leurs dérivées.
#
# Usage : scripts/install-linux.sh [options]
#   --system-deps         installe les paquets du système (apt ou pacman, avec sudo)
#   --gpu auto|cpu|nvidia|amd
#                         moteur ONNX de la vision locale (auto : NVIDIA si présent, sinon CPU ;
#                         amd : MIGraphX, réservé aux Radeon dédiées prises en charge par ROCm)
#   --wake                installe le mot d’appel local (openWakeWord)
#   --no-models           ne télécharge pas les modèles (visages, voix, vision 450m)
#   --no-build            ne compile pas l’interface
#   --systemd             installe et démarre les services utilisateur (serveur, perception)
#   -h, --help            affiche cette aide
#
# Le script est rejouable : il garde .env, l’environnement Python et les modèles déjà vérifiés.
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

system_deps=0
gpu=auto
wake=0
models=1
build=1
systemd=0
while [ $# -gt 0 ]; do
  case "$1" in
    --system-deps) system_deps=1 ;;
    --gpu) gpu="${2:-}"; shift ;;
    --wake) wake=1 ;;
    --no-models) models=0 ;;
    --no-build) build=0 ;;
    --systemd) systemd=1 ;;
    -h | --help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $1 (voir --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$gpu" in auto | cpu | nvidia | amd) ;; *) echo "--gpu attend auto, cpu, nvidia ou amd." >&2; exit 2 ;; esac

# Version de uv utilisée seulement si Python 3.12 manque au système.
UV_VERSION=0.12.23
# ONNX Runtime MIGraphX publié par AMD pour ROCm (même version que la doc AMD).
ROCM_RELEASE=7.2.1

step() { printf '\n== %s\n' "$1"; }
warn() { printf 'Attention : %s\n' "$1" >&2; }
die() { printf 'Erreur : %s\n' "$1" >&2; exit 1; }

cd "$ROOT"
init_dirs

# --- Distribution ----------------------------------------------------------------
family=other
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" arch "*) family=arch ;;
    *" debian "* | *" ubuntu "*) family=debian ;;
  esac
fi
echo "Distribution : ${PRETTY_NAME:-inconnue} (famille $family)."

if [ "$system_deps" = 1 ]; then
  step "Paquets du système"
  case "$family" in
    debian)
      sudo apt-get update
      sudo apt-get install -y git ca-certificates curl python3 python3-venv iproute2 procps
      ;;
    arch) sudo pacman -S --needed --noconfirm git python uv iproute2 procps-ng ;;
    *) warn "distribution non reconnue : installez git, Python 3 et Node.js 24." ;;
  esac
fi

# --- Node.js 24 (fichier .nvmrc) -----------------------------------------------------
step "Node.js"
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===24&&b>=2?0:1)'
}
if ! node_ok && command -v fnm >/dev/null 2>&1; then
  fnm install "$(cat .nvmrc)" && eval "$(fnm env)" && fnm use "$(cat .nvmrc)"
fi
if ! node_ok && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" && nvm install && nvm use
fi
if ! node_ok; then
  die "Node.js 24.2 ou plus récent (version 24) est requis, voir .nvmrc. Sans droits administrateur :
  curl -fsSL https://fnm.vercel.app/install | bash
puis ouvrez un nouveau terminal et relancez ce script (il installera la version de .nvmrc)."
fi
NODE_BIN="$(node -p 'process.execPath')"
echo "Node $(node --version) : $NODE_BIN"

step "Dépendances Node et configuration"
ensure_pnpm
pnpm install --frozen-lockfile
pnpm run setup
if [ "$build" = 1 ]; then pnpm run build; fi

# --- Python 3.12 pour la perception -------------------------------------------------------
step "Python 3.12 (perception)"
venv_is_312() {
  .venv/bin/python -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)'
}
if [ -x .venv/bin/python ]; then
  # Un environnement existant est gardé : le supprimer reste un choix explicite.
  venv_is_312 || warn ".venv n’utilise pas Python 3.12 (version validée) ; supprimez-le pour le recréer."
else
  if command -v python3.12 >/dev/null 2>&1; then
    python3.12 -m venv .venv
  else
    # Debian 12 fournit 3.11, Debian 13 et Arch une version plus récente : uv installe un
    # Python 3.12 autonome, sans toucher au Python du système.
    uv_bin="$(command -v uv || true)"
    if [ -z "$uv_bin" ]; then
      python3 -m venv .local/uv
      .local/uv/bin/python -m pip install --quiet "uv==$UV_VERSION"
      uv_bin="$ROOT/.local/uv/bin/uv"
    fi
    "$uv_bin" venv --seed --python 3.12 .venv
  fi
fi
[ -x .venv/bin/python ] || die "impossible de créer .venv avec Python 3.12."
.venv/bin/python -m pip install --disable-pip-version-check --quiet --upgrade pip
.venv/bin/python -m pip install --disable-pip-version-check -r perception/requirements.txt

# --- Accélération de la vision locale (ONNX Runtime) -----------------------------------
step "Vision locale : moteur ONNX"
has_nvidia() { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; }
if [ "$gpu" = auto ]; then
  if has_nvidia; then gpu=nvidia; else gpu=cpu; fi
fi
case "$gpu" in
  nvidia)
    .venv/bin/python -m pip uninstall -y onnxruntime onnxruntime-migraphx >/dev/null 2>&1 || true
    .venv/bin/python -m pip install --disable-pip-version-check -r perception/requirements-gpu.txt
    ;;
  amd)
    [ -d /opt/rocm ] || die "ROCm est absent (/opt/rocm) : installez-le d’abord (docs/installation/gpu.md)."
    warn "MIGraphX n’est pris en charge par AMD que sur les Radeon dédiées. Sur un Ryzen AI (Radeon 890M),
gardez --gpu cpu pour la vision et utilisez ROCm pour la génération d’images (docs/installation/gpu.md)."
    .venv/bin/python -m pip uninstall -y onnxruntime onnxruntime-gpu >/dev/null 2>&1 || true
    .venv/bin/python -m pip install --disable-pip-version-check onnxruntime-migraphx \
      -f "https://repo.radeon.com/rocm/manylinux/rocm-rel-$ROCM_RELEASE/"
    ;;
  cpu) echo "Vision sur le CPU (graphes q4)." ;;
esac

if [ "$models" = 1 ]; then
  step "Modèles locaux (vérifiés par SHA-256)"
  .venv/bin/python perception/download_models.py --device auto
fi

if [ "$wake" = 1 ]; then
  step "Mot d’appel local"
  .venv/bin/python -m pip install --disable-pip-version-check -r perception/requirements-wake.txt
  .venv/bin/python -m pip install --disable-pip-version-check --no-deps openwakeword==0.6.0
  .venv/bin/python perception/install_wake_features.py
  [ -f models/cornelius.onnx ] || warn "placez le modèle du mot d’appel dans models/cornelius.onnx (docs/fonctionnalites/mot-d-appel.md)."
fi

# --- Accès à la caméra --------------------------------------------------------------------
step "Caméra"
cameras="$(ls /dev/video* 2>/dev/null || true)"
if [ -z "$cameras" ]; then
  warn "aucune caméra /dev/video* détectée."
else
  for camera in $cameras; do
    if [ ! -r "$camera" ]; then
      warn "$camera n’est pas lisible : sudo usermod -aG video \"$USER\" puis reconnectez-vous."
      break
    fi
  done
  echo "Caméras : $(echo "$cameras" | tr '\n' ' ')"
fi

# --- Services systemd utilisateur -------------------------------------------------------
if [ "$systemd" = 1 ]; then
  step "Services systemd (utilisateur)"
  command -v systemctl >/dev/null 2>&1 || die "systemd est absent : utilisez scripts/start.sh."
  port="$(server_port)"
  units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$units"
  cat >"$units/cornelius.service" <<UNIT
[Unit]
Description=Cornelius, serveur du miroir

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE_BIN --env-file-if-exists=.env --import tsx server/index.ts
Restart=always
RestartSec=3
# Le serveur ferme la session distante et arrête le worker d’images avant de quitter.
TimeoutStopSec=20

[Install]
WantedBy=default.target
UNIT
  cat >"$units/cornelius-perception.service" <<UNIT
[Unit]
Description=Cornelius, perception locale (caméra, voix, vision)
After=cornelius.service
Wants=cornelius.service

[Service]
WorkingDirectory=$ROOT
ExecStart=$ROOT/.venv/bin/python $ROOT/perception/worker.py
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  # Ancienne unité du mode kiosque, retirée du projet : elle ne doit plus démarrer.
  systemctl --user disable --now cornelius-kiosk.service 2>/dev/null || true
  rm -f "$units/cornelius-kiosk.service"
  systemctl --user daemon-reload
  systemctl --user enable --now cornelius.service cornelius-perception.service
  echo "Services actifs. Journaux : journalctl --user -u cornelius -f"
  if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != yes ]; then
    echo "Pour démarrer sans ouverture de session : sudo loginctl enable-linger \"$USER\""
  fi
fi

step "Terminé"
port="$(server_port)"
echo "Administration : http://127.0.0.1:$port/admin (mot de passe dans .env, à changer)."
grep -q '^OPENAI_API_KEY=.' .env || echo "Renseignez OPENAI_API_KEY dans .env pour la conversation."
[ "$systemd" = 1 ] || echo "Démarrage : scripts/start.sh (arrêt : scripts/stop.sh), ou relancez avec --systemd."
