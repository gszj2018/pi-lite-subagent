/** Shared in-process state retained across extension reloads and session-runtime replacement. */

import type { NavigationState } from "./types.ts";

export interface SharedState {
  /** Navigation state shared by every extension instance in this process. */
  navigationStateV1: NavigationState;
}

function getOrCreateSharedState(): SharedState {
  const sharedState = globalThis.__github_gszj2018_piLiteSubagent_sharedState;
  if (!sharedState) {
    return globalThis.__github_gszj2018_piLiteSubagent_sharedState = {
      navigationStateV1: { frames: [] },
    };
  }

  return sharedState;
}

/** Return the stable navigation object; lifecycle handlers update its fields in place. */
export function getNavigationState(): NavigationState {
  return getOrCreateSharedState().navigationStateV1;
}

declare global {
  // noinspection ES6ConvertVarToLetConst
  var __github_gszj2018_piLiteSubagent_sharedState: SharedState | undefined;
}
