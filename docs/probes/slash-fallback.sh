#!/bin/sh
#
# What the real CLI does with a slash command that does not resolve.
#
#   sh docs/probes/slash-fallback.sh --spend
#
# **This spends real money** - about $0.25 at the time of writing - so it will
# not run without `--spend`. One short turn against the real binary; there is no
# other way to answer the question, because a fake `claude` would only tell you
# what the fake does.
#
# ## Why it was asked
#
# Both of kantan's phase prompts open by invoking a plugin skill: `planPrompt`
# with `/superpowers:writing-plans`, `implementPrompt` with
# `/superpowers:executing-plans`. So the product depends on a plugin, and for
# two days that was documented nowhere a user reads - not the README, not
# CONTRIBUTING, not `kantan.sh`, which checks for git, bun, node and `claude`
# and not for this.
#
# Whether that was a documentation gap or a broken product turned on one
# unknown: what does `claude -p` do when the command at the start of the prompt
# does not exist on that machine? Nobody had tried it.
#
# ## The measurement, 2026-10-13, Claude Code 2.1.296
#
# **The command is passed through to the model as literal text.** The CLI does
# not fail, does not warn, and does not strip it. Measured with a command that
# cannot exist anywhere:
#
#     claude -p "/zzz-not-a-real-command-9f3a Reply with the single word OK..."
#     -> assistant: "OK"
#     -> result: subtype=success  is_error=false  total_cost_usd=0.209
#
# So the first line of the prompt becomes a meaningless token and every
# instruction after it is obeyed normally. A missing plugin costs the skill's
# discipline - plans and implementations done task by task - and costs nothing
# else: the gate, the test run, the exit-code branch and the sentinel are all
# kantan's own.
#
# That makes it a documentation gap, which is what was fixed. `test/prompts.test.ts`
# pins that every `/plugin:skill` a prompt invokes is named in the README, so a
# second undocumented dependency cannot be added quietly, and `kantan.sh` warns
# when the plugin is absent without refusing to install.
#
# A note on the budget, since it surprised me: the first attempt capped at $0.05
# and was refused with `Exceeded USD budget (0.05)` before producing anything.
# A single trivial turn carrying a full global config costs more than that.
# kantan's own default ceiling is $50, so this is nothing to do with kantan -
# but it is worth knowing before setting a per-run budget by eye.

set -eu

case "${1:-}" in
  --spend) ;;
  *)
    echo "This probe spends about \$0.25 of real API budget. Pass --spend to run it." >&2
    echo "The finding it recorded is in the comment at the top of this file." >&2
    exit 2
    ;;
esac

command -v claude >/dev/null 2>&1 || { echo "no claude on PATH" >&2; exit 1; }

# Somewhere with no CLAUDE.md of its own, so the only context is the global one.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# A command that cannot exist on any machine, which is the point: it stands in
# for `/superpowers:executing-plans` on a machine without that plugin, without
# needing to uninstall anything or fake a config directory.
PROMPT='/zzz-not-a-real-command-9f3a Reply with the single word OK and nothing else.'

printf 'asking the real CLI (%s)...\n\n' "$(claude --version)"
claude -p --max-budget-usd 0.60 --output-format stream-json --verbose "$PROMPT" > out.jsonl 2>err.txt || true

if [ -s err.txt ]; then
  printf 'stderr:\n'
  sed 's/^/  /' err.txt
fi

# Only the two lines that answer the question.
printf '\nwhat came back:\n'
grep -o '"type":"assistant".*' out.jsonl 2>/dev/null | head -1 | cut -c1-160 | sed 's/^/  /' || true
python3 - <<'PY' 2>/dev/null || grep -o '"subtype":"[a-z_]*"' out.jsonl | tail -1
import json, sys
for line in open("out.jsonl"):
    try: o = json.loads(line)
    except Exception: continue
    if o.get("type") == "result":
        print(f'  result: subtype={o.get("subtype")} is_error={o.get("is_error")} '
              f'cost=${o.get("total_cost_usd")} result={json.dumps(str(o.get("result"))[:80])}')
    elif o.get("type") == "assistant":
        for c in o.get("message", {}).get("content", []):
            if c.get("type") == "text" and c.get("text", "").strip():
                print(f'  assistant: {json.dumps(c["text"][:80])}')
PY

printf '\nRead it against the claim at the top of this file: a `result/success` with\n'
printf 'the instruction obeyed means an unresolvable command is passed through, and\n'
printf 'kantan degrades rather than breaking. Anything else means that has changed,\n'
printf 'and the README and kantan.sh both say otherwise and need revisiting.\n'
