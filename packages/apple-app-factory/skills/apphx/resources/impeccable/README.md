# Impeccable for apphx — offline design references

This is apphx's embedded **design/reference distribution**, adapted from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) at commit `f5c80432f883a0ee437735305eafc2a9e1bdb7a0`. It is usable offline after apphx skill installation. It is **not** the upstream Impeccable engine, detector, CLI, browser overlay, image service or hook runtime, and it does not register a second skill or command.

**Read this entry before any reference.** This apphx integration contract replaces upstream setup, command routing and execution mandates. The reference filenames are reading routes, not installed `$impeccable` commands. The normal apphx workflow, frozen task scope, permissions and independent review remain authoritative.

## Authority and permission boundary

1. Follow explicit requirements and the actual Figma/design reference, repository instructions, accepted project design intent, executable tokens/components and verified adjacent screens. Generic Impeccable aesthetics never override them, including statements called an upstream “ban.” Native accessibility, readable content and reachable controls remain requirements; report a conflict rather than silently changing the brief.
2. No Figma does **not** mean no design system. Inspect the existing implementation, assets and established design document first. Extend a coherent system; do not restart its visual identity because `DESIGN.md` is missing. Only genuinely greenfield work without visual authority chooses a new direction.
3. Use the project's existing documentation convention. Upstream `PRODUCT.md`, `DESIGN.md`, surface briefs and `.impeccable/*` are upstream conventions, **not required apphx outputs**. Do not create parallel product/design documents or sidecars. Use `docs/ui-design.md` only when the current apphx workflow already requires that artifact and no established equivalent owns it; reference executable token/component sources instead of copying a second catalog.
4. Existing assets, system typography and the current stack are valid choices. No image-generation API, paid imagery, downloaded font, new library, global install, fixed model tier or fixed role team is required. When a required source/asset cannot be accessed, report the missing prerequisite; do not invent its provenance or claim fidelity to it. Do not prebuild/eject a native project or switch frameworks for design tooling.
5. Reading an upstream command example grants **no execution permission**. Do not invoke its launcher even as an availability probe, download its engine, enable hooks, inject overlays, change CSP, run telemetry, register agents, alter host settings or buy/generate assets because a reference says to. These are optional external capabilities requiring separate owner authorization and an actually available implementation. This bundle provides neither. Never claim an engine/detector, asset service or hook ran when it did not.

## The supported apphx workflow

Start with [the UI guide](../ui-design-guide.md) and [platform adaptation and evidence](../platform-ui.md). Resolve the target surface, primary user job, stack, device classes, allowed orientations, current visual authority and required states before styling. Ask only about material decisions that repository/context/tools cannot answer.

Select a surface mode, not a whole-product label:

- **Operate:** a task is completed; hierarchy, familiar native controls, precision and continuity take priority. Default for application screens.
- **Read:** something is understood; readable measure, type scaling and wayfinding take priority.
- **Persuade:** a real decision is supported; truthful content, identity and a clear action take priority.
- **Experience:** the work itself is explored; expression may lead without blocking access or navigation.

Then use the smallest matching route below. Read only the relevant sections; **runtime-only procedures in any reference are archival, not steps in this workflow**.

| Need | Shipped reading route | apphx application |
|---|---|---|
| New screen or requested redesign; `craft` request | [new-work](reference/new-work.md), [craft](reference/craft.md), [craft floor](reference/craft-floor.md) | Use visual-authority discovery, meaningful hierarchy and committed direction. `craft` is upstream's deprecated label, not a required invocation. Skip engine concept-seeding, dice/catalog assignments, comp-led state machines and decision servers; none ship here. |
| Product/app UI | [Operate mode](reference/mode-operate.md), [Operate depth](reference/operate.md) | Preserve the product's vocabulary, shared components and familiar interactions; precise does not mean generic. |
| Reading or expressive surfaces | [Read mode](reference/mode-read.md), [Persuade/Experience mode](reference/mode-persuade.md) | Apply only when that surface's job calls for it; do not turn settings into a marketing page. |
| UX/flow decisions | [shape](reference/shape.md) | Resolve entry, primary action, outcome, error and recovery within the existing architecture. |
| Native mobile adaptation | [adapt.native](reference/adapt.native.md), [iOS](reference/ios.md), [Android](reference/android.md), [platform guide](../platform-ui.md) | Follow the actual target platform, including cross-platform native renderers; web breakpoints alone are insufficient. |
| Web/WebView or desktop composition | [adapt](reference/adapt.md), [layout](reference/layout.md), [platform guide](../platform-ui.md) | Apply CSS advice only to actual web content. MyGo still requires the real macOS window, chrome and input paths. |
| Purposeful motion | [animate](reference/animate.md), [platform guide](../platform-ui.md#motion-contract) | Define purpose, interruption, focus and reduced-motion behavior; use existing/native tools, then observe running motion. |
| Design critique | [critique](reference/critique.md) | Use its design-review dimensions, heuristics, cognitive-load and severity guidance. Do not invoke detector/overlay/storage or require the upstream Assessment A/B role team. Distinguish source findings from observed runtime findings. |
| Technical UI audit | [audit.native](reference/audit.native.md) for native; [audit](reference/audit.md) for web content | Use applicable accessibility, state and layout checks. A source-only native audit is not visual verification; add actual platform captures. |
| Finish without redesign | [polish](reference/polish.md) | Repair relevant observed issues, preserve settled intent and re-observe the affected path. No mandatory detector or critique-storage commands. |
| Content resilience/performance | [harden](reference/harden.md), [optimize](reference/optimize.md) | Cover real long/empty/error/loading/permission states; optimize an observed bottleneck, never invent performance results. |
| Focused visual/copy changes | [typeset](reference/typeset.md), [colorize](reference/colorize.md), [clarify](reference/clarify.md), [distill](reference/distill.md) | Stay within scope and preserve truthful content and accessible semantics. |
| Explicit intensity/experience changes | [bolder](reference/bolder.md), [quieter](reference/quieter.md), [delight](reference/delight.md), [overdrive](reference/overdrive.md), [onboard](reference/onboard.md) | Only for the requested change; not automatic extras or permission to install effects libraries. |
| Shared system work already authorized | [extract](reference/extract.md), [document](reference/document.md), [init](reference/init.md) | Use discovery/token ownership ideas, not the upstream filenames, interview ceremony, sidecars or remote format dependency. Update the established owner only. |

### Bounded critique and polish

After one coherent implementation, examine the actual primary flow, relevant failure states and small/wide surfaces. Record a short prioritized critique: target/state, observed defect, user consequence, smallest owning fix and evidence path. Fix one coherent batch, then capture/review the changed states again. A second batch is justified only by remaining concrete acceptance failures, not score chasing or another aesthetic direction. After two repair batches, return unresolved material findings to the integration owner for a scope/contract decision; never turn the limit into approval of a failing surface. Follow any stricter task-specific repair budget.

The host decides how work is delegated. This bundle requires no named designer/asset/documenter team. apphx's independent final reviewer requirement is unchanged: the implementer's self-critique is not independent approval. Capture and hash runtime artifacts before the verification snapshot; final reviewers inspect frozen evidence without rewriting it. Screenshots alone cannot establish motion, interaction correctness or a measured frame rate.

## Archive-only external capability references

The following text is retained so upstream design links and attribution remain complete. **Do not route an apphx task into these executable workflows.** Their commands, engines, helper services and registrations are not bundled, and their setup requirements are not prerequisites for apphx design work:

- [hooks](reference/hooks.md), [doctor](reference/doctor.md): upstream hook/configuration and drift-repair operations.
- [live](reference/live.md), [live setup](reference/live-setup.md), [generate](reference/generate.md): upstream browser overlay, live helper and variant plumbing.
- [visualize](reference/visualize.md), [region map](reference/region-map.md), [component review](reference/component-review.md): upstream image/comp production, measured-spec engine and review servers. An actual supplied Figma/reference remains authoritative without them.
- [routing](reference/routing.md): upstream menu, not apphx command registration. Use this README's table instead.
- [asset producer](reference/degraded/asset-producer.md), [documenter](reference/degraded/documenter.md), [finish reviewer](reference/degraded/finish-reviewer.md), [manual edit applier](reference/degraded/manual-edit-applier.md): resolved upstream role texts included as dependencies, **not** agents installed by apphx. Their assertions about a host's capabilities or required team do not describe the current host.

References to upstream `SKILL.md`/“Setup” mean the upstream integration, which is deliberately not installed here; this README supplies the apphx setup, mode and routing contract. Inline paths such as `.agents/skills/impeccable/scripts/*`, `.impeccable/*`, `PRODUCT.md`, `DESIGN.md` and generated review assets are upstream examples or project outputs, not missing bundle files. External URLs are optional source citations or external-capability documentation, never mandatory offline dependencies.

## Attribution, provenance and inventory

- [LICENSE](LICENSE): exact pinned Apache-2.0 license, including **Copyright 2025 Paul Bakaus**.
- [NOTICE.md](NOTICE.md): exact pinned upstream third-party notice. The iOS/Android references are derived from **ehmo's platform-design-skills**, originally MIT-licensed; the upstream notice names source paths under `skill/reference/`, while this bundle uses upstream's resolved equivalents.
- [licenses/platform-design-skills-MIT.txt](licenses/platform-design-skills-MIT.txt): exact MIT license text from `ehmo/platform-design-skills` at license revision `baff03e456864470db3ba8acebc41a003cbfa541`, including its original copyright line. That revision identifies the license text, not a claim about which source revision Impeccable originally distilled.
- [SOURCE.json](SOURCE.json): authoritative file inventory with repository, pinned ref, original path, Git blob where available, original SHA-256/byte count and distributed SHA-256/byte count. `sha256` covers exact upstream bytes; `bundledSha256` includes the adaptation banner.

There is one reference tree: **45 Markdown references**, including four resolved `reference/degraded/` role-text dependencies, taken from upstream `.agents/skills/impeccable/reference/`. Each has a prominent apphx adaptation notice prepended; the original reference text after that banner is unchanged. The two upstream attribution files and derived MIT license are unmodified: **48 provenance-tracked text files** in total. This README and the sibling UI/platform guides are apphx-authored integration guidance, not represented as verbatim upstream files.

No upstream scripts, engine binaries, font index, browser bundle, plugin hooks, per-host duplicate tree or installer ships here. The reference import does not execute upstream code. Updates must preserve license/NOTICE, pin the source revision, record every text adaptation and regenerate original/distributed hashes; do not silently track an upstream branch.
