/* DSH supplies React through its browser module table. No second React root. */
window.__ModuleLoader__.load({
  id: "@tack/ui",
  factory: (require) => {
    const { createElement: h } = require("react");
    function TackMark({ size = 28, className }) {
      return h("svg", { width: size, height: size, viewBox: "0 0 32 32", fill: "none", className, "aria-hidden": true },
        h("path", { d: "M6 7h20M16 7v19M10 13h12", stroke: "currentColor", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function TackName() {
      return h("span", { style: { fontSize: 20, fontWeight: 650, letterSpacing: "-0.03em" } }, "Tack");
    }
    function TackHero({ size, className }) {
      return h("div", { className, style: { display: "flex", alignItems: "center", gap: 14 } },
        h(TackMark, { size: Math.min(size, 52) }),
        h("span", { style: { fontSize: 36, fontWeight: 600, letterSpacing: "-0.03em" } }, "Tack"));
    }
    return {
      inject: ["slots"],
      apply(ctx) {
        ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark" }, TackMark));
        ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name" }, TackName));
        ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, TackHero));
        ctx.effect(() => {
          const original = document.title;
          const update = () => {
            const title = document.title.replace(/DeepSeek Harness|DeepSeek Local|DSH Local Build|Local Build/gi, "Tack");
            if (title !== document.title) document.title = title;
          };
          const observer = new MutationObserver(update);
          observer.observe(document.head, { subtree: true, childList: true, characterData: true });
          update();
          return () => { observer.disconnect(); document.title = original; };
        });
      },
    };
  },
});
