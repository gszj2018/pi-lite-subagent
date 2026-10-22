/** Read-only, bounded metadata discovery for directly related persisted child sessions. */

import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { ACTIVE_AGENT_ENTRY_TYPE } from "./active-agent.ts";
import { isInsideDirectory, isPathSafeSessionId, type SessionIdentity, subagentSessionDir } from "./session-paths.ts";

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
  degraded: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function decodeHeader(value: unknown): SessionHeader | undefined {
  if (!record(value) || value.type !== "session" || typeof value.id !== "string" ||
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
  if (!record(value)) return false;
  if (value.type === "session") return decodeHeader(value) !== undefined;
  return typeof value.type === "string" && typeof value.id === "string" && value.id.length > 0 &&
    (value.parentId === null || typeof value.parentId === "string") && validTime(value.timestamp);
}

async function openSessionFile(file: string, directory?: string) {
  if (!path.isAbsolute(file) || (directory && path.extname(file) !== ".jsonl")) {
    throw new Error("Invalid session file path.");
  }
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Session path is not an ordinary file.");
  const canonical = await fs.realpath(file);
  if (directory && path.relative(path.dirname(canonical), directory) !== "") {
    throw new Error("Session file is outside the related-session directory.");
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error("Session file changed while opening it.");
    }
    return { handle, stat, canonical };
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

/** Validate again immediately before navigation; large files need only a bounded header read. */
export async function readSessionIdentity(file: string, directory?: string): Promise<SessionIdentity> {
  const { handle } = await openSessionFile(file, directory);
  try {
    const header = await readHeader(handle);
    if (!header) throw new Error("Session file has no valid session header.");
    return { file: path.normalize(file), id: header.id };
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

async function inspectFile(file: string, directory: string): Promise<SubagentSession> {
  const { handle, stat, canonical } = await openSessionFile(file, directory);
  try {
    const header = await readHeader(handle);
    let agent = "unknown";
    let degraded = true;
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
            const marker = entries.find((entry) => record(entry) && entry.type === "custom" &&
              entry.customType === ACTIVE_AGENT_ENTRY_TYPE && record(entry.data) &&
              typeof entry.data.name === "string" && entry.data.name.trim() !== "");
            if (record(marker) && record(marker.data)) {
              agent = marker.data.name as string;
              degraded = false;
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
    return { file: canonical, fileName, agent, created, header, degraded };
  } finally {
    await handle.close();
  }
}

export interface SessionScan {
  directory: string;
  sessions: SubagentSession[];
  skipped: number;
  degraded: number;
}

export async function scanSubagentSessions(sessionDir: string, parent: SessionIdentity): Promise<SessionScan> {
  const candidate = subagentSessionDir(sessionDir, parent.id);
  if (!candidate || !path.isAbsolute(sessionDir)) throw new Error("This session has no persistent session directory.");
  const persisted = await readSessionIdentity(parent.file);
  if (persisted.id !== parent.id) throw new Error("The current session file has a different session id.");
  const root = await fs.realpath(sessionDir);
  const directory = await fs.realpath(candidate);
  if (!isInsideDirectory(root, directory)) throw new Error("Related-session directory escapes the session root.");
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && path.extname(entry.name) === ".jsonl");
  let skipped = entries.filter((entry) => path.extname(entry.name) === ".jsonl" && !entry.isFile()).length;
  let cursor = 0;
  const sessions: SubagentSession[] = [];
  await Promise.all(Array.from({ length: Math.min(SESSION_METADATA_CONCURRENCY, files.length) }, async () => {
    while (cursor < files.length) {
      const entry = files[cursor++];
      try {
        sessions.push(await inspectFile(path.join(directory, entry.name), directory));
      } catch {
        skipped++;
      }
    }
  }));
  sessions.sort((a, b) => b.created - a.created || (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  return { directory, sessions, skipped, degraded: sessions.filter((session) => session.degraded).length };
}
