# performance-marketing-eval

A benchmark by **GoMarble**.

15 tasks testing whether AI agents can analyze marketing performance and safely manage accounts across Meta, Google, TikTok, and Shopify.

Tasks run locally against fixed data and simulated accounts.

## What it measures

Accurate numbers, complete data retrieval, useful explanations, safe changes, and recovery from failures.

| Case | What it tests |
| --- | --- |
| 001 | Purchases and cost per purchase |
| 002 | Duplicate search queries and wasted spend |
| 003 | Campaign creation without increasing total budget |
| 004 | Bid-change timing and names matching live settings |
| 005 | Creative cleanup and reversing failed budget increases |
| 006 | Retrying without creating duplicate ads |
| 007 | Restoring bid strategy while preserving the CPC cap |
| 008 | Counting new ads and identifying their creators |
| 009 | Verifying a merged ad set before retiring originals |
| 010 | Budget pacing after corrected finance figures |
| 011 | CTR improvement versus changes in traffic mix |
| 012 | Funnel losses by device and landing page |
| 013 | Daily budgets without double-counting shared budgets |
| 014 | Conversion traceability to keywords and searches |
| 015 | Reconciling complete and partial financial reports |

Full prompts, IDs, and rubrics: [cases.jsonl](data/cases.jsonl).

## Directory structure

```text
data/     Tasks, datasets, tools, and scoring rules
src/      Runners, simulated tools, and grader
results/  Baseline scores and full traces
runs/     Your local runs and grades (gitignored)
```

## Run locally

1. Install Bun 1.2+, Node.js 20+, and Claude Code or Codex.
2. Configure your CLI login or API key.
3. From this repo, run either example:

```bash
bun run eval:claude --model claude-sonnet-5 --effort high --out runs/claude
bun run eval:codex --model gpt-5.6-terra --effort high --out runs/codex
```

Use the full model ID supported by your CLI account. Add `--tier sanity` for two quick cases or `--case <case-id>` for one. Use a new output folder for each run.

## Grade a run

Choose the judge separately from the agent. Grading requires an API key, including when the agent uses a subscription login. Set `--run` to your output folder:

```bash
export ANTHROPIC_API_KEY="your-key"
bun run eval:grade --run runs/claude --judge-provider anthropic --judge-model claude-sonnet-5

export OPENAI_API_KEY="your-key"
bun run eval:grade --run runs/codex --judge-provider openai --judge-model <judge-model>
```

OpenAI-compatible Chat Completions APIs with tool calling also work: add `--judge-base-url <url>` to the OpenAI command.

Open `summary.json` in the run folder:

- **Score / 100:** average weighted case score.
- **Strict passes:** cases scoring at least 70 and passing all mandatory and safety checks.

Code checks facts and account state; an AI judge assesses explanations. Fresh grading can vary, so use the same judge for comparisons. Incomplete results and errors are flagged.

Use `--resume` to retry unfinished grading, `--rescore` to recompute from saved evidence without API calls, or `--help` for options.

## Baselines

September 10–11, 2026 (UTC): all 15 cases completed at high effort. Judge: `claude-sonnet-5`; grader: `grader-v11`.

| Harness / model | Score / 100 | Strict passes | Full traces |
| --- | ---: | ---: | --- |
| Claude Code / `claude-sonnet-5` | 75.42 | 4/15 | [Download](results/claude-sonnet-5.tar.gz) |
| Codex / `gpt-5.6-terra` | 77.36 | 3/15 | [Download](results/codex-gpt-5.6-terra.tar.gz) |
| Claude Code / `claude-opus-5` | 87.13 | 6/15 | [Download](results/claude-opus-5.tar.gz) |
| Codex / `gpt-5.6-sol` | 93.23 | 7/15 | [Download](results/codex-gpt-5.6-sol.tar.gz) |

Bundles contain answers, tool calls, final states, grades, and judge traces.

Licensed under the [MIT License](LICENSE).
