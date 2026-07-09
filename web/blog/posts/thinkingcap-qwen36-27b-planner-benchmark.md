---
title: >
  ThinkingCap ties Qwen 3.6 27B after fixing the vLLM config
slug: thinkingcap-qwen36-27b-planner-benchmark
sortOrder: -60
date: 2026-07-09
readTime: 8 min read
description: >
  We reran ThinkingCap-Qwen3.6-27B INT4 AutoRound through WebBrain's frozen browser-agent first-tool benchmark after removing debug vLLM settings. The model tied Qwen 3.6 27B on all-case Sonnet alignment and returned in 2.25s median latency.
excerpt: >
  ThinkingCap's first run looked painfully slow because the serve script was in a debug-shaped profile. With prefix caching, MTP speculative decoding, and CUDA graph capture enabled, it scores 77% Sonnet alignment with 2.25s median latency.
titleTag: >
  ThinkingCap Qwen 3.6 27B WebBrain planner benchmark - WebBrain Blog
ogTitle: >
  ThinkingCap Qwen 3.6 27B in WebBrain's frozen planner benchmark
ogDescription: >
  ThinkingCap matches Qwen 3.6 27B's 77% all-case Sonnet alignment once the local vLLM config is fixed, while trading off parsed calls and ideal-name matches.
twitterTitle: >
  ThinkingCap Qwen 3.6 27B WebBrain benchmark
twitterDescription: >
  ThinkingCap-Qwen3.6-27B via local vLLM: 91 parsed calls, 19 exact first actions, 77% Sonnet alignment, and a 2.25s median latency after the serve-script fix.
keywords:
  - WebBrain
  - ThinkingCap
  - Qwen 3.6
  - Qwen 3.6 27B
  - BottleCap AI
  - vLLM
  - browser agent
  - planner benchmark
  - tool calling
lede: >
  BottleCap AI's **ThinkingCap-Qwen3.6-27B** is pitched as a minimally invasive finetune of Qwen 3.6 27B that keeps the base model's capability while using fewer thinking tokens. Our first local WebBrain run seemed to contradict the speed story: it landed near the top of the planner table, but took 33.7s median latency. That was the wrong lesson. The serve script was running with debug-style CUDA synchronization, no prefix caching, no speculative decoding, and CUDA graph capture disabled. After fixing those serving settings and rerunning the full frozen benchmark, ThinkingCap ties the older Qwen 3.6 27B row on all-case Sonnet alignment and returns in 2.25s median latency.
---

## The claim

[ThinkingCap-Qwen3.6-27B](https://huggingface.co/bottlecapai/ThinkingCap-Qwen3.6-27B) is a BottleCap AI finetune of `Qwen/Qwen3.6-27B`. The model card frames it as a way to preserve Qwen 3.6 27B capability while reducing thinking-token budget.

That claim is adjacent to WebBrain, but not identical. WebBrain's frozen planner benchmark does not ask the model to solve long reasoning problems. It asks one narrower production question: given a browser state, a user instruction, and a 41-tool browser-control schema, what is the first tool call?

One caveat up front: the endpoint we tested was not the official BF16 model or the official FP8 sibling. The local vLLM server advertised an INT4 AutoRound derivative:

```json
{
  "id": "thinkingcap-27b",
  "root": "josefprusa/ThinkingCap-Qwen3.6-27B-int4-AutoRound-v1",
  "max_model_len": 65536
}
```

So read the planner-quality result as a useful ThinkingCap-family signal. Read the latency result as specific to this local INT4 AutoRound serving path and the patched vLLM config below.

## What changed

The first run used a serve script that was fine for debugging crashes, but bad for latency:

| Setting | First run | Rerun |
| --- | --- | --- |
| `CUDA_LAUNCH_BLOCKING` | `1` | disabled |
| `TORCH_USE_CUDA_DSA` | `1` | disabled |
| Prefix caching | off | `--enable-prefix-caching` |
| Speculative decoding | off | `--speculative-config '{"method":"mtp","num_speculative_tokens":1}'` |
| CUDA graph capture | `{"cudagraph_mode":"NONE"}` | `{"cudagraph_capture_sizes":[1,2,4]}` |

We did not switch to the official FP8 model for this rerun. The model stayed on the same INT4 AutoRound derivative, so the comparison isolates the serving profile rather than changing both model artifact and server config at the same time.

There is still a serving caveat: vLLM warned that prefix caching with the Qwen 3.6 Mamba cache alignment path is experimental. Startup also became slower because compile and warmup work moved ahead of inference. The server took several minutes to become ready. Once ready, first-tool latency was much better.

## What we ran

The local vLLM endpoint was:

```text
http://localhost:8000/v1/chat/completions
```

We used the same frozen May 23, 2026 WebBrain baseline used by the recent planner posts: Claude Sonnet 4.6's system prompt and 41-tool schema, system hash `5c4fac1387025050`.

```bash
node test/llm/run-llamacpp.mjs \
  --base http://localhost:8000 \
  --model thinkingcap-27b \
  --tag 2026-07-09-thinkingcap-27b-fast-localhost8000 \
  --concurrency 2 \
  --timeout 180000 \
  --no-save-request \
  --freeze test/llm/freeze/baseline-2026-05-23.json
```

This was a native OpenAI structured-tools run. No chat-template fallback was used, and request payloads were not saved.

Result files:

```text
test/llm/results/2026-07-09-thinkingcap-27b-fast-localhost8000_chrome_thinkingcap-27b_frozen
```

## Headline result

| Metric | ThinkingCap 27B INT4 AutoRound, patched serve |
| --- | ---: |
| Completed cases | 100/100 |
| Transport errors | 0 |
| Parsed tool calls | 91/100 |
| Valid frozen-schema tool names | 91/100 |
| Strict exact first-call match | 19/100 |
| Ideal tool-name match | 35/100 |
| Sonnet match, all cases | 77.0% |
| Sonnet match, when Sonnet tooled | 76.1% |
| Average latency | 2.47s |
| Median latency | 2.25s |
| p95 latency | 3.94s |
| Slowest case | 6.47s |
| Total wall time | 123.8s at concurrency 2, after warm server |

That changes the conclusion a lot.

The first ThinkingCap run scored 76% all-case Sonnet alignment with 33.7s median latency and 51.7s p95. After the serve-script fix, the full 100-case frozen rerun scored 77% all-case Sonnet alignment with 2.25s median latency and 3.94s p95.

The model was not inherently slow in this harness. The debug-shaped local serving profile was slow.

## Against Qwen 3.6 27B

There are two useful Qwen comparisons: the older saved Qwen 3.6 27B row and the newer local NVFP4 row.

| Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen 3.6 27B | 92/100 | 18/100 | 37/100 | 77.0% | 77.2% | 10.2s | 15.0s |
| ThinkingCap 27B INT4, patched | 91/100 | 19/100 | 35/100 | 77.0% | 76.1% | 2.25s | 3.94s |
| Qwen 3.6 27B NVFP4 | 96/100 | 18/100 | 38/100 | 74.0% | 77.2% | 1.76s | 6.49s |

Against the older Qwen 3.6 27B row, ThinkingCap is now a real candidate rather than a curiosity. It ties all-case Sonnet alignment, gains one strict exact first-call match, and is much faster in this local comparison. It still loses one parsed tool call, two ideal-name matches, and one Sonnet-tooled match.

Against the NVFP4 row, the tradeoff is sharper. ThinkingCap gains three all-case Sonnet points and one exact match, and its p95 latency is better. NVFP4 still has more parsed calls, more ideal-name matches, one more Sonnet-tooled match, and a faster median.

So the fair summary is:

| Question | Winner |
| --- | --- |
| Most parsed native tool calls | Qwen 3.6 27B NVFP4 |
| Best ideal tool-name count | Qwen 3.6 27B NVFP4 |
| Best strict exact count | ThinkingCap, by one call |
| Best all-case Sonnet alignment | Qwen 3.6 27B and ThinkingCap tie |
| Best no-tool boundary match | ThinkingCap |
| Best median latency | Qwen 3.6 27B NVFP4 |
| Best p95 latency among these three | ThinkingCap |

That is not a clean sweep. It is a serious local result.

## The boundary behavior

Sonnet returned no tool on eight frozen cases. These are important because they test whether a browser agent knows when not to touch the browser yet: under-specified instructions, short knowledge answers, and cases where the right first move is not an action.

ThinkingCap matched seven of those eight Sonnet no-tool decisions in the patched full run.

| Model | Sonnet no-tool decisions matched |
| --- | ---: |
| ThinkingCap 27B INT4, patched | 7/8 |
| Qwen 3.6 27B | 6/8 |
| Qwen 3.6 27B NVFP4 | 3/8 |

That is still the core reason ThinkingCap beats NVFP4 on all-case alignment despite losing on tool-required alignment.

The ambiguous band shows the same shape:

| Model | Ambiguous / clarify Sonnet matches |
| --- | ---: |
| ThinkingCap 27B INT4, patched | 3/8 |
| Qwen 3.6 27B | 2/8 |
| Qwen 3.6 27B NVFP4 | 0/8 |

This is the part of ThinkingCap I like. It is less eager to poke the page when the prompt is vague. For an autonomous browser agent, that matters. A planner that can decline to act is easier to wrap safely than one that treats every user sentence as a reason to click something.

There is still a protocol mismatch: ThinkingCap sometimes answered in prose instead of using the explicit `clarify` tool. That can be semantically fine in chat, but WebBrain's planner loop prefers explicit tool calls for terminal decisions. Still, the broad boundary instinct is better than NVFP4's.

## Where it is strong

The patched run's first-call distribution is normal enough:

| Tool or output | First calls |
| --- | ---: |
| `get_accessibility_tree` | 39 |
| `navigate` | 19 |
| no tool call | 9 |
| `execute_js` | 7 |
| `read_page` | 6 |
| `new_tab` | 3 |
| `download_social_media` | 2 |
| `extract_data` | 2 |
| `list_downloads` | 2 |
| `screenshot` | 2 |
| `clarify` | 1 |
| `click_ax` | 1 |
| `download_file` | 1 |
| `get_interactive_elements` | 1 |
| `get_selection` | 1 |
| `press_keys` | 1 |
| `scroll` | 1 |
| `set_field` | 1 |
| `verify_form` | 1 |

The strongest category bands:

| Category | Cases | Sonnet-name matches | Ideal-name matches |
| --- | ---: | ---: | ---: |
| Direct navigation | 10 | 10 | 9 |
| Search queries | 10 | 9 | 6 |
| Forms / interactive | 8 | 7 | 1 |
| Page reading / summarize | 8 | 6 | 5 |
| Email | 6 | 5 | 0 |
| Downloads | 6 | 5 | 3 |
| Tab management | 4 | 4 | 1 |
| UI mutations | 4 | 4 | 0 |
| Browser internals | 5 | 4 | 3 |
| Knowledge questions | 5 | 4 | 0 |
| Translation / accessibility | 3 | 3 | 1 |
| Multi-page / listing | 3 | 3 | 0 |

Direct navigation is perfect, and search improved versus the first run. The exact score is also respectable: 19/100 ties Gemma 4 31B QAT and Qwen 3.7 Plus, and beats both saved Qwen 3.6 27B rows by one.

The other notable win is tail latency. NVFP4 still has the faster median, but this ThinkingCap serve profile had a better p95 than NVFP4 in the saved run: 3.94s versus 6.49s.

## Where it loses points

The weak spots are still tool-required routing and ideal-name accuracy.

| Category | Cases | ThinkingCap Sonnet matches | Qwen 3.6 27B Sonnet matches | Pattern |
| --- | ---: | ---: | ---: | --- |
| GitHub flows | 6 | 2 | 4 | Often inspected or clicked instead of matching Sonnet's navigation/fetch choice. |
| Destructive / refusal-worthy | 6 | 2 | 2 | No improvement over Qwen on the high-stakes band. |
| Shopping | 4 | 3 | 4 | More generic inspection starts. |
| Scrolling / inspection | 4 | 3 | 4 | One mismatch despite a perfect ideal-name slice. |
| Ambiguous / clarify | 8 | 3 | 2 | Better boundary instinct, but still not consistently through the explicit `clarify` tool. |

The GitHub slice is the clearest quality miss. ThinkingCap matched only 2/6 Sonnet tool names there. For WebBrain, GitHub flows matter because they exercise site guidance and adapter-style shortcuts. A model that over-inspects or takes a generic click path can still be useful, but it is less planner-like.

Ideal-name score is the other drag. ThinkingCap's 35/100 is solid, but it trails both Qwen 3.6 27B rows. That means the model often makes a Sonnet-like first move without choosing the planner's preferred tool name.

## Latency after the fix

The speed picture flipped after the config fix:

| Model / run | Average | Median | p95 | Slowest |
| --- | ---: | ---: | ---: | ---: |
| ThinkingCap 27B INT4, first debug-shaped run | 35.46s | 33.67s | 51.71s | 92.53s |
| ThinkingCap 27B INT4, patched serve | 2.47s | 2.25s | 3.94s | 6.47s |
| Qwen 3.6 27B NVFP4 | 2.19s | 1.76s | 6.49s | 8.66s |
| Qwen 3.6 27B | 10.24s | 10.18s | 15.00s | 15.97s |

This is the answer to the "isn't ThinkingCap supposed to be faster?" question: in our first local run, no, because the serve config was dominated by debug and conservative settings. In the patched run, yes, it is much faster than the older Qwen 3.6 27B row and close to the NVFP4 row. It is not faster than NVFP4 on median latency, but it is faster on p95 in this frozen comparison.

## Token-efficiency claim, in this harness

The public ThinkingCap claim is about thinking-token reduction. WebBrain's first-tool harness is a tiny-output workload, so it is not a clean test of that claim. Most successful responses are just one structured tool call.

Still, the vLLM usage counters show a small completion-token reduction:

| Model | Total completion tokens | Average per case |
| --- | ---: | ---: |
| ThinkingCap 27B INT4, patched | 7,348 | 73.5 |
| Qwen 3.6 27B | 7,720 | 77.2 |
| Qwen 3.6 27B NVFP4 | 8,460 | 84.6 |

So yes, this run produced fewer completion tokens than the saved Qwen rows. The reduction is modest in this workload, but at least it points in the same direction as the model-card claim.

## Updated context

Rows are ranked by all-case Sonnet match, then Sonnet-tooled match.

| # | Model | Parsed calls | Exact | Ideal name | Sonnet all | Sonnet tooled | Median |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Gemma 4 31B QAT w4a16 | 95/100 | 19/100 | 37/100 | 77.0% | 78.3% | 0.55s |
| 2 | Qwen 3.6 27B | 92/100 | 18/100 | 37/100 | 77.0% | 77.2% | 10.18s |
| 3 | MiniMax M2.7 | 88/100 | 23/100 | 36/100 | 77.0% | 76.1% | 3.05s |
| 4 | ThinkingCap 27B INT4, patched | 91/100 | 19/100 | 35/100 | 77.0% | 76.1% | 2.25s |
| 5 | Qwen 3.7 Plus | 95/100 | 19/100 | 41/100 | 75.0% | 77.2% | 3.74s |
| 6 | Agents-A1 AWQ INT4 | 88/100 | 15/100 | 33/100 | 75.0% | 75.0% | 1.66s |
| 7 | MiniMax M3 | 85/100 | 17/100 | 32/100 | 75.0% | 73.9% | 3.06s |
| 8 | Qwen 3.6 27B NVFP4 | 96/100 | 18/100 | 38/100 | 74.0% | 77.2% | 1.76s |
| 9 | Tencent Hy3 free | 95/100 | 20/100 | 38/100 | 73.0% | 75.0% | 3.68s |
| 10 | WebBrain Cloud 1.0 | 90/100 | 16/100 | 35/100 | 73.0% | 72.8% | 8.77s |
| 11 | Ornith-1.0-35B NVFP4 | 88/100 | 21/100 | 36/100 | 71.0% | 70.7% | 2.38s |
| 12 | Qwen 3.6 35B-A3B | 90/100 | 18/100 | 38/100 | 70.0% | 70.7% | 10.29s |

That table is why I would keep ThinkingCap in the serious-candidate bucket. It is tied for the headline top score, has a practical local latency profile after the serve fix, and keeps the boundary behavior that made the first run interesting.

But the ranking hides the tradeoff. ThinkingCap's all-case score is helped by no-tool boundary behavior. On tool-required prompts, it trails Qwen 3.6 27B, Qwen 3.6 27B NVFP4, Gemma 4 31B, and Qwen 3.7 Plus. It is a candidate, not an automatic replacement.

## Bottom line

ThinkingCap-Qwen3.6-27B looks much better after the vLLM config fix.

The corrected read is: ThinkingCap is not slower than Qwen 3.6 27B in this frozen WebBrain setup. It ties the older Qwen 3.6 27B row on all-case Sonnet alignment, beats it on strict exact count, and runs about 4.5x faster on median latency. Compared with Qwen 3.6 27B NVFP4, it is better on all-case Sonnet alignment and p95 latency, but worse on median latency, parsed tool calls, and ideal-name matches.

My read: this is now a real planner candidate. I would not make it the default from this frozen run alone, because the tool-required and ideal-name metrics still favor the Qwen baselines. But the "too slow" objection is gone. The next useful work is a live-schema run and a focused look at GitHub, refusal-worthy, and clarify behavior.

Tags: #ThinkingCap #BottleCapAI #Qwen36 #Qwen36_27B #vLLM #ToolCalling #BrowserAgent #WebBrain
