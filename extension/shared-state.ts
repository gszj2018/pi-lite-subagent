/** Shared in-process state retained across extension reloads and session-runtime replacement. */

import type { NavigationState } from "./types.ts";

export interface SharedState {
  /** Navigation state shared by every extension instance in this process. */
  navigationStateV1: NavigationState;
}

/** Return the stable navigation object; lifecycle handlers update its fields in place. */
export function getNavigationState(): NavigationState {
  return getSharedState().navigationStateV1;
}

declare global {
  // noinspection ES6ConvertVarToLetConst
  var __github_gszj2018_piLiteSubagent_sharedState: SharedState | undefined;
}

function initSharedState(): SharedState {
  // all shared states are initialized here
  const sharedState: SharedState = {
    navigationStateV1: { frames: [] },
  }
  return globalThis.__github_gszj2018_piLiteSubagent_sharedState = sharedState;
}

function getSharedState(): SharedState {
  return globalThis.__github_gszj2018_piLiteSubagent_sharedState ?? initSharedState();
}

