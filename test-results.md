# free-model-aggregator-02 — test results

Server: `main.ts` (zero-dependency Node ≥ 22, native TS type stripping).
Chosen model (all practice trials): `openrouter/nvidia/nemotron-3.5-super-vl:free`
(rating 1303, the highest-rated free model that is tools + vision + JSON capable).

All times 2026-11-16. Costs $0 throughout (free models only).

## 1. Mock trials (no real network, no real key)

Harness: `/tmp/makefun-local-test/mock-test.mjs` — mock env (POST /register,
GET /work) + mock gateway that answers from the prompt's own token.

| trial | result |
|---|---|
| trial-0 | ALL CHECKS PASSED (~40 checks) |
| trial-1 | ALL CHECKS PASSED |
| trial-2 | ALL CHECKS PASSED |

Checks per trial: register protocol + 14-model catalog + public base_url;
GET /v1/models under both auth shapes (exactly 14 ids, same set);
6 prompts: exact token, model field on every answer/chunk, usage,
stop reasons, stream event order + `[DONE]`; POST /v1/embeddings and
POST /v1/responses return 404 (never answered); exactly 6 gateway calls,
all to the chosen model; server exits 0 when the env reports done.

Give-up path (mock, `FAIL_TOKEN=FALCON-6712`, trial-0): server retried the
SAME model 3 times on 429, then destroyed the socket — client saw
"fetch failed", no HTTP status; the other 5 prompts served normally;
8 gateway calls total (5 + 3). ALL CHECKS PASSED.

## 2. Live trials (real OpenRouter, via a faithful trial-gateway shim)

The kit's own forwarder+relay cannot reach OpenRouter from this VM
(see §3), so live proof used `/tmp/makefun-local-test/shim-gateway.mjs`:
same contract as the kit gateway (14-model allowlist, dummy trial key
accepted, real key substituted, `openrouter/` prefix stripped for the
provider, statuses/bodies passed through verbatim), driven by
`live_trial.py` + the same mock env and checks. Real prompts, real model,
real tokens.

| trial | result | wall time |
|---|---|---|
| trial-0 | ALL CHECKS PASSED | 5.4 s |
| trial-1 | ALL CHECKS PASSED | 5.2 s |
| trial-2 | ALL CHECKS PASSED | 14.0 s |

Each trial: 6 gateway calls, all to the chosen model, $0.
One probe call beforehand confirmed the model answers exactly
("PROBE-1234" in 5.2 s).

### Test-harness bug found and fixed (mock-side, not the server)

The mock env first reported `done` after 40 `/work` polls; the server
polls every 100 ms, so on slower runs it exited mid-trial (trial-1
failed twice with this signature: p05 "fetch failed", then p06
ECONNREFUSED). Fixed: the env now reports done only after the driver
signals `POST /driver-done` once all 6 prompts are answered. The real
kit env only reports done after all prompts are collected, so this was
a harness artifact. All three trials pass deterministically after the fix.

### Server fix applied during this round (commit 91892aa)

Three error paths returned a 5xx to the env on an upstream failure
(dial-throw in both wire handlers; the request-handler catch-all).
Per the rules a wire-failover call must answer 200 + chosen model or not
answer at all. All three now destroy the socket instead (same give-up
as the existing non-ok path). Verified: mock trials 0/1/2 + give-up test
all pass after the change; live trial-0 passes after the change.

## 3. grade-local (kit CLI) — VOID, environmental, not a server fault

Two runs (`node cli/makefun.mjs grade-local --kit <kit> --bot <repo>
--driver process --instances 1 --save <dir>`, run 1 with only the dummy
trial keys, run 2 with the OpenRouter key added):

- Run 1: void — relay reported `OPENROUTER_API_KEY is not set`.
- Run 2: void — relay recognised the key, but all 18 forwarded requests
  failed with 502, cassette body: `the relay could not reach OpenRouter
  at https://openrouter.ai: EPROTO`.

Root cause: the CLI bundle lists HTTP_PROXY/HTTPS_PROXY/NO_PROXY/
ALL_PROXY (all cases) as RESERVED_SANDBOX_NAMES, so the relay/forwarder
processes it spawns get no proxy variables and try a direct TLS
connection, which this sandbox's network policy rejects (same
EPROTO / SSL WRONG_VERSION_NUMBER seen with direct urllib earlier).
The server itself behaved correctly in both runs (registered, answered
/v1/models, dialled 6 times, gave up silently on the failures, exited 0).
The sealed scorer therefore never ran locally; the live trials in §2 are
the end-to-end proof. On the grading server the forwarder runs with
normal egress, so this limitation should not apply there.

Run artifacts: `grade-local-runs/` (void trial-0 cassette/state/summary).
No key material is present in the repo (checked: no `sk-or-v1` string,
no 40+ char Bearer token, no key name).

## 4. Rate-limit warning — the $10 purchase matters

During regression testing the account hit OpenRouter's free-tier cap:
`X-RateLimit-Limit: 50`, `X-RateLimit-Remaining: 0`,
`X-RateLimit-Reset: 1794873600000` (= 2026-11-17 00:00 UTC / 08:00 HKT).
All 18 calls in the last live trial-2 run returned 429; the server
retried the same model 3× per prompt and gave up silently, exactly as
designed (this accidentally proved the retry + give-up path against the
real gateway). The cap resets 2026-11-17 08:00 HKT; the submission
deadline is 11:30 HKT the same day, leaving a 3.5-hour window with only
50 requests for the whole day. Buying $10 of credits once (raises the
free-model limit to 1,000/day, lifetime) removes this risk entirely —
RULES.txt requires it before submission.

## 5. What is NOT verified here

- The sealed scorer (`program/scorer/score.mjs`) has not run on a live
  trial: grade-local voids locally (§3), and the manual live trial does
  not produce the scorer's state export. Expected score from the brief
  arithmetic is ~54.7/60 quality (single model super-vl) with served /
  wire / failover / catalog at full marks when nothing fails, but that
  is a projection, not a measured score.
- `--list` output was verified byte-identical to the registered catalog
  (same 14-model JSON) in the mock runs.
- Replay determinism (byte-identical state.json) is by construction
  (fixed timestamps, seed-only randomness) and was not re-run through
  the CLI's replay check, which needs a non-void trial first.
