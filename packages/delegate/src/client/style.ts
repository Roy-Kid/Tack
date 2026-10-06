/** The delegate card's styles, on the runtime's theme tokens so both themes follow. */
export const CARD_CSS = `
.tack-delegate-card{display:flex;flex-direction:column}
.tack-delegate-row{display:flex;align-items:center;min-width:0;height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);transition:color .1s;overflow:hidden}
.tack-delegate-row:hover{color:var(--dsw-alias-label-secondary)}
.tack-delegate-row[data-expandable]{cursor:pointer}
.tack-delegate-dot{flex:none;width:6px;height:6px;margin:0 8px 0 5px;border-radius:999px;background:var(--dsw-alias-label-caption)}
.tack-delegate-dot[data-state=running],.tack-delegate-dot[data-state=preparing],.tack-delegate-dot[data-state=background]{background:var(--dsw-alias-brand-primary,var(--dsw-alias-label-secondary))}
.tack-delegate-dot[data-state=completed]{background:var(--dsw-alias-state-success-primary,#2e9e5b)}
.tack-delegate-dot[data-state=partial],.tack-delegate-dot[data-state=cancelled]{background:var(--dsw-alias-state-warn-label,#c58a00)}
.tack-delegate-dot[data-state=failed],.tack-delegate-dot[data-state=error]{background:var(--dsw-alias-state-error-primary,#d14343)}
.tack-delegate-title{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.tack-delegate-separator{flex:none;width:2px;height:2px;margin:0 8px;border-radius:1px;background:var(--dsw-alias-label-caption)}
.tack-delegate-headline{flex:auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:var(--dsh-content-font-size-secondary,13px)}
.tack-delegate-status{flex:none;margin-left:8px;font-size:11px;color:var(--dsw-alias-label-caption)}
.tack-delegate-status[data-state=failed],.tack-delegate-status[data-state=error]{color:var(--dsw-alias-state-error-primary,#d14343)}
.tack-delegate-body{display:flex;flex-direction:column;gap:8px;margin:4px 0 6px 4px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,8px);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.tack-delegate-detail{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.tack-delegate-label{margin-bottom:2px;font-size:11px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.tack-delegate-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.tack-delegate-list code,.tack-delegate-section code{font:var(--dsw-font-markdown-code-block-small,12px monospace)}
.tack-delegate-file{padding:0;border:0;background:none;color:var(--dsw-alias-label-link,var(--dsw-alias-label-primary));font:var(--dsw-font-markdown-code-block-small,12px monospace);cursor:pointer;text-align:left}
.tack-delegate-file:hover{text-decoration:underline}
.tack-delegate-exit{margin-left:8px;font-size:11px;color:var(--dsw-alias-state-error-primary,#d14343)}
.tack-delegate-exit[data-ok]{color:var(--dsw-alias-state-success-primary,#2e9e5b)}
.tack-delegate-muted,.tack-delegate-footer{color:var(--dsw-alias-label-caption);font-size:12px}
`;
