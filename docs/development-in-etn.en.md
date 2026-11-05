[Русский](development-in-etn.md) | **English**

# Developing ETN — inside ETN

*A short story of how this project is designed, planned, developed and
documented in a graph knowledge base — in ETN itself, together with AI agents.
No wiki, no task tracker and no thousand-line rules file.*

How the project came to be — read in [`history-creation.en.md`](history-creation.en.md).
This page is about how the work is organized today.

## A familiar pain

Modern agentic environments already keep memory between sessions
and support skills so that `AGENTS.md` does not bloat. But project knowledge still
lives wherever it happens to be: the specification — in a wiki or in thousand-line files,
a decision — in a chat, a task — in a tracker, "why it is like this" — in someone's head.

As a result, the agent finds a document, reads it in full for a couple of relevant lines —
and still has to guess that some decisions, requirements, constraints and pitfalls
are connected to those lines. The context is clogged by brute-force reading, tokens
are wasted, and the links — the very thing that turns facts into understanding —
have to be reconstructed by the agent itself.

In ETN this pain is closed structurally: the project knowledge base is ETN itself.
A thought network (that is what the base is called here — a graph of typed linked thoughts)
is maintained by a human and agents together, and through the built-in MCP server agents
work with it directly.

## What lives in the thought network

The project base is an ordinary ETN network, no magic. In it, as linked
thoughts:

- **Specifications** — the truth about the product: entities, API operations, UI
  elements, requirements, scenarios. The rule is simple: the code diverges from the spec —
  that is a code bug, not "a different vision".
- **Decisions (ADRs) and standards** — why this was chosen and not otherwise; which
  rules are mandatory and what verifies them.
- **Work plans** — versions, tech projects, tasks, bugs. Major
  functionality is first agreed as a tech project: why, what
  will change, boundaries, acceptance criteria. The intent is recorded at the start
  and is not rewritten after the fact — the base remembers what was agreed.
- **Codebase map** — a card for every module: what it is responsible for, which
  specification governs it, what has already happened to it. Before a change, the agent
  opens the card first, not the file.
- **Pitfalls and research** — recorded environment traps and reconnaissance results.
  Stepping into the same puddle twice is hard: the puddle is documented and linked
  to a component.
- **Instructions for agents** — two dozen-plus procedures: "create a task",
  "work on a version", "publish a release"... These are the same skills, but they live
  in the base: an instruction can be fixed on the fly, without restarting the session,
  and the agent finds the right one by situation — it is linked to everything it
  concerns.

Everything is linked to everything: a found task shows its tech project and version,
a component shows its specification and edit history, a standard shows what it governs.
The agent does not have to guess and scan files — it gets what it found together
with its surroundings. Fewer tokens, cleaner context, more precise decisions.

## The development cycle

1. **Tech project.** An idea appears — the agent shapes it into a tech project: why,
   what will change, boundaries (what is in and what is not), key decisions, acceptance
   criteria. They start pestering the human with questions until everything significant
   is clarified — details and forks alike. This is an agreement document;
   the intent is recorded at the start and is not rewritten after the fact. A large
   intent is split into sub-projects.
2. **Elaboration.** The approved tech project is assigned a version and elaborated
   in that version's layer: specs (entities, operations, requirements),
   ADRs, tasks. A layer is a branch for the graph: everything born while working
   on a version is invisible in the base until the version is published. The spec is not
   written ahead of the code — the base holds only what is implemented and verified.
3. **Design audit.** Before the tasks go into development, an independent
   subagent checks the elaboration: completeness, feasibility, unresolved
   forks. Findings range from critical to suggestions, and fixes go in iterations
   until the auditor agrees.
4. **Execution.** Each piece of work is done by a developer subagent following an instruction
   from the base; what is submitted is checked before acceptance by an independent tester subagent —
   tests, guards, acceptance criteria; blockers go back to the executor.
   Reports land as dated entries right in the tasks: what was done,
   in which commits, which pitfalls were collected along the way.
5. **Release.** Merging the branch and the layer, changelog, rebuilding the documentation,
   tag and publication on GitHub — all according to an instruction from the base, with checkpoints
   and recorded pitfalls from past releases.
6. **Self-improvement.** The cycle closes on itself — the system improves itself.
   A defect found along the way is registered by the agent as a bug linked
   to a component — even if it will only be fixed in the next version;
   a non-obvious environment trap becomes a recorded pitfall, and the next
   agent will not fall into it. An instruction fails — it is updated immediately,
   not "someday"; after every piece of work — a short retro: what the base
   should have hinted at but did not. The executor reports organizational problems
   to the orchestrator, and the orchestrator adjusts the procedures.
   Every version is built on a base that is a little smarter than it was before
   the previous one.

## Documentation is assembled from the same base

The files in `docs/` are not the source but a build. The "Publications" feature
turns part of the graph into a coherent document: sections are selected thoughts,
texts are their comments. One CLI command rebuilds all documents:

- edit a thought — and the documentation is updated on rebuild;
- the export is deterministic: with no changes in the base, the files do not change
  byte by byte, so git gets clean diffs;
- specifications, ADRs and user guides are assembled by the same
  mechanism, which is available to every ETN user.

## What it gives you

- **Agents work on their own.** They write their own tasks — and link them
  to modules, requirements and specifications. They find and register
  bugs along the way — and fix them themselves. They assemble the changelog
  and publish new versions on GitHub. The human's role is to set goals,
  approve tech projects and make decisions.
- **A new agent joins the project in minutes.** Instructions, specifications
  and history are in place, linked, and found by search and views.
- **Experience is not lost.** Decisions, pitfalls, reports and agreements remain
  in the base and surface through links — exactly when they are relevant.
- **Freedom without going rogue.** The specification is at hand, standards
  are mandatory, and acceptance is done by an independent agent.
- **One base — the whole project.** From the intent to the release documentation, including
  this very page.

> The ETN maintainer deliberately never opens the project code: task setting,
> approval of plans and acceptance all go through the thought network
> and agents.

## How to try it yourself

1. Stand up an ETN server — Docker or Node.js 22,
   [`userdocs/install.md`](userdocs/install.md).
2. Connect your agent over MCP — instructions for popular environments
   in [`userdocs/ai-agents.md`](userdocs/ai-agents.md).
3. Start small: move one section of knowledge into a network — say, the rules
   for working with your project — and watch the agent start finding
   and following them on its own.

ETN is developed by one person and several AI agents. In a couple of months
of this work the project base grew to almost one and a half thousand thoughts — and nothing
stops you from setting up the same for your project.
