# Captured test-runner output

Real output from real runners, for `src/stall.ts`. **Nothing here is hand-written.** A normalizer
tuned to one runner's output is not a normalizer, and every assumption about a format that was
guessed rather than captured turned out to be wrong at least once:

- `bun test` writes failures to **stderr**, not stdout, and prints `(fail)` without colour but
  `✗` with it. The fail marker is not a pure colour overlay.
- `go test` reports `ok pkg 0.002s` on a cold run and `ok pkg (cached)` on the next, so a
  duration rule that only knows about digits misses it.
- `cargo test` emits the per-test `---- tests::x stdout ----` blocks in **completion order**.
  Five identical reruns produced two different orders, so output ordering genuinely varies.
- `cargo` prints the thread id in parentheses: `thread 'tests::adds' (738104) panicked`.
- PHPUnit prints `Time: 00:00.003, Memory: 14.00 MB`: a clock-shaped duration and a memory figure.
- pytest pads its banners with `=`, `-` and `_` to the terminal width, so the number of rule
  characters changes when a path or a duration beside it changes length.
- pytest abbreviates long values as `'[kantan] rea...ntan-iz587lzh'`, which smuggles the tail of
  a temp directory into a place no path rule can see it.
- Forcing colour on pytest also changes how far it truncates the short-summary line, so colour is
  not a pure overlay there either. `pytest-colour.txt` is the evidence.

## File format

```
kantan-fixture v1 exit=1
--8<-- stdout --8<--
<stdout, verbatim>
--8<-- stderr --8<--
<stderr, verbatim>
```

Each stream is stored byte for byte, including its ANSI escapes. Every capture here ends with a
newline, which is what lets the marker line sit at a line start; the loader in `test/stall.test.ts`
checks that the marker appears exactly once, so a capture that ever contained it would fail loudly
rather than be silently cut.

## Cases

Each runner has the same tiny suite: `add()` and a `readyLine()` that embeds a pid, a port and a
temp directory, so one failure carries plain numbers and the other carries volatile environment.

| Case | What it is |
|---|---|
| `base-run1`, `base-run2` | The same failure, run twice. Differs in elapsed time, pid, port, temp dir, and for `bun` in colour. Must hash **equal**. |
| `base-edited` | The same failure after two comment lines were prepended, so every line number moved. This is what an agent edit between two attempts looks like. Must hash **equal**. |
| `msg` | The same test failing with a different expected value. Must hash **differently**. |
| `other` | A different test failing instead. Must hash **differently**. |
| `one` | One failing test instead of two. Must hash **differently**. |
| `bun-pass` | All tests pass, exit 0. |
| `go-pass-run1`, `go-pass-run2` | A passing run, then the same run served from the test cache. Must hash **equal**. |
| `pytest-colour` | `PY_COLORS=1`. Documented to hash differently from `pytest-base-run1`. |

## Runners and versions

| Prefix | Runner | Version |
|---|---|---|
| `bun-` | `bun test` | Bun 1.4.3 |
| `pytest-` | `python -m pytest` | pytest 9.1.1, pluggy 1.6.0, CPython 3.14.2 |
| `go-` | `go test ./...` | go1.25.5 linux/amd64 |
| `cargo-` | `cargo test --offline -q` | cargo 1.92.0 (344c4567c 2025-10-21) |
| `phpunit-` | `vendor/bin/phpunit` | PHPUnit 12.5.38, PHP 8.4.25 |

All captured on linux x86_64.

## Recapturing

Build a three-test suite per runner in a scratch directory outside this repo, with one plain
numeric assertion and one assertion over a string holding `pid=`, `127.0.0.1:<port>` and a
`mkdtemp` path. Then, for each case, run the suite with a **fresh `TMPDIR`** and capture stdout,
stderr and the exit code separately.

Three things went wrong the first time and will go wrong again:

1. Capture every case from the **same directory**. Varying the checkout path as well as the case
   mixes two dimensions, and a `-edited` fixture then proves nothing about line numbers.
2. Clear pytest's `__pycache__` and `.pytest_cache` between captures. Its assertion-rewriting
   cache served a stale module and produced a capture with `>   ???` for the failing source line
   and line numbers from a different revision of the file.
3. Capture with `USER=dev LOGNAME=dev` and a neutral `HOME`, then grep the result for your
   username, hostname and email. This repo is open source. The only redaction needed in the end
   was pytest's `hostname=` attribute in the XML; see `../junit/README.md`.
