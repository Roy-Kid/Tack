# Tack

Tack is a thin command line over
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The agent
loop, tools, sessions, web shell, and plugins are DeepSeek Harness's, pinned to
one exact version. Tack adds its own home, default model, profiles, browser
brand, and a research workbench composed through DSH's public UI slots.
Pieces of that runtime get replaced with Tack's own only after they have been
used as published.

## Install (from source)

Requires Node 22.12 or newer and git.

```sh
git clone https://github.com/MolCrafts/Tack && cd Tack
npm run setup            # npm ci, build, link `tack` onto your PATH, run `tack doctor`
```

If linking needs permissions you don't have, set a user prefix first
(`npm config set prefix ~/.local`) or run `node packages/tack/lib/bin.js` directly.

## First test

With a DeepSeek key (Tack's default provider):

```sh
printf %s "$DEEPSEEK_API_KEY" | tack auth set DEEPSEEK_API_KEY
tack doctor              # ends with "Ready       yes"
tack run "list the files in this directory"
tack web                 # Tack's browser UI over DSH, on Tack's home
```

Any other provider works the same way, e.g.
`tack provider add anthropic --api-key-env ANTHROPIC_API_KEY` then
`tack model use anthropic/<model>` (see `tack model list`).

Without any key, the end-to-end suites run against a scripted local model:

```sh
npm run test:agent       # tack run: text, tools, stdin, plugins, delegation
npm run test:install     # a clean install from source, then the installed tack
DEEPSEEK_API_KEY=... npm run test:live   # one real turn (skips without a key)
```

## Usage

```sh
tack                     # help
tack run "task"          # answer one task and exit (`-` reads stdin)
tack web                 # serve Tack's DSH-based UI (`--port`, `--no-open` are DSH flags)
tack version             # Tack and runtime versions
tack doctor              # runtime, home, and profile state
tack doctor --dump-config
tack doctor --tools      # tools registered in a profile

tack model                               # default model of each profile
tack model list [--provider <id>]        # providers and their models
tack model use <provider>/<model>        # switch the default (every profile)
tack provider add anthropic --api-key-env ANTHROPIC_API_KEY
tack provider add gw --api openai-completions --base-url https://gw/v1 --model m
printf %s "$KEY" | tack auth set ANTHROPIC_API_KEY
tack run --model openai/gpt-5 "task"     # another model for one run

tack plugin add <package|tarball|path>   # install into the default profile
tack plugin list | enable | disable | remove
tack plugin add <package> --profile supervise  # plugins for delegated execution
```

Tack flags (`--profile`, `--patch`, `--model` for `run`) come first; the first
unrecognised token starts the app's own arguments, which are forwarded
verbatim (`tack run --help`, `tack web --port 0 --no-open`).

## Plugins

A Tack plugin is an npm package that declares a bundle layer and, optionally,
the Tack versions it supports:

```json
{
  "keywords": ["tack-plugin"],
  "tack": { "compat": ">=0.2.0 <1.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`examples/plugin-echo` is a complete one-tool plugin. Tack bundles its own
package manager for plugin installs; nothing else needs to be on `PATH`.

## Subagents (Claude Code and Codex)

Claude Code is DeepSeek Harness's own plugin,
`@deepseek-ai/dsh-subagent-claude-code`, pinned to the same runtime version as
the rest of DSH. Codex is Tack's `@tack/codex`: a provider that speaks the
official `codex app-server` protocol to the current Codex release it depends
on, behind DSH's own subagent tool. It replaces
`@deepseek-ai/dsh-subagent-codex`, which pins an old Codex client that current
ChatGPT-account models refuse and reports failures only as categories.
`@tack/codex` passes Codex's own error message, error code and model through,
and supports an output schema. Tack puts both on every profile and loads each
package's own `cordis.patch.yml`; existing profiles move from the DSH plugin
to `@tack/codex` when they next load.

The plugins register `subagent_claude_code` (provider `claude-code`) and
`subagent_codex` (provider `codex`). A call starts the child and returns its
id; the runtime delivers the result back to the parent. Tack's
`@tack/subagents` layer, on every profile after the providers, sets two
things. Claude Code runs in `auto` mode: the provider's own default, `dontAsk`,
denies every permission prompt, so a child could neither write a file nor run
a command; `auto` hands each request to Claude Code's permission classifier,
and the child's own user and project settings (hooks included) still apply.
And while an agent has a subagent or a background job running, a shell
`sleep` is refused with the way to wait: end the turn (the completion notice
opens the next one, and a headless run stays up until its children finish) or
`job_output` with `wait: true`. The `supervise`
profile cannot edit files or run commands itself, and it hands that work to
one of those tools.

```sh
tack run --profile supervise "npm test fails; get it passing"
```

In a research session (`tack web --profile research`, `tack run --profile
research-run`) the native `subagent*` tools are refused once the session is
bound to a delegation: workers start through `research_dispatch`, which
compiles the brief, charges the delegation's budget, records the attempt and
files the worker's report (see [Research](#research-molab)). A worker started
that way is an ordinary DSH child; its settlement reaches the supervisor the
way every subagent's does.

Both providers start the child through DSH's subprocess service, which scrubs
credential-shaped environment variables. Put a key or a gateway on the provider row, in the profile's
`cordis.patch.yml` or a `--patch` file. A patched `config` replaces the whole
row config:

```yaml
- id: subagent-claude-code
  config:
    permissionMode: bypassPermissions   # auto (Tack's default) | dontAsk | acceptEdits | plan | bypassPermissions
    env:
      ANTHROPIC_API_KEY: sk-...
      ANTHROPIC_BASE_URL: https://gw/   # optional

- id: subagent-codex                   # @tack/codex
  config:
    permissionMode: approve-for-me      # never (default) | approve-for-me | dangerously-bypass-approvals-and-sandbox
    model: gpt-6-sol                    # optional; the account's Codex default otherwise
    effort: high                        # optional
    env:
      OPENAI_API_KEY: sk-...
```

Claude's modes are `auto` (Tack's default; the provider's own is `dontAsk`), `dontAsk`, `acceptEdits`, `plan`, and
`bypassPermissions`. Outside `bypassPermissions` the plugin denies permission
prompts instead of asking a person. Codex's modes are `never` (the default),
`approve-for-me`, and `dangerously-bypass-approvals-and-sandbox`; an
unattended Codex run declines every request that needs a person and names
what it declined in the result. Under Tack's `auto`, an unattended Claude Code
child edits and runs tests; the classifier still refuses what it judges unsafe.

Each Codex run is recorded (the task, the model, every command Codex ran and
file it changed, and any hook Codex skipped because no person trusted it). A
run inside a molab workspace is recorded in `<workspace>/.molab/agents/codex/`;
`activityDir` on the row chooses another directory; any other run is left to
Codex, which persists it in its own session store. Tack's home keeps
configuration only.

To move to a newer Codex, bump `@openai/codex` in `packages/codex/package.json`,
then run `node packages/codex/scripts/protocol.mjs` to regenerate the protocol
types from that release. A protocol change then shows up as a type error.

`npm run test:agent` checks that the official tools are mounted.
`npm run test:live` runs one real Claude Code handoff when both
`DEEPSEEK_API_KEY` and `ANTHROPIC_API_KEY` are set.

## Research (Molab)

`tack web --profile research` supervises research bound to one Molab scope.
Start `molab serve` at the node the work belongs to (a project, experiment or
run); that node is the scope, and molab refuses anything above it. For a workspace whose campaign documents sit
at its root (like a hand-built one), serve the workspace root and bind each
delegation to a project with `scope`.

```sh
molab serve ~/lab/projects/polymer --port 8000   # the bound scope
MOLAB_URL=http://localhost:8000 tack web --profile research
```

The sidebar's **Research** entry opens the workbench without changing the
current conversation. Search and filter delegations, inspect their goals,
acceptance criteria, budgets, pending compute, worker rounds and decision
history, and read plans, briefs and reports inline. On a narrow screen the
list and detail switch views with **Back to delegations**. The panel follows
DSH's light/dark palette and refreshes from Molab every 15 seconds while visible.

A blocked delegation shows its questions and the exact gate target. **Send
answer** records a response without approving; **Approve** records the named
gate and resumes supervision. **Pause supervision** leaves submitted compute
running. Continuing, answering or approving leaves a durable wake request for
the existing watcher to deliver to the supervising DSH session. Actions use
DSH Connection's authenticated owner routes and the process identity
(`TACK_BY`, otherwise the OS user). A changed delegation rejects the action
until it is refreshed. The browser holds no authoritative research state.

`@tack/ui` fills DSH's sidebar and conversation brand slots in the `web` and
`research` profiles. `@tack/research` supplies its browser module and an optional
Connection API in the same package as its tools; headless profiles do not
mount a browser server. No installed DSH package is modified, and both client
modules use the React instance already supplied by DSH's module table.

New sessions start in the **Research** preset. DeepSeek supervises: it
plans, dispatches one worker round at a time, judges the worker's report and
decides. Workers run on DSH's subagent runtime (in-process DeepSeek, Claude
Code, Codex through `@tack/codex`); `tack run --profile research-run` is the
same for one step at a time. The research records go through the
`tack-research` tools:

| Step | Tool | Kept in Molab as |
| --- | --- | --- |
| Open bounded work: goal, authorized actions, budget, acceptance, stop conditions; `plan` adopts an existing Plan | `research_open` | `Delegation` |
| Read what exists first, whoever wrote it: Plan, Roadmap stages, Todo items, Milestones, experiments and runs | `research_context` | — |
| Replay the actual experimental sequence, including parameters, failures, resumes, decisions, approvals and historical document versions; read-only and paginated | `research_replay` | — (reads existing Molab records and git facts) |
| Check an existing workspace's format: molab's layout and knowledge rules plus Tack's record conventions (read-only) | `research_audit` | — |
| Testable plan with its parameters table (each value and its source; an uncertain one is asked, never guessed); one plan per delegation under a stable name, revised in place with a reason (its approval is withdrawn; molab's history keeps each version); a person approves it before any worker is dispatched | `research_plan` | `Plan` |
| Dispatch one worker round: the task, expected products and protocol; Tack compiles the brief, starts the worker, charges a worker run and files its report. `mode: draft` (the default until the dry run is approved) writes and dry-runs the workflow without executing; `mode: run` executes the approved one | `research_dispatch` | `Note` (brief), attempt on the Delegation, `Report` (worker report); science capability gaps merged into the one `capability-gaps` Todo |
| Preview the current source in an isolated scratch process: waves, branches and declared runs; no Delegation is needed for read-only inspection. `source: stored` explicitly inspects saved IR and historical run inventory instead | `molab_dry_run` | — |
| Experiments, runs, attempts (idempotent request keys), cancel, outputs and logs | `molab_*` | runs and attempts |
| Record an analysis that is not about one run as Markdown molab renders, citing at least one `molab:` ref; a structure report names its registered file (`molab:asset/<id>`), which molab opens in MolVis; no links to this machine; a new report on the same host replaces the last | `research_report` | `Report` (stable name) |
| Draw an interactive chart (bar, line, or scatter) with MolPlot, to look at during the session (its page lives on this machine; a report never links it) | `molplot_chart` | chart page |
| Open MolPlot's figure workbench on a Python script | `molplot_serve` | workbench page |
| Open a structure in MolVis's 3D stage, to look at during the session (a report cites the structure's `molab:asset` ref instead) | `molvis_stage` | viewer page |
| Draw a 2D formula on MolVis's board and link its page | `molvis_sketch` | viewer page |
| Ask a person (questions, a gate, more budget or authority): the delegation is blocked, not stopped; continue on their answer, recording their approval of a gate with `approve` | `research_decide` (`ask_human`), `research_resume` | decisions, answers and approvals on the Delegation |
| Remove a record written in error: the document is deleted (molab's history keeps it) | `research_retract` | — |
| Park until compute settles; a watcher wakes the session with a brief | `research_wait`, `research_status` | waits on the Delegation |
| Judge evidence at four levels: execution, data, analysis, conclusion; with `report`, execution and data are prefilled from the worker's report | `research_assess` | `Report` |
| Decide and cite evidence, kept in the Delegation's decision log; `conclude` writes the finding; `capability_gap` carries the component and reproduction steps (a science tool's gap becomes an item of the `capability-gaps` Todo; a molab, DSH or Tack gap is reported back, never written to the workspace) | `research_decide` | decision log entry, `Finding` |
| Pause supervision (compute keeps running) | `research_pause` | Delegation state |

**The brief** a worker receives is compiled once from the delegation and
kept as a `Note` (record kind `brief`, with the sha256 of its body): goal,
scope, acceptance, stop conditions and budget left; the round's task,
expected products and protocol (reproduce an execution exactly, or an
independent realization; seed, stereochemistry, charges); the current plan;
what people answered, verbatim; the last decision; the last three attempts
with their reports; the workflow path; known capability gaps; the workspace
rules (scratch only under an experiment's `scratch/`, `molab run --rerun
--fresh` to recompute, never hand-edit `index.md`, `executions/` or
`.molab/`; in-process workers use the `molab_*` tools, not the CLI; a probe
cap; report, don't guess); and the report contract.

**The report** every worker returns is one JSON object: `outcome` (done |
partial | blocked | failed), `summary`, `checks` (one per expected product
and acceptance criterion: verdict pass | fail | unknown, value, note),
`products` (path, kind, description), `files_changed`, `workflow`,
`protocol_deviations` (item, expected, actual), `capability_gaps`
(component molpy | atomiverse | molvis | molab | dsh | tack, title, repro,
version, fix), `open_questions`, `next`, `tokens`. A provider that captures
structured output (in-process, `@tack/codex`) fills it through
`structured_output`; Claude Code ends its reply with one fenced ```` ```json ````
block. Tack files it as a `Report` (record kind `worker_report`, authored by
the worker, linked to the attempt) and writes each capability gap as an
`Observation`; a missing or invalid report leaves a `check` on the attempt
instead. The supervisor assesses from the report (`research_assess` with
`report`) and reads the outputs only when the report is missing, invalid or
contradicts the acceptance criteria. Worker sessions keep to a worker's
tools: `research_context`, `research_audit`, `molab_create_experiment`,
`molab_create_run`, `molab_start_execution`, `molab_read_outputs`; the
recording and deciding tools are refused there.

**A report that does not come** is asked for once: when an in-process worker
(spawn, fork) ends with an error, no report, or one that does not parse, Tack
sends it one message asking for the report as a fenced ```` ```json ```` block
and reopens the attempt (its `check` says "report re-requested once"); the
reply's end files the report as usual. A second end without a valid report
settles the attempt as unreported and no third request is made; Claude Code
and Codex take no further messages, so their attempt settles at once.

**A worker is confined to the served root.** In a worker session bound to a
delegation, the file tools (`read`, `read_image`, `write`, `edit`, `glob`,
`grep`, `working_directory`) take paths inside the root, the temp directories
or `workers.allowedPaths`, and the arguments of a `bash` command stay there or
under a system prefix (`/usr`, `/opt`, `/etc`, …) while its executable may
live anywhere (a venv's python); a call that reaches another workspace is
refused with `TACK_WORKER_CONFINED` and told to work inside the root. Results
from other workspaces go into the brief as `attachments`; `workers.confine:
false` turns the confinement off, and the supervisor is never confined.

Budget and authority are a person's to widen:
`tack research amend <delegation> --budget worker_runs=10 --reason "..."`
records who, when and why on the delegation.

**Research replay.** In the Research panel, choose **研究回放** to step forward
or backward, play/pause, scrub the timeline, filter record types and inspect
the parameters and evidence for each step. **查看当时的文档** reads the version
recorded at that step, even if the plan was later rewritten or deleted.
This view uses the real served workspace, including when opened from the
design examples; it never re-executes compute or records an approval.

The same read-model is available without booting a model:

```sh
tack research replay --molab-url http://localhost:8000
tack research replay --experiment EXPERIMENT_ID --kind execution --limit 100 --json
```

Set `MOLAB_URL` to change the default server. Follow a page's `nextOffset`
with `--offset` and its `asOf` with `--as-of`. The `research_replay` tool also
accepts a recorded event's `document` and `commit` to read that exact version.
Execution ids are qualified by run; simultaneous attempts remain overlapping
in time. Molab's saved attempt records fill missing git lifecycle events.
When document history is unavailable, replay says so instead of inventing
past decisions. Product entries describe their current registered version.

**Human gates.** The supervisor does not guess: four checkpoints need a
person before the work moves on. The tools enforce them, and the supervisor
never records an approval the person did not give.

| Gate | Where | What the person does |
| --- | --- | --- |
| `parameters` | before `research_plan` | Answers the simulation parameters the goal, the workspace and the literature do not settle (system size and composition, force field and parameter set, charge model, box/PBC and density, ensemble/thermostat/barostat, timestep and duration, seeds, acceptance tolerances); a plan with an `uncertain` parameter is refused |
| `plan` | after `research_plan` | Approves the Plan (`批准 <plan path>` / `approve <plan path>`) before any worker is dispatched; a revised plan needs approval again |
| `dry_run` | after the draft round | Approves the workflow's dry run (`molab workflow dry-run <script.py> --json` for a CLI worker, `molab_dry_run` in-process: waves, branches, runs) before `research_dispatch mode: run`, `molab_start_execution` or a worker's `molab run`; until then a worker session's `molab run` (with or without `--dry-run`, which still creates runs) and `molab_start_execution` are refused with `TACK_GATE_DRYRUN`. An approval names the experiment's path (what the dry run prints) or the workflow path under it, and covers both |
| `results` | before `conclude` | Approves the latest assessment Report |

A gate question is `research_decide ask_human` with `gate: {gate, target}`:
the delegation is blocked, its questions carry a `[gate:<gate> target:<path>]`
marker (molab's Delegation record has no field for it), and the run ends.
When a delegation the run worked on is blocked, `tack run` prints after its
answer a line `TACK-GATE` followed by one JSON object `{delegation, state,
gate, target, questions}` (one per blocked delegation; in `--json` mode too,
after the event stream), so the agent that invoked it reads the questions and
writes the answer, or `批准 <path>`, in the next prompt. The supervisor
records that answer with `research_resume`, passing `approve: {gate, target}`
only when the words clearly approve that target. Who answered is never the
model's choice: a headless run records `TACK_BY`, else the OS user. Approvals
live on the Delegation record (`approvals: [{gate, target, by, at, note}]`),
where a web client will answer through the same records; there is no CLI for
approvals. `gates.parameters`, `gates.plan`, `gates.dryRun` and
`gates.results` in the `tack-research` row config switch each gate off
(default on).

`research_context` accepts `section`, `offset` and `limit` for paged reads
(for example, `section: recentRuns`). `molab_read_outputs` defaults to results
and paged assets/evidence for exactly the requested run and attempt; select
`section: assets`, `results`, `evidence` or `unregistered`, and read logs
separately with `log` and its byte offset. Truncation is marked as valid JSON,
never a silently cut document. Viewer tools mount without starting a server;
their Python/CLI dependencies are resolved on first use. `doctor` also checks
that the research viewer tools actually register. `MOLPLOT_PYTHON` selects an
interpreter explicitly; otherwise the MolPlot or Molab CLI shebang supplies it.

Tack keeps no authoritative state. Every record is a Molab knowledge document,
and every change is a commit in the workspace history. After a restart, the
watcher reconciles waits against Molab: it finds a lost submission by its
request key instead of resubmitting it. `MOLAB_TOKEN` carries a bearer token
when molab runs with `--auth`. The `tack-research` row config sets `molab.url`,
`pollSeconds`, `workers.confine`, `workers.allowedPaths` and the `gates`.

## Runtime updates

The runtime is pinned to one exact version, set by hand. To move to a new
release (Node 22.18 or newer runs the TypeScript scripts directly):

1. Set every `@deepseek-ai/*` pin in the runtime and plugin package manifests
   to the same exact version; the isolation test rejects ranges and mixed versions.
2. `npm install`
3. `node scripts/runtime-closure.ts diff` lists new and removed runtime
   packages; review them and record the decisions with
   `node scripts/runtime-closure.ts write` (check its output before committing).
4. `npm run lint && npm run typecheck && npm test`

Every runtime package Tack installs is reviewed in `packages/tack/runtime-closure.json`
(source group, class, and decision: use, compose, disable, or forbidden).
A new upstream package fails verification until it is classified. The web shell
and its plugins are used as published, with Tack's browser extensions composed
through their public slots. Experimental packages are not installed.
DeepSeek's account, telemetry, and feedback rows stay disabled. Installed
package files are not patched.

The pin is one version for every `@deepseek-ai/*` package. Use the version of
`@deepseek-ai/dsh` on the npm `latest` tag (currently `0.2.1-rc.5`). The
`latest` tag on individual packages is stale and is not the runtime version.
`0.2.2-alpha.3` is the `alpha` tag, not this pin.

## Environment

| Variable | Meaning |
| --- | --- |
| `TACK_HOME` | Tack home; profiles, sessions, and settings live here. Default `~/.tack`. |
| `DEEPSEEK_API_KEY` | Key for the default provider (DeepSeek). Other providers use their own names, e.g. `ANTHROPIC_API_KEY`; `tack auth set` stores them in `$TACK_HOME`. |
| `DEEPSEEK_BASE_URL` | Optional provider base URL. |

A `.env` file in the working directory or in `$TACK_HOME` is also read.
