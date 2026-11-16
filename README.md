[![free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/odashinno/makefunfree/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard)
[![reward](https://make.fun/badge/free-model-aggregator-02/odashinno/makefunfree/reward.svg)](https://make.fun/bounty/free-model-aggregator-02)

# free-model-aggregator-02 — single-model aggregator server

One long-running server that serves both client wires behind a single
free model, dialled live through the trial gateway:

- `POST /v1/chat/completions` — OpenAI wire, JSON and streaming
- `POST /v1/messages` — Anthropic wire, JSON and streaming
- `GET /v1/models` — exactly the brief's fourteen free models, in the
  wire the auth header names

## How it works

Each run reads the trial brief from `$MAKEFUN_PROMPT_FILE` (the fourteen
free models with the house's ratings, plus the six prompts' manifest).
It takes the union of all six prompts' requirements (JSON mode, tools,
vision, context) and picks the ONE free model with the highest house
rating that meets all of them. That one model answers all six prompts.
There is no fallback or failover to a second model, ever.

Every prompt is answered by a real completion from that model, dialled
on the trial gateway's Chat Completions route
(`$OPENAI_BASE_URL/chat/completions`). The `model` field on every answer
and every streamed chunk is the id actually dialled. The trial key comes
from the environment only; it is never hard-coded and never written to
disk.

On a 429 or 5xx refusal the server retries the same model with the same
request (up to 3 attempts total) and reports the trail in the
`x-makefun-upstream-failures` header. A prompt it finally gives up on is
answered by not answering at all, so the env records no refusal for it.

## Run

```sh
node main.ts
```

Environment:

```sh
MAKEFUN_PROMPT_FILE=/path/to/prompt.txt   # the trial brief
MAKEFUN_ENV_URL=http://127.0.0.1:8080     # the trial env
OPENAI_BASE_URL=http://127.0.0.1:8765/v1  # the trial gateway
OPENAI_API_KEY=<trial key>                # set by the trial
```

Print the catalog and exit without starting the server:

```sh
node main.ts --list
```

Requires Node 22 or later. Zero dependencies.

## Files

- `main.ts` — the whole server (brief parsing, model choice, both
  wires, gateway dialling, env register/poll)
- `LICENSE` — MIT
- `package.json` — `"type": "module"` so Node runs `main.ts` directly

## Rules honoured

- One model per run, chosen by the brief's own ratings. No second
  model, no pre-computed or hard-coded answers, no caching of failures
  or blank replies.
- No gateway request outside a run. The only outside service the server
  reaches is the trial gateway.
- Deterministic responses: fixed timestamps, ids taken from the
  upstream answer, so a replay of the same gateway answers is
  byte-identical.
