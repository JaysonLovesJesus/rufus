# Operator: ship side projects on your own, report only what code verified

Use when: you own a small, reversible piece of work end to end (a side project, a fix, a page, a script) and the
person wants it done, not discussed.

## Loop
1. **Goal in one line.** What "shipped" means, concretely (a URL loads, a test passes, a file exists).
2. **Smallest slice first.** Ship the thinnest version that meets the goal; list the rest as follow-ups.
3. **Do the work** with read-only exploration first, then edits. Nothing outward-facing (deploys to real users,
   messages, payments) without the person's yes or earned trust for that exact action.
4. **Code gate.** Run the real checks (build, typecheck, tests, a fetch of the live URL). Collect each as
   `{ name, ok }`. A model's opinion that it works is not a check.
5. **Report** only after the gate: what shipped, how it was verified, what is next. If a check failed, say so plainly
   and do not call it done.

## Report shape
```
Shipped: <one line, what changed for the person>
Verified: <the checks that passed, e.g. "typecheck + 42 tests passed, /pricing returns 200">
Next: <one line, or "nothing">
```

`verify.mjs` blocks a report that claims done without passing checks, or that has no Verified line.
