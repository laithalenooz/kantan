# Captured JUnit XML

Real `--junitxml` / `--log-junit` output, for the first branch of `src/stall.ts`. Two dialects,
because one would have hidden the differences:

| File | Produced by |
|---|---|
| `pytest-base-run1.xml`, `pytest-base-reordered.xml`, `pytest-other.xml`, `pytest-pass.xml` | `python -m pytest --junitxml=junit.xml`, pytest 9.1.1 on CPython 3.14.2 |
| `phpunit-base-run1.xml`, `phpunit-base-reordered.xml`, `phpunit-other.xml` | `vendor/bin/phpunit --log-junit junit.xml`, PHPUnit 12.5.38 on PHP 8.4.25 |

What the two dialects disagree about, all of it load-bearing:

- **pytest** writes a flat `testsuites > testsuite > testcase`, and its `name` is the bare function
  name (`test_adds_two_numbers`) with the module in `classname`. Two modules with a test of the
  same name collide unless the class is part of the identity.
- **PHPUnit** nests `testsuite` **three deep** (config file, suite, class) and puts the failing
  cases at the innermost level, so a reader that only looks one level down finds nothing. It also
  writes both `class` and `classname`.
- pytest records `hostname` and `timestamp`; PHPUnit records neither.

`*-reordered.xml` is a real run of the same suite with the test functions defined in the opposite
order, so the `<testcase>` elements are emitted reversed. It is the order-independence fixture.

`*-other.xml` is a real run where a different test failed.

`pytest-pass.xml` is a real run where nothing failed: well-formed, three `<testcase>` elements, no
`<failure>`.

## The two derived files

- `phpunit-truncated.xml` is `phpunit-base-run1.xml` cut at 980 bytes, which is what a runner
  killed mid-write leaves behind. The cut lands inside a `<testcase>` attribute list, **after** a
  complete failing `<testcase>`, so a reader that scans for failures without insisting on
  well-formedness returns a confident partial answer instead of falling back.
- `empty.xml` is zero bytes: the file the project declared, created but never written.

## Redaction

pytest writes the capturing machine's name into `hostname=`. Those four files have it replaced
with `hostname="redacted-host"`; nothing else is edited. `src/stall.ts` reads only the failing
cases' class and name, so the substitution cannot affect any test.
