/** Read-only, bounded metadata discovery for directly related persisted child sessions. */

import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { ACTIVE_AGENT_ENTRY_TYPE } from "./active-agent.ts";
import { isPathSafeSessionId, subagentSessionDir } from "./session-paths.ts";
import { isRecord, mapWithConcurrencyLimit } from "./utils.ts";

export const MAX_SESSION_METADATA_BYTES = 8 * 1024 * 1024;
export const SESSION_METADATA_CONCURRENCY = 4;
const MAX_HEADER_BYTES = 64 * 1024;

export interface SessionHeader {
  id: string;
  timestamp: string;
  cwd: string;
}

export interface SubagentSession {
  file: string;
  fileName: string;
  agent: string;
  created: number;
  header?: SessionHeader;
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function decodeHeader(value: unknown): SessionHeader | undefined {
  if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string" ||
    !isPathSafeSessionId(value.id) || !validTime(value.timestamp) || typeof value.cwd !== "string" ||
    !path.isAbsolute(value.cwd) || (value.version !== undefined &&
      !(Number.isInteger(value.version) && Number(value.version) >= 1))) return undefined;
  return { id: value.id, timestamp: value.timestamp, cwd: value.cwd };
}

function headerFromText(text: string): SessionHeader | undefined {
  try {
    return decodeHeader(JSON.parse(text.trimStart().split("\n", 1)[0]));
  } catch {
    return undefined;
  }
}

function validEntry(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  if (value.type === "session") return decodeHeader(value) !== undefined;
  return typeof value.type === "string" && typeof value.id === "string" && value.id.length > 0 &&
    (value.parentId === null || typeof value.parentId === "string") && validTime(value.timestamp);
}

function validateOpenedSessionFile(before: Stats, stat: Stats): void {
  if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
    throw new Error("Session file changed while opening it.");
  }
}

async function openSessionFile(file: string) {
  if (!path.isAbsolute(file)) {
    throw new Error("Invalid session file path.");
  }
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Session path is not an ordinary file.");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    validateOpenedSessionFile(before, stat);
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readHeader(handle: fs.FileHandle): Promise<SessionHeader | undefined> {
  const buffer = Buffer.alloc(MAX_HEADER_BYTES);
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
  const text = buffer.subarray(0, bytesRead).toString("utf8");
  if (bytesRead === MAX_HEADER_BYTES && !text.includes("\n")) return undefined;
  return headerFromText(text);
}

/** Validate a bounded header before navigation, optionally matching a previously read session ID. */
export async function validateSessionFile(file: string, expectedHeader?: SessionHeader): Promise<void> {
  const { handle } = await openSessionFile(file);
  try {
    const header = await readHeader(handle);
    if (!header) throw new Error("Session file has no valid session header.");
    if (expectedHeader && header.id !== expectedHeader.id) {
      throw new Error("Session file no longer has the expected session id.");
    }
  } finally {
    await handle.close();
  }
}

function fileTime(fileName: string): number | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(fileName);
  if (!match) return undefined;
  const value = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(value) ? value : undefined;
}

async function inspectFile(file: string): Promise<SubagentSession> {
  const { handle, stat } = await openSessionFile(file);
  try {
    const header = await readHeader(handle);
    let agent = "unknown";
    if (header && stat.size <= MAX_SESSION_METADATA_BYTES) {
      try {
        // The positioned header read does not advance the descriptor's readFile cursor.
        const buffer = await handle.readFile();
        const after = await handle.stat();
        if (buffer.length <= MAX_SESSION_METADATA_BYTES && after.size === stat.size && buffer.length === stat.size) {
          const text = buffer.toString("utf8");
          const entries: unknown[] = parseSessionEntries(text);
          const count = text.split("\n").filter((line) => line.trim() !== "").length;
          const complete = count === entries.length && entries.every(validEntry);
          if (complete) {
            const marker = entries.find((entry) => isRecord(entry) && entry.type === "custom" &&
              entry.customType === ACTIVE_AGENT_ENTRY_TYPE && isRecord(entry.data) &&
              typeof entry.data.name === "string" && entry.data.name.trim() !== "");
            if (isRecord(marker) && isRecord(marker.data)) {
              agent = marker.data.name as string;
            }
          }
        }
      } catch {
        // Header/time fallback remains selectable even when full metadata is unavailable.
      }
    }
    const fileName = path.basename(file);
    const created = header ? Date.parse(header.timestamp) :
      fileTime(fileName) ?? (stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
    return { file, fileName, agent, created, header };
  } finally {
    await handle.close();
  }
}

export interface SessionScan {
  directory: string;
  sessions: SubagentSession[];
}

export async function scanSubagentSessions(
  sessionDir: string, sessionId: string, parentFile: string,
): Promise<SessionScan> {
  const directory = subagentSessionDir(sessionDir, sessionId);
  if (!directory || !path.isAbsolute(sessionDir)) throw new Error("This session has no persistent session directory.");
  await validateSessionFile(parentFile);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && path.extname(entry.name) === ".jsonl");
  const inspected = await mapWithConcurrencyLimit(files, SESSION_METADATA_CONCURRENCY, async (entry) => {
    try {
      return await inspectFile(path.join(directory, entry.name));
    } catch {
      // Ignore individual files that disappear or cannot be inspected.
      return undefined;
    }
  });
  const sessions = inspected.filter((session): session is SubagentSession => session !== undefined);
  sessions.sort((a, b) => b.created - a.created || (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return { directory, sessions };
}
