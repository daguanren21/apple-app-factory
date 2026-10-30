---
"apphx": minor
---

Add `apphx init --autopilot`: owner-preauthorized unattended local builds. The generated factory records `autopilot: true` plus `allowLocalExecution: true`, and every host turn prompt instructs the host to never ask the user — non-trivial decisions go to a decision-maker sub-context, failures go to a developer sub-context that fixes and iterates, and independent review must run in a brand-new sub-context. Honest-degradation and no-fabricated-evidence rules stay enforced; the only permitted stop is a safety red line, reported as a verdict instead of a question.
