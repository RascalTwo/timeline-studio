# assistant — evaluating local models on plan requests

> **Superseded as the product (2026-09-27).** The plan page now has a chat (`web/src/agent.ts`,
> `web/src/ui/Assistant.tsx`): a local model (gemma4:12b via Ollama) with tools that wrap the plan's
> own API, running in the page, with chat history, Clear, per-reply Undo, and a human-approved delete.
> Its traces go to a local Phoenix (`web/src/tracing.ts`, project `timeline-studio-chat`), which is now
> the record of how it behaves. Rascal Two used the one-shot command bar below and found it too narrow, and
> the in-page Parakeet voice not worth keeping (Handy covers dictation), so both were removed, as was
> the brain server and its usage log. What stays here is the evaluation work: the dataset, the grader
> and the measurements, which are what any future brain gets judged with.

```bash
node eval.ts hybrid ollama:gemma4:12b --set build     # score a brain on the dataset
node regrade.ts                      # re-score saved runs with the current grader (no brain calls)
python3 assemble.py                  # rebuild the dataset from labelled transcript batches
```

## The shape, and why

- **The brain proposes; the client applies.** It never holds the plan's token or writes to a plan.
  The page applies a proposal through `call("commands")`, the same all-or-nothing batch path as
  every other multi-edit, and computes its own **undo** first (the page itself has none, only
  Revert).
- **Hybrid.** The LLM only *parses* the sentence into a small frame (action, new label, minutes,
  date). Which existing task is meant is resolved by embeddings over task labels, so the LLM never
  sees the task list and cannot invent an id. Under 0.6 confidence it asks ("A / B / C") instead of
  acting; finishing and renaming ask for a Yes even when sure.
- **v1 vocabulary:** add, rename, minutes, due (set or clear), link, start, finish, comment,
  sign-off ("sign off on X" / "refine X" = the user refining it), reorder, and the questions what's
  next / blocked / due. Nothing permanent or managerial.

## The eval, and the bar

The dataset is the user's own requests, mined from 7 days of Claude Code transcripts: what was said,
what was sent, whether it stuck, labelled into gold commands, split build / held-out by a hash of
the words, with items that only make sense mid-conversation removed ("I approve", "flip it to
done"). **It is the user's real plan, so it lives outside this repo** (client data never enters
it): `~/.agents/state/timeline-studio-assistant/` (`$TS_ASSISTANT_STATE`).

`eval.ts` replays each request against the plan **as it stood when it was said** (tasks created
later removed) and grades: right (acted correctly, or asked with the right option among the
choices), wrong_act (acted without asking and got it wrong), wrong_ask, missed. **Ship bar: at
least 90% right and zero confident wrong actions on the held-out set.** The `rules` brain (keywords
+ word overlap, no model) is the falsifier.

Scoring rules, each learned from a false failure:

- A new task's name is judged by meaning: word overlap, or nomic-embed cosine >= 0.65 against the
  gold name or the start of the gold description (8 calibration pairs: same task 0.75-0.88,
  different 0.39-0.45). Claude's gold names often reframe what was said.
- Minutes count only when the sentence states a length of work. Claude guessed durations, and a
  stray digit ("89 tasks", "ticket 13") had been enough to demand one.
- A due date or start aimed at a task added in the same request is folded into that task on both
  sides, since gold and brain name new tasks differently.

**The original ship bar was retired** (Rascal Two, 2026-09-27): "near-perfect agreement with Claude Code" is
out of reach even for Opus 5.5 (30/35), because much of the gold is Claude's own inference from
conversation. The chat is judged by use; its Phoenix traces are where a bad decision gets diagnosed.

## Results (2026-09-26)

Hybrid, embeddings resolver, on the requests that stand on their own (59 of 86). **The held-out set
was scored once, after all tuning on the build set.**

| brain | build (35) | held-out (24) | confident wrong (held-out) | median |
|---|---|---|---|---|
| rules (no model) | 16 | 7 | 10 | 0 ms |
| **hybrid, gemma4:e4b** (the default) | 19 | **15** | 6 | **1.1 s** |
| hybrid, gemma4:12b | 21 | 16 | 5 | 5 s |
| LLM-only, gemma4:12b (sees the task list) | 17 | — | 18 on build | 17 s |
| hybrid, Bonsai 2 27B / qwen2.5-coder:14b | — | — | — | ~17 s, dropped on speed |

**Neither clears the ship bar (22/24, zero confident wrong).** The models generalise (roughly double
the rules on unseen requests) but most misses are long, rambling "add a task" requests where the
brain names or splits the work differently from how Claude did, and those are confident wrongs
because adds never ask. `eval/runs/` (outside the repo) holds per-item output.
