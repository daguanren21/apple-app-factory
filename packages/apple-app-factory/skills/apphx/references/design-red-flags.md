Adapted from the architect skill's design-red-flags reference (cursor/plugins, MIT license).

# Design red flags

Screen every design draft and the finished architecture against these before implementation. A hit means revise or reject that draft — never ship it and never patch around it.

## 1. Shallow module
An interface hides no meaningful implementation complexity, so it costs more ceremony than it saves.
Signals: a module or class with one thin method that only forwards; an interface with a single implementation; files that exist only to satisfy a layering rule.
Fix: delete the layer or fold the logic into its caller until the module earns its abstraction.

## 2. Information leakage
One module knows another module's internal data formats, ordering or hidden state.
Signals: parsing another module's serialized form outside it; a caller reaches into nested fields to decide behavior; a change in one module forces edits in an unrelated module.
Fix: move the decision into the owning module and expose one intent-revealing operation.

## 3. Temporal decomposition
Code is split by execution order (do this, then this) instead of by who owns the knowledge.
Signals: a "step N" function that exists only because it runs after step N-1; an orchestrator holding all the actual logic; modules named after phases rather than responsibilities.
Fix: regroup code by owner so each module owns a coherent slice; the sequence becomes a thin composition, not the structure.

## 4. Pass-through method
A method with no logic that only forwards its arguments to another layer.
Signals: a body that is one call with the same arguments; a chain of delegates where the last one does all the work; a wrapper added because "it belongs in this layer".
Fix: call the target directly, or collapse the layer; keep a pass-through only when it encodes a real stable boundary (for example an API versioning seam).

## 5. Split ownership
The same state has multiple writers, so no single owner can guarantee its invariants.
Signals: two screens/widgets/modules writing the same field or store; "whoever runs last wins"; UI state that changes from several distant call sites without a single reducer.
Fix: give the state exactly one owner (a reducer, store or controller) and route every write through it.

## 6. Two ways to do one task
One job has two parallel code paths, so they drift and only one gets tested.
Signals: an old API kept alongside a new one doing the same thing; two utilities for the same transformation; feature flags left to rot after the new path wins.
Fix: pick one path, migrate all callers, delete the other; if migration is staged, make the old path a thin shim over the new one with a removal date.

## 7. Importable internals
Implementation details are exported, so external code depends on them and freezes them.
Signals: a barrel re-exports helpers meant only for the module; public classes reveal mutable internals; tests import private-looking symbols that then cannot change.
Fix: shrink the public surface; export only the contract; move tests to behavior-level assertions.

## 8. Hand-synced list
The same list of facts is copied into several places and must be updated by hand.
Signals: duplicated enum or field lists across files; a new item requires edits in N files; a switch and a registry that list the same cases.
Fix: make one source of truth and generate or derive the rest, or collapse the copies into a shared constant or registry.

## 9. UI/state double write (apphx multi-stack)
Multiple widgets or screens each keep their own copy of the same state and sync it ad hoc.
Signals: the same value stored in several widget States or view models; screens re-fetch or copy shared state instead of subscribing to one source; local copies that need manual refresh after a mutation.
Fix: use one owned source — Riverpod/Bloc/Provider in Flutter, ObservableObject/ViewModel in Swift, a state manager/Context in React Native/Expo, Pinia in uni-app — that screens read, never duplicate.
