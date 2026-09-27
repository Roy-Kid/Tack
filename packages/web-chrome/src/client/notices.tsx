/** Settings surfaces Tack owns: the first-run welcome step and the version row. */
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { useEffect, useRef, useState } from "react";
import type { BrowserChrome } from "./chrome.js";

interface OnboardingStepProps {
  complete: () => void;
}

const storageKey = (chrome: BrowserChrome) => `tack.welcome:${chrome.welcome.title}\u0000${chrome.welcome.body}`;

function acknowledged(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Private windows may refuse storage; the notice then shows once per page load.
  }
}

export function noticeComponents(chrome: BrowserChrome) {
  /** Shown once per distinct text; disabled or acknowledged completes the step at once. */
  function WelcomeNotice({ complete }: OnboardingStepProps) {
    const key = storageKey(chrome);
    const [open, setOpen] = useState(() => chrome.welcome.enabled && !acknowledged(key));
    const finished = useRef(false);
    const finish = () => {
      if (finished.current) return;
      finished.current = true;
      complete();
    };
    useEffect(() => {
      if (!open) finish();
    });
    if (!open) return null;
    const close = () => {
      remember(key);
      setOpen(false);
    };
    return (
      <Modal
        open
        onClose={close}
        title={chrome.welcome.title || chrome.product.name}
        closeLabel="Close"
        footer={
          <Button variant="primary" onClick={close} data-tack-welcome-ok="">
            OK
          </Button>
        }
      >
        <div data-tack-welcome="" style={{ color: "var(--dsw-alias-label-secondary)", fontSize: 14, lineHeight: "22px" }}>
          {chrome.welcome.body.split("\n\n").map((paragraph) => (
            <p key={paragraph} style={{ margin: "0 0 12px" }}>
              {paragraph}
            </p>
          ))}
        </div>
      </Modal>
    );
  }

  function VersionRow() {
    return (
      <div
        data-tack-version=""
        style={{ color: "var(--dsw-alias-label-primary)", overflowWrap: "anywhere", padding: "16px 0", fontSize: 14, lineHeight: "22px" }}
      >
        {chrome.version.label}
      </div>
    );
  }

  return { WelcomeNotice, VersionRow };
}
