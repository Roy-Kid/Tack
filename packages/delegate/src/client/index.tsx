/**
 * Browser half of `@tack/delegate`: the `delegate` call's card. It replaces
 * the call's own row only; the runtime still renders the delegated agent's
 * mirrored tool calls (`<agent>.<Tool>`) nested underneath it.
 */
import { useState, type ComponentType, type KeyboardEvent } from "react";
import { TextShimmer } from "@deepseek-ai/dsh-client-ui-primitives";
import { cardModel, type CallBlock, type CardModel } from "../view.js";
import { CARD_CSS } from "./style.js";

interface ClientContext {
  slots: {
    inject(name: string, callback: () => unknown): void;
    register(registration: { name: string; key?: string; priority?: number }, component: ComponentType<never>): unknown;
  };
}

interface DelegateRowProps {
  phase: "preparing" | "start" | "result";
  block: CallBlock;
  openFile?: (path: string) => void;
}

export const inject = ["slots"];

/** The tool name this card renders; matches @tack/delegate's default `toolName`. */
const TOOL_NAME = "delegate";
const STYLE_ID = "@tack/delegate/card.css";

const STATUS_LABEL: Record<CardModel["state"], string> = {
  preparing: "Preparing",
  running: "Working",
  completed: "Completed",
  partial: "Partial",
  failed: "Failed",
  cancelled: "Cancelled",
  error: "Error",
};

function agentTitle(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function installStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID.replace(/[^a-z0-9-]/gi, "-")) !== null) return;
  const tag = document.createElement("style");
  tag.id = STYLE_ID.replace(/[^a-z0-9-]/gi, "-");
  tag.dataset.plugin = "@tack/delegate";
  tag.textContent = CARD_CSS;
  document.head.appendChild(tag);
}

function Body({ model, openFile }: { model: CardModel; openFile: ((path: string) => void) | undefined }) {
  return (
    <div className="tack-delegate-body" data-tack-delegate-body="">
      {model.detail !== undefined ? <p className="tack-delegate-detail">{model.detail}</p> : null}
      {model.filesChanged.length > 0 ? (
        <section className="tack-delegate-section" aria-label="Files changed">
          <div className="tack-delegate-label">Files changed</div>
          <ul className="tack-delegate-list">
            {model.filesChanged.map((path) => (
              <li key={path}>
                {openFile !== undefined ? (
                  <button type="button" className="tack-delegate-file" onClick={() => openFile(path)}>
                    {path}
                  </button>
                ) : (
                  <code>{path}</code>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {model.commands.length > 0 ? (
        <section className="tack-delegate-section" aria-label="Commands">
          <div className="tack-delegate-label">Commands</div>
          <ul className="tack-delegate-list">
            {model.commands.map((command, index) => (
              <li key={`${index}:${command.command}`}>
                <code>{command.command}</code>
                <span className="tack-delegate-exit" data-ok={command.exitCode === 0 || undefined}>
                  exit {command.exitCode}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {model.tests !== undefined ? (
        <section className="tack-delegate-section" aria-label="Tests">
          <div className="tack-delegate-label">Tests</div>
          <div>
            <code>{model.tests.command}</code>{" "}
            <span className="tack-delegate-exit" data-ok={model.tests.passed || undefined}>
              {model.tests.passed ? "passed" : "failed"}
            </span>
            {model.tests.details ? <span className="tack-delegate-muted"> · {model.tests.details}</span> : null}
          </div>
        </section>
      ) : null}
      {model.followUps.length > 0 ? (
        <section className="tack-delegate-section" aria-label="Follow-ups">
          <div className="tack-delegate-label">Follow-ups</div>
          <ul className="tack-delegate-list">
            {model.followUps.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {model.footer !== undefined ? <div className="tack-delegate-footer">{model.footer}</div> : null}
    </div>
  );
}

function DelegateRow({ phase, block, openFile }: DelegateRowProps) {
  const model = cardModel(phase, block);
  const [open, setOpen] = useState(false);
  const active = model.state === "preparing" || model.state === "running";
  const expanded = open && model.expandable;
  const toggle = () => setOpen((value) => !value);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!model.expandable || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggle();
  };
  const interactive = model.expandable ? { role: "button", tabIndex: 0, "aria-expanded": expanded, onClick: toggle, onKeyDown } : {};
  return (
    <div className="tack-delegate-card" data-tool="delegate" data-state={model.state} data-tack-delegate-card="">
      <div className="tack-delegate-row" data-expandable={model.expandable || undefined} {...interactive}>
        <span className="tack-delegate-dot" data-state={model.state} aria-hidden="true" />
        <TextShimmer active={active}>
          <span className="tack-delegate-title">{agentTitle(model.agent)}</span>
        </TextShimmer>
        <span className="tack-delegate-separator" aria-hidden="true" />
        <span className="tack-delegate-headline">
          <TextShimmer active={active}>{model.headline}</TextShimmer>
        </span>
        <span className="tack-delegate-status" data-state={model.state} data-tack-delegate-status="">
          {STATUS_LABEL[model.state]}
        </span>
      </div>
      {expanded ? <Body model={model} openFile={openFile} /> : null}
    </div>
  );
}

export function apply(ctx: ClientContext): void {
  installStyle();
  ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({ name: "tool.call.toolview", key: TOOL_NAME }, DelegateRow as ComponentType<never>));
}
