## What this changes, and why

<!-- The why matters more than the what; the diff already says the what.
     If it fixes an issue, link it. -->

## How it was verified

<!-- `bun run check` is typecheck *then* tests, in that order, and finishing on
     it is the repo's one hard requirement. Paste the counts.

     If you changed anything with a UI, a screenshot earns its place here: a
     passing suite says the nodes exist, not that they are laid out, visible or
     legible. Three defects in this repo were invisible to DOM tests that
     queried for the right nodes and found them. -->

```
bun run check
```

## If you wrote a rule that skips, filters or normalises an input

<!-- Delete this section if you did not.

     CONTRIBUTING.md and CLAUDE.md both carry the skipping-guard rule, because
     one hundred lines of src/backlog.ts produced fourteen defects and every one
     came from such a rule. Answer the four questions:

     1. Which input dimension does the guard read? The specific thing it
        inspects, not "the input".
     2. Every value that dimension can take, including values no test produces.
     3. What a wrong guess costs in each direction. They are rarely symmetric.
     4. Where the enumeration is tested.

     Its corollary is the part people skip: replaying the existing suite proves
     nothing about a rule that reads something the suite never varied. If that
     is your evidence, say what it cannot see. -->

## Anything a reviewer would otherwise have to discover

<!-- A decision you made that the diff does not explain. A thing you tried that
     did not work. Something you are unsure about — saying so is cheaper for
     both of us than having it found in review. -->
