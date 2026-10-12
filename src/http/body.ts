/**
 * Reading and judging a request body, for the routes that take one.
 *
 * Moved from `src/server.ts` unchanged. Every acting route begins with the
 * same three steps - read it, check its keys, pull the fields - and the
 * refusals they produce are the ones a caller reads most often, so they are
 * worth finding in one place.
 *
 * The rule that matters here and is easy to lose: an unknown key is refused
 * **by the names this route takes**, never by echoing what was sent. See
 * `badBody`.
 */

import { refuse } from "./guards"

/**
 * The most a request body may be, in bytes.
 *
 * The only fields that can be large are the words a human types - feedback at
 * the gate, or an answer to a question the agent asked - and 64 KiB is roughly
 * ten thousand words: an order of magnitude past what
 * anyone types into a textarea, with room left for a pasted diff or stack
 * trace, which is a legitimate thing to paste at a gate. Both directions were
 * weighed: a tighter cap refuses that paste, and no cap at all lets one request
 * decide how much memory the server spends, because the body is buffered before
 * a single field of it can be validated.
 */
export const MAX_BODY_BYTES = 64 * 1024

export type BodyText = { text: string } | { refused: Response }

/**
 * The body as text, refused if it is too large or not UTF-8.
 *
 * Read through the stream with a running total rather than through
 * `req.text()`, which buffers whatever arrives before anyone can object.
 * Probed: a chunked request declares **no** `Content-Length` at all, so a guard
 * that only read the header would be skipped by exactly the client that needed
 * capping. The header is still checked first, because refusing a declared 10 MB
 * without reading it is cheaper than reading 64 KiB of it.
 */
export async function readBody(req: Request): Promise<BodyText> {
  const declared = Number(req.headers.get("content-length"))
  // `null` becomes 0 and a malformed value becomes NaN; neither is over the
  // cap, and the running total below is what catches them.
  if (declared > MAX_BODY_BYTES) return { refused: tooLarge() }

  const body = req.body
  if (body === null) return { text: "" }

  const chunks: Uint8Array[] = []
  let total = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BODY_BYTES) return { refused: tooLarge() }
      chunks.push(value)
    }
  } finally {
    // Returning early leaves the rest of the upload unread, and an unread
    // request body is a socket nothing drains.
    await reader.cancel().catch(() => {})
  }

  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  try {
    // `fatal`, so invalid UTF-8 is refused rather than silently becoming
    // U+FFFD. The large field here is the human's own words, and replacing a
    // byte of them is the expensive direction; a browser never sends anything
    // but UTF-8, so the refusal costs nothing. Decoded once over the joined
    // bytes, so a character split across two chunks survives.
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
  } catch {
    return { refused: refuse(400, "refused: the body must be UTF-8") }
  }
}

function tooLarge(): Response {
  return refuse(413, `refused: a request body may be at most ${MAX_BODY_BYTES} bytes`)
}

/**
 * The body's fields, or the response that refuses it.
 *
 * Accepting input, so CLAUDE.md's rule applies and the dimension - the bytes of
 * the body - is enumerated rather than sampled. Over-accepting hands malformed
 * state to a run that spends money; over-rejecting means the UI cannot drive
 * the tool. The enumeration, and what each value answers:
 *
 * - **Absent, or empty.** Indistinguishable on the wire (probed: Bun declares
 *   `Content-Length: 0` for both), so they read the same: no fields. A route
 *   with required keys then refuses for a missing key, and one with none
 *   proceeds, which is the normal case for approve and stop.
 * - **Not JSON.** 400. There is no second format to try.
 * - **`null`.** 400. `typeof null === "object"`, which is the trap this check
 *   exists for.
 * - **An array**, even one holding the right record. 400, for the other half of
 *   the same trap.
 * - **A scalar.** 400: a number, a string or a boolean carries no fields.
 * - **An unknown key.** 400, for the reason `src/projects.ts` refuses one: a
 *   near-miss spelling is a setting the caller typed and would otherwise be
 *   dropped in silence. The message names **the keys the route takes** and
 *   never the key that was sent - that is caller-chosen text, and `refuse`
 *   does not echo it.
 * - **A duplicated key.** Accepted; `JSON.parse` keeps the last. One parser
 *   reads this body and nothing downstream reads it again, so there is no
 *   second opinion for a smuggled value to hide behind, and the key set the
 *   allowlist sees is unchanged either way.
 * - **A correct object.** Its fields, for the route to read.
 *
 * `Object.keys` and not a `for...in`: own enumerable keys only, which is also
 * what makes a literal `__proto__` key - which `JSON.parse` does create as an
 * own property - an ordinary unknown key rather than something clever.
 */
export type ParsedBody = { fields: Record<string, unknown> } | { refused: Response }

export function parseBody(text: string, allowed: readonly string[]): ParsedBody {
  if (text.trim() === "") return { fields: {} }

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { refused: badBody(allowed, "the body must be JSON") }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { refused: badBody(allowed, "the body must be a JSON object") }
  }
  const fields = value as Record<string, unknown>
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) return { refused: badBody(allowed, "the body has a key this route does not take") }
  }
  return { fields }
}

export function badBody(allowed: readonly string[], what: string): Response {
  const keys = allowed.length === 0 ? "this route takes no keys at all" : `the keys it takes are: ${allowed.join(", ")}`
  return refuse(400, `refused: ${what}; ${keys}`)
}

/**
 * `value` when it is a string with something in it, otherwise `null`.
 *
 * Emptiness is judged on a trimmed copy and the **original** is returned.
 * Nothing trimmed is ever forwarded: the one field this guards that a human
 * writes is gate feedback, and collapsing its whitespace would change what they
 * said to the agent. An all-whitespace value is still empty, because feedback
 * with nothing in it spends a planning turn on silence and a path or a task ref
 * made of spaces names nothing.
 */
export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}
