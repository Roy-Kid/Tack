/**
 * Browser half of Tack's web chrome. Reads the settings the host half put in
 * the page and fills the runtime's brand and settings slots; owns the title.
 * No runtime component is replaced: every surface is a declared slot or the
 * document title.
 */
import type { ComponentType } from "react";
import { brandComponents } from "./brand.js";
import { readChrome } from "./chrome.js";
import { noticeComponents } from "./notices.js";
import { ownTitle } from "./title.js";

interface SlotRegistration {
  name: string;
  id?: string;
  order?: number;
  priority?: number;
}

interface ClientContext {
  slots: {
    inject(name: string, callback: () => unknown): void;
    register(registration: SlotRegistration, component: ComponentType<never>): unknown;
  };
  effect(execute: () => () => void, label?: string): void;
}

export const inject = ["slots"];

/** Lower than any runtime registration, so Tack's entries win their slot or id. */
const TACK_PRIORITY = -1;

export function apply(ctx: ClientContext): void {
  const chrome = readChrome();
  const { BrandMark, BrandName } = brandComponents(chrome);
  const { WelcomeNotice, VersionRow } = noticeComponents(chrome);
  const fill = (registration: SlotRegistration, component: ComponentType<never>) =>
    ctx.slots.inject(registration.name, () => ctx.slots.register({ priority: TACK_PRIORITY, ...registration }, component));

  fill({ name: "sidebar.brand.mark" }, BrandMark as ComponentType<never>);
  fill({ name: "sidebar.brand.name" }, BrandName as ComponentType<never>);
  fill({ name: "conversation.hero.brand.mark" }, BrandMark as ComponentType<never>);
  fill({ name: "settings.onboarding", id: "welcome-notice", order: -100 }, WelcomeNotice as ComponentType<never>);
  if (chrome.version.show) fill({ name: "settings.general.item", id: "current-version", order: 100 }, VersionRow as ComponentType<never>);
  else fill({ name: "settings.general.item", id: "current-version", order: 100 }, (() => null) as ComponentType<never>);
  ctx.effect(() => ownTitle(chrome.product.name, chrome.product.titleSeparator), "tack-web-chrome: title");
}
