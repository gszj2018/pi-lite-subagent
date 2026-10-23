/** Defensive result parsing without UI or provider-specific message dependencies. */

import { Value } from "typebox/value";
import { SubagentDetailsSchema } from "./result-details.ts";
import type { DisplayItem, SubagentDetails } from "./types.ts";
import { asRecord } from "./utils.ts";

/** Validate all details at once; invalid data is unavailable rather than partially repaired. */
export function parseSubagentDetails(value: unknown): SubagentDetails | undefined {
  return Value.Check(SubagentDetailsSchema, value) ? value : undefined;
}

/** Extract call-level text without interpreting provider metadata or tool-result details. */
export function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((value) => {
    const part = asRecord(value);
    return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
  }).join("\n");
}

/** Preserve valid assistant items in order without requiring provider metadata or deduplicating text. */
export function getDisplayItems(messages: readonly unknown[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const value of messages) {
    const msg = asRecord(value);
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const value of msg.content) {
      const part = asRecord(value);
      if (part?.type === "text" && typeof part.text === "string") items.push({ type: "text", text: part.text });
      else if (part?.type === "toolCall" && typeof part.name === "string") {
        items.push({ type: "toolCall", name: part.name, args: { ...asRecord(part.arguments) } });
      }
    }
  }
  return items;
}
