# Security

## What kantan is, in threat-model terms

kantan hands arbitrary text to an agent that has file-write and shell access in
one of your repositories, and it runs your test command through `sh -c`. Its
HTTP endpoints *start work*. So "it only listens on localhost" is explicitly
**not** the security model, and the README says so:

- **Any page you visit can POST to a localhost port.** The browser sends the
  request willingly; the same-origin policy only stops that page reading the
  response, which is no comfort for an endpoint that starts an agent.
- **DNS rebinding defeats the naive assumption.** An attacker's domain resolves
  to their server, then re-resolves to `127.0.0.1`, and their page is now
  same-origin with yours. The `Host` header is what catches that, which is why
  an absent `Host` is refused rather than read as local.

What actually defends it, all in `src/http/guards.ts`:

- Binds `127.0.0.1`. There is deliberately no `hostname` option: a wide bind
  should take a code edit, not a configuration mistake.
- Exact-match allowlists for `Host` and `Origin`, built from the port actually
  bound. No normalisation anywhere — a suffix match on `localhost` would accept
  `localhost.evil.com`.
- A per-launch token in an `HttpOnly; SameSite=Strict` cookie, compared with
  `timingSafeEqual`. Only `GET /` and `GET /api/session` may answer without it,
  because a browser cannot have the cookie before something hands it one.
- Every state-changing action uses a method browsers send an `Origin` with.
  `SameSite=Strict` ignores **ports**, so a page on any other localhost port is
  same-site: a convenience GET that started a run would be reachable from every
  other local page on your machine.

**Please do not loosen those checks to put a reverse proxy in front of this, and
please do not expose it.** The refusal messages name the guard that refused for
exactly this reason.

## Your run logs contain your source

`~/.kantan/runs/<uuid>.jsonl` is the CLI's raw stream-json, byte for byte,
because replaying it is what makes the UI reconnectable. That means prompts,
tool inputs and file contents. Nothing is ever sent anywhere — kantan talks to
no service — but **read a log before you attach it to a bug report.**

## Reporting something

Open a regular issue for anything already public or low-risk. For a
vulnerability, describe the class of problem rather than a working exploit, and
say what an attacker would gain. If you would rather not post it, use GitHub's
private vulnerability reporting on this repository.

There are no supported releases and no backports: this is one branch, and a fix
lands on it.

## Known and accepted

These are decided, not overlooked, and each is argued at length where it lives:

- **A hard link defeats the file-read containment.** `readInside` resolves
  symlinks and opens with `O_NOFOLLOW`, so a link out of the repository is
  refused — but `ln ~/.ssh/id_rsa docs/features/x.md` is a second directory
  entry for the same inode, not a link to follow, and the contents come back.
  Probed. Accepted because the agent that could make that link can already read
  the file and paste it into the repo, so the gap is about what this server
  *renders*, not about what that agent can reach.
- **`POST /api/test` runs a command from the request body.** It grants nothing
  the caller lacked: anything holding the token can PATCH a project's `testCmd`
  and start a run through the same `sh -c`. A filter on the string would give
  the false impression this is a sandbox.
- **`bypassPermissions` is available and is not the default.** The default is
  derived from what you already declared: the five file tools, `Bash(git *)`,
  and one rule for the program your tests run. A default that handed blanket
  shell access to a stranger's repository would be the wrong default however
  convenient it is for the author.
