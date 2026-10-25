import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const defaultTokensPath = path.join(homedir(), ".paseo", "agents-roles", "forge-tokens.json");

/**
 * Forge tokens, one per git source. Write-only from the UI's point of view: nothing here is ever
 * returned to the client, which only learns whether a token is set. Stored mode 0600.
 */
export class TokenStore {
  constructor(private readonly file: string = defaultTokensPath) {}

  private read(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  private write(tokens: Record<string, string>) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(tokens), { mode: 0o600 });
  }

  has(sourceId: string): boolean {
    return Boolean(this.read()[sourceId]);
  }

  get(sourceId: string): string | null {
    return this.read()[sourceId] ?? null;
  }

  set(sourceId: string, token: string) {
    if (/[\r\n]/.test(token)) throw new Error("Tokens cannot contain newlines");
    this.write({ ...this.read(), [sourceId]: token });
  }

  clear(sourceId: string) {
    const { [sourceId]: _removed, ...rest } = this.read();
    this.write(rest);
  }
}

/** Remove a secret from an error message before it reaches the UI or logs. */
export function scrub(message: string, secret: string | null): string {
  return secret ? message.split(secret).join("***") : message;
}
