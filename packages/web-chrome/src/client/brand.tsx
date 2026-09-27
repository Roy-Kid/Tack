/** Brand slots: the sidebar and hero marks and the sidebar product name. */
import { useEffect, useState } from "react";
import type { BrowserChrome } from "./chrome.js";

const DARK_ATTRIBUTE = "data-ds-dark-theme";

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.body.hasAttribute(DARK_ATTRIBUTE));
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.body.hasAttribute(DARK_ATTRIBUTE)));
    observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

export function brandComponents(chrome: BrowserChrome) {
  function BrandMark({ size, className }: { size?: number; className?: string }) {
    const dark = useDarkTheme();
    const px = size ?? 24;
    return (
      <img
        data-tack-brand-mark=""
        className={className}
        src={dark ? chrome.assets.logoDark : chrome.assets.logo}
        alt=""
        width={px}
        height={px}
        draggable={false}
        style={{ width: px, height: px, objectFit: "contain", display: "block" }}
      />
    );
  }

  function BrandName() {
    return (
      <span
        data-tack-brand-name=""
        style={{
          color: "var(--dsw-alias-label-primary)",
          fontFamily: "var(--dsw-font-family-brand, var(--dsw-font-family))",
          fontSize: 16,
          fontWeight: 600,
          lineHeight: "24px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {chrome.product.name}
      </span>
    );
  }

  return { BrandMark, BrandName };
}
