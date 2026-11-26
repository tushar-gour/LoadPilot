# Changelog

## 0.2.0 — release candidate

- Add public CustomAlgorithm, CustomAlgorithmCandidate and CustomAlgorithmFactory types and ServerPool.customAlgorithm factory option.
- Supply frozen eligible-backend snapshots with registration IDs, effective-weight inputs, active exchanges and response-header EWMA; validate selection and isolate per-pool strategy instances.
- Preserve all six built-in algorithm enum values and default Round Robin behavior.
- Split six built-in strategies, scheduler, request router, proxy exchange, health probe and metric groups into focused modules.
- Isolate health transitions and metric snapshot composition.
- Expand automated regression and built-package consumer checks.
- Keep zero runtime dependencies, Node >=22.19.0 and ISC licensing.

Historical performance claims do not automatically apply to this release. Custom strategies are synchronous trusted code, not sandboxed.
