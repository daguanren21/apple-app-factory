---
"apphx": minor
---

Add a built-in `ui-designer` build role: with no design reference it produces `docs/ui-design.md` from a bundled design guide, and with a `designRef` URL it reproduces the referenced design faithfully; the `developer` role then implements against the design spec and `docs/architecture.md`, and review checks the implementation against `docs/ui-design.md`.
