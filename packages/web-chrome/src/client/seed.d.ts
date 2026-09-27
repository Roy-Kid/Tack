/**
 * The runtime's UI primitives exist only as a browser seed module (no npm
 * package to type against). These are the props Tack uses.
 */
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

  export function Modal(props: {
    open: boolean;
    onClose: () => void;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    className?: string;
    contentClassName?: string;
    closeLabel: string;
  }): ReactElement | null;

  export function Button(
    props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "ghost" | "primary"; "data-tack-welcome-ok"?: string },
  ): ReactElement;
}
