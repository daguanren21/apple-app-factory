---
"apphx": major
---

Remove automatic Apple policy audits, App Store Connect upload/submission/monitor, the authorize/feedback commands and publication permissions (allowSubmit/allowRelease). apphx now produces and verifies local iOS/Android/macOS packages only; store submission, account setup and platform review are manual human work outside the tool.

The internal gate becomes real verification proofs plus a fresh independent review with an honest differentiation and quality checklist: research returns {viable, distinctness, risks, plan} and review returns {approved, findings, acceptanceEvidence}; the Apple appStoreAudit and policySources wire fields are removed. Apple metadata remains optional owner documentation. Keep the honest-differentiation and identity safeguards — never forge identity/IP, mutate hashes, hide sensitive features or script replies, and never promise Apple approval.
