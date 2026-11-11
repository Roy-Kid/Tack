import React from "react";

/** The embedded occurrence shows no transcript: the conversation itself is one click away. */
function NoTranscript() { return null; }

const CONTENT = { variant: "embedded", phase: "active", hero: false };
const SLOTS = { slots: { views: NoTranscript } };

/**
 * DSH's own conversation composer for the selected conversation, so a person
 * can keep talking to the agent without leaving the workbench. It is the
 * shared `conversation.content` Factory, embedded the way DSH's Sidebar chat
 * embeds it: same draft, queue, attachments and question takeovers.
 */
export default function Composer({ renderFactorySlot }) {
  if (typeof renderFactorySlot !== "function") return null;
  return <div className="tw-composer" role="region" aria-label="Conversation">{renderFactorySlot("conversation.content", CONTENT, SLOTS)}</div>;
}
