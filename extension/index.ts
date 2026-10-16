import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTool } from "./subagent-tool.ts";

export default function setup(pi: ExtensionAPI) {
  registerSubagentTool(pi);
}
