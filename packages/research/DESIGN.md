---
name: Research Workspace
description: The research map and experiment workbench inside DSH.
colors:
  canvas: "#f9f9f6"
  surface: "#fff"
  soft: "#f2f2ed"
  grid: "#e9e9e2"
  line: "#dadad2"
  ink: "#15171c"
  muted: "#676b73"
  faint: "#b3b5ae"
  blue: "#1f4fd8"
  green: "#17795a"
  amber: "#a3620c"
  violet: "#6d4aa8"
  red: "#b3372f"
typography:
  title:
    fontFamily: '"IBM Plex Serif", "Noto Serif SC", "Songti SC", Georgia, serif'
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.25
  section:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "PingFang SC", sans-serif'
    fontSize: "13px"
    fontWeight: 600
  body:
    fontFamily: '"IBM Plex Sans", "Noto Sans SC", "PingFang SC", sans-serif'
    fontSize: "12px"
    lineHeight: 1.5
  label:
    fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace'
    fontSize: "10px"
  code:
    fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, monospace'
    fontSize: "11px"
rounded:
  field: "8px"
  callout: "12px"
  experiment: "14px"
  card: "18px"
  pill: "20px"
  question: "28px"
spacing:
  tight: "6px"
  small: "8px"
  base: "12px"
  medium: "16px"
  card: "18px"
  edge: "24px"
components:
  pill:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    height: "40px"
    padding: "0 16px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "18px"
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "17px"
    height: "34px"
    padding: "0 16px"
  button-approve:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.surface}"
  map-question:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.question}"
    width: "240px"
    height: "124px"
  map-stage:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
    width: "224px"
    height: "104px"
  map-experiment:
    backgroundColor: "{colors.soft}"
    rounded: "{rounded.experiment}"
    width: "236px"
    height: "64px"
  map-finding:
    backgroundColor: "{colors.canvas}"
    rounded: "23px"
    width: "264px"
    height: "46px"
---

# Design System: Research Workspace

## Overview

Research is a workbench for one conversation bound to one experiment. Its visual authority is the approved [Figma V5 research map](https://www.figma.com/design/D2VXVTN9uXewaTbB27LzZg?node-id=73-2), translated into `client/` and the shared `src/map-layout.ts`. The direction is scientific and modern: paper, ink, a graph-paper grid and one cobalt accent. It is not a dark or glowing interface.

Research is not linear. The one flow a person sees is a **research map** of the whole workspace: its knowledge documents and how they refer to each other. Detail appears only when asked for: selecting a node dims the rest and opens one floating card.

Open **Research** beside **Automation tasks** in DSH's left sidebar (`sidebar.panellist`, order 11). The main-slot gate resolves the selected conversation's durable experiment marker. DSH keeps the shell, sessions, conversations, tools and runtime.

**Key characteristics:**

- A full-bleed canvas. No rail, header band, records strip or always-open inspector.
- Floating pills for location and view switching; floating cards for status, details and decisions.
- Progress first, detail by interaction.
- Every node, status and edge comes from a Molab record.

## Colors

Frontmatter is normative. CSS custom properties are scoped to `.tw-workspace`.

- **Cobalt** (`blue`): the question, the in-progress state, selection rings, links and focus outlines. The only accent.
- **Green** (`green`): done stages, met milestones, findings.
- **Ochre** (`amber`): anything waiting for a person: a blocked work item, a pending gate, the approve button.
- **Red** (`red`): errors and a lost connection.
- **Paper** (`canvas`), **white** (`surface`), **soft** (`soft`): canvas, cards, and experiment nodes or selected segments.
- **Ink**, **muted**, **faint**: text, metadata, and not-started edges.

**The status text rule.** Colour accompanies a written status; it never carries the only explanation.

## Typography

Serif for what a person reads as a statement (the question, card titles, the status headline); sans for interface copy; mono for labels and recorded identifiers (tags, counts, paths). The stacks name IBM Plex first and fall back to the self-hosted Noto Sans SC and system fonts. **IBM Plex is not bundled yet**: without it installed the fallbacks render.

Interface copy is English. Titles, criteria and findings are shown as recorded, in whatever language they were written.

## Layout

The workbench fills its DSH main slot and honours `--dsh-frame-top-clearance`. One view fills the stage; everything else floats (24px) from the edges:

- top left: location pill (back to conversation, experiment name, current view);
- top right: connection state and the view switch (**Map**, **Timeline**, **Plan**);
- bottom centre: the conversation composer (560px);
- under the location pill: a small zoom pill;
- bottom left: the **Now** card on the map;
- right: the details card of the selected node (352px);
- bottom right: the decision card (406px) while the experiment waits for a person.

Below (900px) cards span the width and the details card moves to the bottom.

### The research map

The map is Molab's knowledge graph and nothing else. **Every node is a knowledge document. Every arrow is a reference one document makes to another, drawn in the direction of the reference**, from the document that refers to the document referred to. Tack adds no class, no relation and no node of its own.

The three layers stay orthogonal. Tack plans in knowledge: questions, plans, findings and how they rest on each other. Molab's workflow governs every piece of code that runs. Molab's workspace governs every asset. Experiments, runs and assets are therefore not nodes; a document's references to them are listed in its preview. If the map and the knowledge ever disagree, fix the knowledge or the map so they match; never add a node the knowledge does not hold.

`src/map-layout.ts` places a document one column right of the deepest document it rests on (`derived_from`, `supersedes`, `supports`, `contradicts`), so those arrows point left; a mention moves nothing. Documents of one depth are split into columns of at most six, one class after another (the reasoning, then the organisation of the work, then what is told), and rows follow where their references sit. A node shows the document's title, not its file name. Documents that refer to each other in a circle are cut where the circle closes.

## Elevation & Depth

Depth comes from one soft shadow on floating cards and pills and one-pixel borders. Nodes have no shadow. Selection is a (5px) translucent cobalt ring, never a glow. Reduced-motion preferences disable transitions.

## Shapes

Each kind of record has its own shape so the map reads without labels: the question is a large capsule with a ring; a stage is a rounded card; an experiment is a compact soft block; a finding is a pill with a diamond. A stage that has not started is dashed and unfilled. Edges are curves without arrowheads; a dashed edge leads to something not started.

## Components

### Pills, cards and buttons

Pills are (40px) high. Segmented switches inside a pill are tablists: arrow keys, Home and End move between segments. Buttons are (34px) capsules; the cobalt button saves a local draft and the ochre button approves a gate. Cards use the card radius and padding and may scroll.

### Map nodes and previews

Shape follows the document's class: a **Plan** is the large ringed capsule; a **Hypothesis**, **Decision**, **Roadmap**, **Todo**, **Milestone** or **Report** is a card with its class tag and written state; a **Finding**, **Observation** or **Literature** entry is a pill with a diamond.

The reasoning's control flow is drawn from the records and the references, never from extra nodes. A **Hypothesis** shows its verdict: being tested (cobalt), supported (green), refuted (red), unsettled (dashed). A **Decision** is decided, or waits for a person (ochre) and is then listed in the **Now** card. An iteration is a document that `supersedes` another. Delegations, briefs and plain notes are operational records and stay off the map.

An arrow leaves the referring document on its left and enters the document referred to on its right. Its stroke says what kind of reference it is: `derived_from` is solid ink, `supports` green, `contradicts` red, `supersedes` dashed ochre, `cites` / `references` / `records` faint and dashed.

The map does not draw every reference. Three kinds are **folded**: a mention (`cites`, `references`, `records`); a structural reference (`derived_from`, `supersedes`, `supports`, `contradicts`) that a longer chain between the same two documents already implies; and, when more than six documents rest directly on the same one, the arrows of all but the nearest column of them. **All references** in the zoom pill unfolds them. Selecting a document shows every reference it makes or receives and quiets the rest. A folded reference is never lost: it is listed in the document's preview.

Status is read from the planning records, never from the graph: a Roadmap rolls up its stages, a Todo its items, a Milestone is met or open.

**Click** a node to preview the document: everything it has no arrow to dims, and a card shows its record (stages with their dependencies, work items, the closing criterion), what it refers to and what refers to it with each reference's role, its references to workspace entities and URLs, and its text. **Double-click**, or **Open page** in the preview, opens the document as a page in a new tab: the page Molab itself renders for a reader (markdown typeset, sources listed, every figure inlined), so Tack has no renderer of its own. The page is served sandboxed into an opaque origin, so nothing a document carries can act as the workbench.

A document filed under the experiment this conversation is bound to has a cobalt border.

The **Now** card opens as one line (stages done, how many things wait for a person, milestones met) and expands on click to show, for this conversation's experiment: its state, the four human gates (approved, waiting, not reached), spent against budget for every budgeted quantity, **Pause** or **Resume**, and up to three blocked work items.

A map refresh updates nodes in place and keeps the viewport; the canvas is redrawn only when a node, an arrow or a status changes.

### Conversation composer

The composer at the bottom centre is DSH's own, for the selected conversation: the shared `conversation.content` Factory instantiated as an `embedded` occurrence whose `views` position renders nothing, the way DSH's Sidebar chat embeds it. Draft, queue, attachments and question takeovers are DSH's. Research only sizes it; it never reimplements sending. The main-slot entry declares one `session-maybe` child slot, `tack.research.workbench`, so the workbench receives the session scope the Factory needs.

### Decision card

Shown while this conversation's experiment is `blocked`. It quotes the recorded questions and takes a written answer; **Send answer** posts it, and when a gate is pending **Approve** approves it with the text as a note. Each action posts the reviewed snapshot's digest to `/api/tack/research`, which runs the same research tools as the conversation and refuses a changed record.

### Plan, Records and Replay

**Plan** shows the current Plan document. **Timeline** lists execution waits, worker rounds and decisions for this conversation's experiment as three separate tables and opens **Replay**, which keeps its own styles in `client/replay.css`.

## Data and scope

`GET /api/tack/research?session=…&map=1` returns the map built by `src/research-map.ts` from Molab's `GET /api/knowledge/graph` (documents and typed references) and the planning records. It answers only a conversation that carries an experiment marker, and names the experiment that conversation is bound to. `&node=<path>` returns a document only if it is on the map; with `&page=1` it returns it as a sandboxed HTML page. Scoped reads for the Plan document and records return only that conversation's experiment.

Tack's own writers keep the graph connected: an assessment and a report refer to the Plan they answer, and a finding refers to its evidence, the assessment that judged it and that Plan.

To put something on the map, write a knowledge document; to draw an arrow, refer to another document with the role that fits. Molab's classes answer one question each (Plan, Hypothesis, Roadmap, Todo, Milestone, Observation, Decision, Finding, Report, Literature); a Finding `supports` or `contradicts` a Hypothesis, a revision `supersedes` what it revises, and everything else `derived_from` what it rests on.

## Do's and Don'ts

### Do:

- **Do** open on the map and reveal detail only on selection.
- **Do** keep Research's tokens and fonts scoped to its workspace.
- **Do** pair every colour with written status.
- **Do** keep execution waits, worker rounds and research iterations as separate records.

### Don't:

- **Don't** build a second message box: the composer is DSH's.
- **Don't** bring back a navigation rail, header band, records strip or always-open inspector.
- **Don't** use a dark theme, glows or neon accents.
- **Don't** draw a node that is not a knowledge document, an arrow that is not a reference, or an arrow against the direction of its reference.
- **Don't** let the sidebar entry bypass the conversation marker gate, or pick an arbitrary delegation when a binding is ambiguous.
- **Don't** infer research iterations from worker rounds.
- **Don't** add a second flow view whose nodes are not knowledge documents. There is one flow: the map.
