/** Shared utilities that depend on Pi host functionality. */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

/** Labels are terminal text, never Markdown or executable terminal sequences. */
export function singleLineLabel(text: string): string {
  return stripTerminalSequences(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim();
}
