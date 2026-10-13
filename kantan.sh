#!/bin/sh
#
# kantan installer.  curl -fsSL https://get.kantan.sh | sh
#
# Two URLs fetch this file, and they are the only two:
#
#     curl -fsSL https://get.kantan.sh | sh         what the README and the site say
#     curl -fsSL https://kantan.sh/install.sh | sh  the same bytes, served by the site
#
# The scheme and the -L are not decoration, and the bare "curl get.kantan.sh"
# this file advertised until now was broken. curl assumes http when you leave
# the scheme off; the host answers 308 to https with a body of "Redirecting...";
# and curl without -L prints that body and exits 0. So the pipe fed
# "Redirecting..." to your shell and the install quietly did nothing. -f does
# not catch it either, because a 308 is not an error.
#
# "curl kantan.sh | sh" is not one of them. That is the landing page, and it
# pipes a page of HTML into your shell. The separate host exists because a
# script and a web page cannot safely share one root path.
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
#
# It carries no left angle bracket, deliberately - which is why this paragraph
# describes the character instead of printing it, and why the line above says
# "a page of HTML" rather than quoting a doctype. get.kantan.sh serves this
# file as the subdomain's index and the host labels an index `text/html`. curl
# does not care, but a browser would swallow anything shaped like a tag, so a
# reader checking the script before piping it would be shown a line with a word
# missing - and the sentence promising the file is safe to read is a poor one to
# lose. Avoiding one character is cheaper than configuring a host to send a
# different content type.

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

# The first line is the problem, the rest is what to do about it. Added because
# the four steps further down could fail for reasons outside this script and
# said nothing: `set -e` killed it on the tool's raw message. Found by
# docs/probes/install-rehearsal.sh, which tripped the clone branch by accident.
die() {
  warn "$1"
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

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

# Advisory, never a refusal, and the asymmetry is why. `apt install nodejs` on
# Ubuntu 24.04 and on Debian gives Node 18, which passes the check above and
# then fails Vite at the very last step - measured, which is the only reason
# this warning exists: docs/probes/install-rehearsal.sh reached "Building the
# interface" and died there on v18.19.1.
#
# The dimension is what `node --version` prints. Its values include v18.19.1,
# v20.x, v22.x, an odd-numbered build, and - for a `node` that is a wrapper, or
# not Node at all - something with no version in it. Refusing a good node blocks
# an install that would have worked and leaves no way round it; letting a bad
# one through costs a build failure that already names the cause and says the
# rest is installed. So this never refuses, and when it cannot read a major
# version it says nothing rather than guessing.
node_major=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')
if [ -n "$node_major" ] && [ "$node_major" -lt 20 ]; then
  warn "node here is $(node --version), and Vite needs 20 or newer."
  printf '  Carrying on, because node builds the interface and nothing else: the\n' >&2
  printf '  clone and the install will work and only the last step will fail.\n' >&2
fi

if ! command -v claude >/dev/null 2>&1; then
  warn "The claude CLI is not on your PATH."
  printf '  kantan drives the real binary, so it cannot do anything without it.\n' >&2
  printf '  Install Claude Code and log in, then run this again.\n' >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  say "Updating the copy in $DIR."
  git -C "$DIR" pull --ff-only || die \
    "Could not update the copy in $DIR." \
    "git's message is above. A refused fast-forward usually means commits of" \
    "your own are sitting there." \
    "See them:      cd $DIR  &&  git log --oneline @{u}..HEAD" \
    "Or start over: rm -rf $DIR, then run this again."
else
  say "Cloning into $DIR."
  mkdir -p "$(dirname "$DIR")" || die \
    "Could not create $(dirname "$DIR")." \
    "Check the permissions, or pass --dir=PATH pointing somewhere you can write."
  git clone --depth 1 "$REPO" "$DIR" || die \
    "Could not clone $REPO." \
    "git's message is above. The usual causes are no network, a proxy that needs" \
    "http.proxy set, and a half-written $DIR left by an earlier attempt - if that" \
    "directory exists and is not a repository, remove it and run this again."
fi

cd "$DIR"
say "Installing dependencies."
bun install || die \
  "bun install failed in $DIR." \
  "bun's message is above; it is usually the registry or a proxy in the way." \
  "Nothing is broken on your machine - run this again when it can reach one."

say "Building the interface."
bun run build || die \
  "The interface did not build." \
  "Vite needs Node 20 or newer, and node here reports $(node --version 2>/dev/null || echo unknown)." \
  "That is the usual cause, and it is the only step node is needed for: the" \
  "server and the tests run on bun, so everything else is already installed."

printf '\n'
say "Installed in $DIR"
printf '\n'
printf '  Run it:      cd %s && bun run server\n' "$DIR"
printf '  Then open:   http://127.0.0.1:3100\n'
printf '\n'
printf '  Two things it needs from you: the claude CLI logged in, and a repo with a\n'
printf '  docs/features/NAME.md holding "- [ ] T1 ..." lines.\n'
printf '\n'

if [ "$START" -eq 1 ]; then
  say "Starting kantan on http://127.0.0.1:3100  (ctrl-c to stop)"
  exec bun run server
fi
