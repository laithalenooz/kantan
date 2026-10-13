#!/bin/sh
#
# Runs kantan.sh on a machine with nothing on it, one dependency at a time.
#
#   sh docs/probes/install-rehearsal.sh
#
# Why this exists: the installer had never been run anywhere but its author's
# machine, where git, bun, node and claude were all already present. Every
# refusal in it - the four that tell a newcomer what to install - was therefore
# unexecuted code, and the first thing a stranger meets.
#
# Stages 1 to 4 supply each tool as a **stub**, which is faithful rather than
# lazy: the installer reaches those branches through `command -v` alone and does
# not invoke git, bun or node until the clone, so presence is the whole input.
# Stage 5 uses the real binaries.
#
# Needs docker. Nothing is installed on the host and nothing leaves the
# container; the only mount is this repository, read-only.
#
# `bun install` and `bun run build` in stage 5 reach registry.npmjs.org. On a
# network that intercepts TLS without a trusted CA - which is where this was
# written - that step fails and the script says so rather than passing quietly.
# Run it somewhere with ordinary egress to exercise the whole path.

set -eu

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
IMAGE=kantan-rehearsal:bare
BUN="${HOME}/.bun/bin/bun"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fail=$((fail + 1)); }
head2() { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ -x "$BUN" ] || { echo "no bun at $BUN - stage 5 needs it"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }

head2 "Building a machine with nothing on it"
cat > "$WORK/Dockerfile" <<'DOCKER'
FROM ubuntu:24.04
# Deliberately bare: no git, no node, no bun, no claude. /bin/sh here is dash,
# which is the point - it catches bashisms that a bash-hosted `sh -n` does not.
RUN mkdir -p /stage /work
ENV HOME=/root
WORKDIR /work
DOCKER
docker build -q -t "$IMAGE" "$WORK" >/dev/null
echo "  ubuntu:24.04, /bin/sh is dash, nothing else"

# Runs the installer with $1 as the colon-prefixed stage PATH additions, the
# remaining args as installer arguments. Captures stdout+stderr and the code.
run_stage() {
  stubs=$1
  shift
  docker run --rm \
    -v "$REPO_ROOT/kantan.sh:/work/kantan.sh:ro" \
    -e "STUBS=$stubs" \
    "$IMAGE" sh -c '
      for t in $STUBS; do
        printf "#!/bin/sh\nexit 0\n" > "/stage/$t"
        chmod +x "/stage/$t"
      done
      PATH="/stage:$PATH"
      export PATH
      sh /work/kantan.sh "$@" 2>&1
      printf "EXIT:%s\n" "$?"
    ' -- "$@" 2>&1
}

check() {
  label=$1; out=$2; want_code=$3; want_text=$4
  got_code=$(printf '%s' "$out" | sed -n 's/^EXIT:\([0-9]*\)$/\1/p' | tail -1)
  body=$(printf '%s' "$out" | grep -v '^EXIT:')
  if [ "$got_code" != "$want_code" ]; then
    bad "$label - exited $got_code, expected $want_code"
    printf '       %s\n' "$body" | head -4
    return
  fi
  if [ -n "$want_text" ] && ! printf '%s' "$body" | grep -qF "$want_text"; then
    bad "$label - exit $got_code correct, but did not mention '$want_text'"
    printf '       %s\n' "$body" | head -4
    return
  fi
  ok "$label"
  printf '       %s\n' "$(printf '%s' "$body" | grep -iE 'needs|not on your PATH' | head -1)"
}

head2 "The four refusals a newcomer meets, in the order they meet them"
check "nothing installed       names git"    "$(run_stage '')"                   1 "needs git"
check "git only               names bun"     "$(run_stage 'git')"                1 "needs bun"
check "git, bun               names node"    "$(run_stage 'git bun')"            1 "needs node"
check "git, bun, node         names claude"  "$(run_stage 'git bun node')"       1 "claude CLI is not on your PATH"

head2 "Each refusal carries the command that fixes it"
for pair in 'git:package manager' 'bun:bun.sh/install' 'node:Node 20'; do
  tool=${pair%%:*}; want=${pair#*:}
  case $tool in
    git)  stubs='' ;;
    bun)  stubs='git' ;;
    node) stubs='git bun' ;;
  esac
  out=$(run_stage "$stubs")
  if printf '%s' "$out" | grep -qF "$want"; then
    ok "missing $tool suggests '$want'"
  else
    bad "missing $tool does not suggest '$want'"
  fi
done

head2 "Arguments"
out=$(run_stage 'git bun node claude' --help)
if printf '%s' "$out" | grep -qF 'curl -fsSL https://get.kantan.sh | sh' && printf '%s' "$out" | grep -q '^EXIT:0$'; then
  ok "--help prints the header and exits 0"
else
  bad "--help did not print the header and exit 0"
fi
check "an unknown option exits 2" "$(run_stage 'git bun node claude' --nonsense)" 2 "unknown option"

head2 "What it must not do"
# Comments stripped first: the one occurrence of the word is the header line
# promising the script never uses it, and an assertion that cannot tell a
# promise from a call is worse than none.
if grep -vE '^[[:space:]]*#' "$REPO_ROOT/kantan.sh" | grep -qE '(^|[^[:alnum:]])sudo([^[:alnum:]]|$)'; then
  bad "the script calls sudo"
else
  ok "no sudo on any executable line"
fi
if grep -qE '\.bashrc|\.zshrc|\.profile|/etc/paths' "$REPO_ROOT/kantan.sh"; then
  bad "the script touches a shell dotfile"
else
  ok "touches no shell dotfile and edits no PATH"
fi
if grep -q '<' "$REPO_ROOT/kantan.sh"; then
  bad "the script contains a left angle bracket, which get.kantan.sh serves as text/html"
else
  ok "no left angle bracket - safe to read in a browser before piping"
fi

head2 "Every documented one-liner survives the redirect"
# The bug this guards against shipped in three release notes, the README, the
# landing page's hero and its copy button, and this script's own header.
#
# `curl get.kantan.sh | sh` is broken, and silently. curl assumes http when the
# scheme is left off; the host answers 308 to https with a body of
# "Redirecting..."; curl without -L prints that body and exits **0**. So the
# pipe feeds "Redirecting..." to sh and the install does nothing while looking
# like it ran. `-f` does not catch it, because a 308 is not an error.
#
# So the rule is the class, not the instance: anything piped into a shell must
# name its scheme or pass -L. Checked across every file a reader copies from.
bare=0
# The marketing files this once also covered moved to a private repo on
# 2026-10-13. The same rule applies to them there, and the posts drafted in
# them are where a bare one-liner would reach the most people - worth a glance
# before posting.
for f in README.md CONTRIBUTING.md kantan.sh docs/media/README.md \
         docs/probes/README.md test/fixtures/README.md; do
  [ -f "$REPO_ROOT/$f" ] || continue
  # Lines that pipe curl into a shell, minus the one sentence in kantan.sh that
  # quotes the broken form in order to warn about it.
  hits=$(grep -n 'curl[^|]*|[[:space:]]*sh' "$REPO_ROOT/$f" \
    | grep -v 'is not one of them' \
    | grep -v 'not decoration' \
    | grep -vE 'curl -[a-zA-Z]*L|curl [^|]*https://' || true)
  if [ -n "$hits" ]; then
    bad "$f pipes curl into sh without a scheme or -L"
    printf '       %s\n' "$hits" | head -3
    bare=$((bare + 1))
  fi
done
[ "$bare" -eq 0 ] && ok "no bare one-liner in any file a reader copies from"

head2 "A step that fails says something of its own"
# The four refusals above were always there. These were not: until this probe
# tripped the clone branch, a clone, a pull, an install or a build that failed
# died on `set -e` with the tool's raw message and nothing from kantan.
out=$(docker run --rm \
  -v "$REPO_ROOT/kantan.sh:/work/kantan.sh:ro" \
  "$IMAGE" sh -c '
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq git >/dev/null 2>&1
    for t in bun node claude; do
      printf "#!/bin/sh\nexit 0\n" > "/stage/$t"; chmod +x "/stage/$t"
    done
    PATH="/stage:$PATH"; export PATH
    KANTAN_REPO=/src/definitely-not-here.git KANTAN_DIR=/root/.local/share/kantan \
      sh /work/kantan.sh 2>&1
    printf "EXIT:%s\n" "$?"
  ' 2>&1)
check "a clone that fails is explained, not just reported" "$out" 1 "Could not clone"
if printf '%s' "$out" | grep -qF "http.proxy"; then
  ok "and it names the usual causes"
else
  bad "but it does not name a cause"
fi

head2 "The whole path, against a local clone"
# KANTAN_REPO and KANTAN_DIR are both overridable, so the clone can come from a
# bare repository on disk. That takes github.com out of the test and leaves the
# installer's own logic as the only thing under test.
git clone -q --bare "$REPO_ROOT" "$WORK/kantan.git"
# node:20-slim for this stage only. The bare image is the right machine for the
# four refusals; it is the wrong one for the happy path, because Ubuntu 24.04's
# apt gives Node 18 and the build then fails for a reason that has nothing to do
# with the installer. That failure is worth knowing - it is why the warning
# above the clone exists - and it is checked on its own below.
out=$(docker run --rm \
  -v "$REPO_ROOT/kantan.sh:/work/kantan.sh:ro" \
  -v "$WORK/kantan.git:/src/kantan.git:ro" \
  -v "$BUN:/usr/local/bin/bun:ro" \
  node:20-slim sh -c '
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq git >/dev/null 2>&1
    printf "#!/bin/sh\necho 2.1.296\n" > /usr/local/bin/claude
    chmod +x /usr/local/bin/claude
    # The bare repo is mounted from the host, so inside the container it belongs
    # to another uid and git refuses it as dubious ownership. That is this
    # harness, not the installer - the first run of this probe spent its stage 5
    # proving it, and the message was the same `safe.directory` case that
    # `requireUsableRepo` enumerates in src/git.ts.
    git config --global --add safe.directory /src/kantan.git
    KANTAN_REPO=/src/kantan.git KANTAN_DIR=/root/.local/share/kantan \
      sh /work/kantan.sh 2>&1
    printf "EXIT:%s\n" "$?"
  ' 2>&1)
code=$(printf '%s' "$out" | sed -n 's/^EXIT:\([0-9]*\)$/\1/p' | tail -1)
for step in 'Checking what is here' 'Cloning into' 'Installing dependencies' 'Building the interface' 'Installed in'; do
  if printf '%s' "$out" | grep -qF "$step"; then
    ok "reached: $step"
  else
    bad "never reached: $step"
  fi
done
printf '\n  installer exited %s\n' "$code"
if [ "$code" != "0" ]; then
  printf '  last lines:\n'
  printf '%s\n' "$out" | grep -v '^EXIT:' | tail -8 | sed 's/^/    /'
fi

head2 "Node 18 is warned about before the clone, not only after the build"
out=$(docker run --rm \
  -v "$REPO_ROOT/kantan.sh:/work/kantan.sh:ro" \
  "$IMAGE" sh -c '
    apt-get update -qq >/dev/null 2>&1
    apt-get install -y -qq nodejs >/dev/null 2>&1
    for t in git bun claude; do
      printf "#!/bin/sh\nexit 0\n" > "/stage/$t"; chmod +x "/stage/$t"
    done
    PATH="/stage:$PATH"; export PATH
    KANTAN_REPO=/src/nope.git sh /work/kantan.sh 2>&1
    printf "EXIT:%s\n" "$?"
  ' 2>&1)
if printf '%s' "$out" | grep -qF "Vite needs 20 or newer"; then
  ok "says so up front ($(printf '%s' "$out" | sed -n 's/.*node here is \(v[0-9.]*\).*/\1/p' | head -1))"
else
  bad "no early warning about the node version"
fi
if printf '%s' "$out" | grep -qF "Carrying on"; then
  ok "and carries on rather than refusing"
else
  bad "the warning refused instead of continuing"
fi

head2 "Result"
printf '  %s passed, %s failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
