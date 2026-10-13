#!/bin/sh
#
# kantan installer.  curl -fsSL kantan.sh/install.sh | sh
#
# What it does, in order, and nothing else:
#
#   1. checks for git, bun and node, and stops with the one command that fixes
#      whichever is missing
#   2. clones (or fast-forwards) kantan into ~/.local/share/kantan
#   3. installs its dependencies and builds the interface
#   4. prints the command that runs it
#
# What it deliberately does NOT do, because this is a script piped into a
# shell and every one of these would be a surprise:
#
#   * run anything with sudo, or write outside the install directory
#   * install bun or node for you - a script that installs a language runtime
#     behind your back is the thing you were right to be suspicious of
#   * edit your PATH, your shell profile, or any dotfile
#   * start the server, unless you pass --start. A server that holds the
#     terminal is a bad default for something you may be running over ssh
#   * send anything anywhere. kantan binds 127.0.0.1 and talks to no service
#
# Read it before you run it. That is the whole reason it is this short.

set -eu

REPO="${KANTAN_REPO:-https://github.com/laithalenooz/kantan.git}"
DIR="${KANTAN_DIR:-$HOME/.local/share/kantan}"
START=0
for arg in "$@"; do
  case "$arg" in
    --start) START=1 ;;
    --dir=*) DIR="${arg#--dir=}" ;;
    -h|--help)
      sed -n '2,30p' "$0" 2>/dev/null || echo "kantan installer: --start, --dir=PATH"
      exit 0
      ;;
    *) echo "kantan: unknown option $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;38;5;208m▸\033[0m %s\n' "$1"; }
warn() { printf '\033[1;31m✕\033[0m %s\n' "$1" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  warn "kantan needs $1, which is not on your PATH."
  printf '  %s\n' "$2" >&2
  exit 1
}

say "Checking what is here."
need git  'Install git from your package manager, then run this again.'
# Standalone on purpose: a bun under an nvm-scoped npm prefix disappears from
# PATH the moment the node version changes.
need bun  'curl -fsSL https://bun.sh/install | bash     # standalone, not via npm'
# Node is needed for exactly one step - Vite, which builds the interface.
need node 'Install Node 20 or newer; it is needed only to build the interface.'

if ! command -v claude >/dev/null 2>&1; then
  warn "The claude CLI is not on your PATH."
  printf '  kantan drives the real binary, so it cannot do anything without it.\n' >&2
  printf '  Install Claude Code and log in, then run this again.\n' >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  say "Updating the copy in $DIR."
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR."
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"
say "Installing dependencies."
bun install

say "Building the interface."
bun run build

printf '\n'
say "Installed in $DIR"
printf '\n'
printf '  Run it:      cd %s && bun run server\n' "$DIR"
printf '  Then open:   http://127.0.0.1:3100\n'
printf '\n'
printf '  Two things it needs from you: the claude CLI logged in, and a repo with a\n'
printf '  docs/features/<slug>.md holding "- [ ] T1 ..." lines.\n'
printf '\n'

if [ "$START" -eq 1 ]; then
  say "Starting kantan on http://127.0.0.1:3100  (ctrl-c to stop)"
  exec bun run server
fi
