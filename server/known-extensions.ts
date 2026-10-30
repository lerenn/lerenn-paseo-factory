import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HostTool } from "./tools";
import { UsageError } from "./tools";

/** How long the Factory keeps offering the tools of an extension that stopped registering. */
export const KNOWN_TTL_MS = 7 * 24 * 3600 * 1000;

export interface KnownTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  trustedWrite?: boolean;
}

interface Entry {
  at: number;
  tools: KnownTool[];
}

/**
 * The tools of each remote extension as it last registered, kept on disk. An agent's MCP client lists the
 * `factory` tools once, when it connects (also when it reconnects after a Factory restart), and is never told
 * the list changed. Remote extensions register again within a minute of a restart, so without this list an
 * agent that connects in that gap never sees their tools for the rest of its session.
 */
export class KnownExtensions {
  private entries: Record<string, Entry> = {};
  /** Stage kinds any extension (in-process or remote) registered, with which one and when: a restart is not a missing kind. */
  private kinds: Record<string, { id: string; at: number }> = {};

  constructor(
    private readonly file: string | null,
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")).extensions ?? {};
      for (const [id, e] of Object.entries(raw as Record<string, Entry>)) {
        if (typeof e?.at === "number" && Array.isArray(e.tools) && this.now() - e.at < KNOWN_TTL_MS) this.entries[id] = e;
      }
    } catch {
      this.entries = {};
    }
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")).stageKinds ?? {};
      for (const [kind, k] of Object.entries(raw as Record<string, { id: string; at: number }>)) {
        if (typeof k?.at === "number" && typeof k.id === "string" && this.now() - k.at < KNOWN_TTL_MS) this.kinds[kind] = k;
      }
    } catch {
      this.kinds = {};
    }
  }

  /** The extension that last registered this stage kind (within the TTL), or null when none ever did. */
  stageKind(kind: string): string | null {
    const k = this.kinds[kind];
    return k && this.now() - k.at < KNOWN_TTL_MS ? k.id : null;
  }

  rememberStageKinds(id: string, kinds: string[]): void {
    if (!kinds.length) return;
    const at = this.now();
    for (const kind of kinds) this.kinds[kind] = { id, at };
    this.save();
  }

  ids(): string[] {
    return Object.keys(this.entries);
  }

  tools(id: string): KnownTool[] {
    return this.entries[id]?.tools ?? [];
  }

  remember(id: string, tools: KnownTool[]): void {
    this.entries[id] = { at: this.now(), tools };
    this.save();
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ extensions: this.entries, stageKinds: this.kinds }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

/** Stand-ins for a known extension's tools while it is not registered: listed, and a call says to retry. */
export function placeholderTools(id: string, tools: KnownTool[]): Omit<HostTool, "owner">[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input: z.looseObject({}) as never,
    jsonSchema: t.inputSchema,
    readOnly: t.readOnly,
    trustedWrite: t.trustedWrite,
    extension: true,
    run() {
      throw new UsageError(`${t.name}: the ${id} extension is not connected to the Factory right now (it registers again within a minute of a restart). Try again in a minute.`);
    },
  }));
}
