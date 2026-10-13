# The flow recording

`flow.mp4` and `flow.gif` show one task going through the whole pipeline: a plan
waiting at the gate, a human approving it, an implement phase, a **failing** test
run, a refine, a passing test run, and a finished task on a merged branch.

Both are produced by [`docs/probes/record.ts`](../probes/record.ts):

```bash
bun run build                        # the recording is of the built UI
bun run docs/probes/record.ts        # writes docs/media/flow.{mp4,gif}
```

## What is real in it, and what is not

This matters more here than for an ordinary screenshot, because a launch asset
that overstates itself is the one thing this project cannot afford to ship — the
README's whole argument is that kantan tells you what it actually observed.

**Real:** the server, the HTTP routes, the run log on disk, the SSE replay, the
fold in `src/runindex.ts`, every component, and the click. Pressing **Approve
plan** in the recording really does drive the transition: the server is
constructed with a `Runner`, the route really calls it, and the phase records
really land in a real JSONL file that the page is really tailing. Nothing inside
the application is stubbed, and the recorder presses the button through CDP
rather than dispatching a synthetic state change.

The git is real too: the fixture repository really has a `kantan/<task>` branch
with the work committed on it.

**The clip ends on "It finished while you were away. The branch is not
merged."** That is not an unfinished fixture — it is what kantan shows for every
finished task, and it took a wrong turn to find out. I first merged the branch
into `main` to make the last frame read *Passed*, and both halves of that were
wrong. It changes nothing, because `readProjects` in `src/tree.ts` passes
`indexRuns` no merge predicate at all: resolving a base branch outside a run
that was started from one is not possible, and a per-row git call takes the fold
from 89–180ms to 2733ms over 500 logs. And it would have been *less* faithful if
it had worked, because kantan returns the checkout to base on `done` and leaves
the tick on the task branch for a human to merge. Unmerged is the state of a run
that has just finished.

So the last beat is the honest one, and it is also the better one: the work is
done, it is on its own branch, and the decision to merge is still yours.

**Not real:** the agent. The `Runner` the recorder supplies writes the records a
`claude` child would have written, on a timer, instead of spawning one. So the
clip is a **re-enactment of a run that did happen** — the record sequence was
checked field by field against the real logs in `~/.orch/runs`, down to the gate
record carrying both `planPath` and `detail` — rather than a staged mock of a
UI. The two costs it avoids are money and determinism: a real billed
run per take, and a take is never right the first time.

The figures on screen follow from that. `$0.63` is the sum of the `result`
records the re-enactment writes, which the UI adds up itself; it is a plausible
number for this task rather than a measured one. The timings in the phase rail
are the real elapsed times of the recording.

**`Test` shows a dash rather than a duration**, and that is the product too. A
phase record is only ever `running` or `waiting` — there is no closing record —
so a phase's elapsed time comes from whatever record follows it, and the last
test phase before `end` has nothing after it to measure against. Both real logs
on the machine this was written on end the same way.

**If you want a clip with no re-enactment in it at all**, point `record.ts` at a
project and let the real runner drive: delete the `runner` option so
`createServer` gets `createRunner(...)`, and keep the CDP capture. That costs
one real run, and it is the right thing to do before anyone claims a *measured*
figure from a recording.

## Why the frames carry timestamps

The capture loop cannot hold a fixed rate — a `Page.captureScreenshot` round
trip varies with what the page is painting. So each frame is recorded with the
time it was taken and handed to ffmpeg through a concat list with explicit
per-frame durations. A fixed `-framerate` would play the clip back at whatever
rate the loop happened to manage, which drifts most during the transitions,
which is exactly where the clip is worth watching.

The GIF is built from the MP4 through a palette generated over the whole clip,
not per frame: a per-frame palette bands the orange.
