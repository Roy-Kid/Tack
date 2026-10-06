/**
 * The runtime's UI primitives exist only as a browser seed module (no npm
 * package to type against). These are the props this card uses.
 */
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type { ReactElement, ReactNode } from "react";

  export function TextShimmer(props: { active?: boolean; className?: string; children?: ReactNode }): ReactElement;
}
