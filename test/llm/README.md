# LLM evaluation harness

100 synthetic user prompts + expected behaviors, plus a command that
emits the exact `messages + tools` payload WebBrain would send to an
LLM for a given case. Use it to measure how different models perform
on the same WebBrain prompt.

## Layout

```
test/llm/
├── questions/NNN.json    # { id, mode, tab:{url,title}, user }
├── expected/NNN.json     # { id, idealFirstToolCall:{name,args}, successRubric }
├── lib/build-payload.mjs # pure builder: imports the real Chrome/Firefox prompts/tools
├── enrich.mjs            # CLI — prints the full LLM request payload
└── _generate.mjs         # rewrites questions/* and expected/* from inline data
```

`questions` and `expected` are matched by id. Edit the .json files
directly; or edit the `CASES` array in `_generate.mjs` and re-run it.

## Enrich a single case

```
node test/llm/enrich.mjs --id 42 --pretty
```

Enrich all cases:

```
node test/llm/enrich.mjs --all --pretty > enriched.json
```

Use Firefox prompt/tools instead of the Chrome default:

```
node test/llm/enrich.mjs --id 42 --browser firefox --pretty
```

Outputs a JSON object:

```json
{
  "messages": [
    { "role": "system", "content": "<SYSTEM_PROMPT_ACT + UNIVERSAL_PREAMBLE>" },
    { "role": "user",   "content": "[Current page context — …]\n[Site guidance for github]\n…\n\n<user message>" }
  ],
  "tools": [ /* 35 OpenAI function schemas */ ]
}
```

Pipe it straight into any OpenAI-compatible endpoint:

```
node test/llm/enrich.mjs --id 42 | \
  curl -s http://localhost:8080/v1/chat/completions \
    -H 'content-type: application/json' \
    -d @- | jq .choices[0].message
```

Ad-hoc (not from a case file):

```
node test/llm/enrich.mjs --user "go to gmail" --url "about:home" --title "New Tab"
```

Flags:

| flag                   | effect                                                |
| ---------------------- | ----------------------------------------------------- |
| `--id <NNN>`           | Load `questions/NNN.json` (1–100)                     |
| `--all`                | Load all `questions/NNN.json` files as a JSON array   |
| `--browser chrome\|firefox` | Browser source to mirror (default: `chrome`)     |
| `--user "..."`         | Ad-hoc message (must pass `--url` too)                |
| `--url "..."`          | Synthetic tab URL                                     |
| `--title "..."`        | Synthetic tab title                                   |
| `--mode act\|ask`      | Mode (default: `act`)                                 |
| `--pretty`             | Indented JSON                                         |
| `--no-tools`           | Omit the `tools` array                                |
| `--no-adapters`        | Skip UNIVERSAL_PREAMBLE + per-site adapter injection  |
| `--strict-secrets`     | Swap in the strict-mode `done` description            |

## Case categories

| ids       | category                                |
| --------- | --------------------------------------- |
| 001–010   | Direct site navigation                  |
| 011–015   | Browser internals (about:* pages)       |
| 016–025   | Search queries                          |
| 026–033   | Page reading / summarize                |
| 034–041   | Forms / interactive elements            |
| 042–047   | GitHub-adapter-driven flows             |
| 048–053   | Email (Gmail)                           |
| 054–059   | Downloads                               |
| 060–063   | Shopping (Amazon)                       |
| 064–067   | Scrolling / inspection                  |
| 068–075   | Ambiguous → clarify                     |
| 076–081   | Destructive / refusal-worthy            |
| 082–086   | Knowledge questions (done with text)    |
| 087–090   | Tab management (mostly tools-don't-exist)|
| 091–094   | UI mutations                            |
| 095–097   | Translation / accessibility             |
| 098–100   | Multi-page / listing                    |

## Expected-response model

Each `expected/NNN.json` carries:

- **`idealFirstToolCall`** — the canonical first action (e.g.
  `{name:"navigate", args:{url:"about:addons"}}`). Useful for cheap
  step-1 routing scoring.
- **`successRubric`** — 1-3 sentences describing what counts as a
  correct full run. Use this with a judge LLM to score actual
  traces, since different models will legitimately take different
  paths to the same outcome.

The rubric is the load-bearing field — `idealFirstToolCall` is a
hint, not a strict match target.

## Running cases against a model (build it yourself)

Run the included OpenAI-compatible runner against a local endpoint:

```
node test/llm/run-llamacpp.mjs --base http://127.0.0.1:1234 --model "qwen/qwen3.6-35b-a3b"
```

For hosted OpenAI-compatible APIs such as OpenRouter, pass an API key
with `--api-key` or `--token`, or set `LLM_API_KEY` /
`OPENROUTER_API_KEY`:

```
node test/llm/run-llamacpp.mjs --base https://openrouter.ai/api/v1 --model "openai/gpt-oss-20b" --api-key "$OPENROUTER_API_KEY"
```

You can also pass the full chat completions URL:

```
node test/llm/run-llamacpp.mjs --url https://openrouter.ai/api/v1/chat/completions --model "openai/gpt-oss-20b"
```

By default, each `results/<run-tag>/NNN.json` includes the exact
OpenAI-compatible `request` body sent to the model. To save disk space,
omit it:

```
node test/llm/run-llamacpp.mjs --no-save-request
```

The runner captures only the first model turn. It does not execute tool
calls or step the agent.

## Regenerating

Edit `_generate.mjs`'s `CASES` array, then:

```
node test/llm/_generate.mjs
```

It wipes `questions/0??.json` and `expected/0??.json` and re-emits
them. Hand-edits to the individual files are *not* preserved — keep
your source of truth in `_generate.mjs`.
