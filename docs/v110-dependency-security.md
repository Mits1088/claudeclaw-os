# v1.10 dependency security review

Reviewed 2026-09-09 against main `8f11afa`. Fresh explicit `npm audit` and `npm audit --omit=dev` both reported 11 affected packages: 7 high, 4 moderate, no critical. The initial npm-ci summary reported 20; the explicit JSON audits are the reproducible review baseline, not evidence that installation itself fixed anything.

| Package | Locked before | Locked after | Exposure |
| --- | --- | --- | --- |
| hono | 4.13.0 | 4.13.7 | Dashboard runtime request parsing; also MCP SDK dependency. |
| js-yaml | 4.3.1 | 4.3.2 | Agent/config YAML parsing; empty merge sources could bypass CPU limits. |
| fast-uri | 3.1.5 | 3.1.7 | MCP SDK via AJV; URI canonicalization fixes. Application exploitability is not established merely by dependency presence. |
| qs | 6.15.3 | 6.16.0 | MCP SDK via Express/body-parser; query parsing denial of service fixes. |
| dompurify | 3.4.12 | 3.4.15 | Dashboard markdown and Monaco. Though directly declared as a dev dependency, it ships in browser assets and is also a production transitive dependency. No application IN_PLACE/addHook use found. |

The runtime fixes change these five package versions. Existing same-major ranges/overrides were raised where needed; no major upgrade, provider SDK update or blanket audit fix.

GitHub's open Dependabot inventory additionally identified development lockfile entries absent from npm's explicit audit result: browserslist 4.28.6 and nanoid 3.3.16. Compatible updates select browserslist 4.28.9 and nanoid 3.3.18, with browserslist's associated browser-data dependencies refreshed by npm. These are included in this patch.

## Separate major-upgrade exposure

The GitHub inventory contains 23 open advisories on default main, which counts advisories rather than npm's affected-package totals and includes Python. In particular, do not interpret npm's zero-critical result as a clean repository:

- **Critical development tooling:** Vitest alert #59, GHSA-5xrq-8626-4rwp, lists patched 3.2.6. Current Vitest is 2.x. A newer Vitest/mocker advisory lists 4.1.11. Resolve together in a separate tested tooling migration; no development test/API server should be exposed to untrusted clients.
- **Vite and nested esbuild development servers:** GitHub lists Vite fixes in 6.4.2/6.4.3 and esbuild 0.25.0. Vite is deliberately pinned to 5.x here; these require the separate build-tool migration, not a forced override of its internal bundler.
- **Python War Room runtime:** `warroom/requirements.txt` pins pipecat-ai 0.0.108. Alerts GHSA-3363-2ph6-35wh and GHSA-j8cv-x86q-rj85 list patched 1.2.0 and 1.4.0. This is a substantial API migration and remains open for explicit selection and real voice validation.

Authoritative open alert inventory: [repository Dependabot](https://github.com/earlyaidopters/claudeclaw-os/security/dependabot). These unresolved items remain visible release-risk decisions, not completed fixes.

After the targeted update, both full and production-only audits report **5 high, 0 moderate, 0 critical**. All five are the same inherited chain: `whatsapp-web.js -> puppeteer / puppeteer-core -> @puppeteer/browsers -> extract-zip`. These are not five independent exploit paths.

The remaining archive symlink traversal applies to browser archive extraction. This is primarily an install/download boundary, not proof of a remotely exploitable messenger request. Do not extract untrusted browser archives. The audit's suggested WhatsApp version change is outside this targeted patch; no forced downgrade or major modernization was applied. A compatible upstream removal/fix of extract-zip requires separate review.

Advisory sources: [js-yaml](https://github.com/advisories/GHSA-2883-xcg3-v3hh), [DOMPurify](https://github.com/advisories/GHSA-55q2-fjhq-7xh7), [qs](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), [Hono](https://github.com/advisories/GHSA-g6gw-c38x-mqfc), [fast-uri](https://github.com/advisories/GHSA-f65p-4m7j-42xc), [extract-zip](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3).

Validation uses an isolated worktree: unset NODE_ENV, npm ci, full Vite/TypeScript build, full Vitest suite. Actual runtime validation remains a release gate; these dependencies have not been deployed.
