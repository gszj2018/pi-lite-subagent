/**
 * Truncation of model-visible subagent output.
 *
 * Over-limit output is written in full to a temp file so the LLM can read it
 * later; the temp file is intentionally kept (cleaned up by the OS).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

/**
 * Cap one subagent output at the host defaults (lines/bytes, whichever hits
 * first). Unchanged output is returned as-is. When truncated, the full output is
 * saved to `<mkdtemp>/output.txt` and the hint carries line/byte stats plus the
 * file path so the LLM can read the rest.
 */
export async function truncateSubagentOutput(output: string): Promise<string> {
  const truncated = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!truncated.truncated) return output;

  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-lite-subagent-output-"));
  const filePath = path.join(dir, "output.txt");
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, output, { encoding: "utf-8" });
  });

  return (
    `${truncated.content}\n\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines ` +
    `(${truncated.outputBytes} of ${truncated.totalBytes} bytes). Full output saved to: ${filePath}]`
  );
}
