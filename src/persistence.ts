import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AgentState {
  lastTradeAtMs: number | null;
  utcDay: string;
  dailyStartValueQuote: string | null;
  bootstrapComplete: boolean;
}

export function utcDay(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export async function loadState(path: string, nowMs = Date.now()): Promise<AgentState> {
  const day = utcDay(nowMs);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {lastTradeAtMs: null, utcDay: day, dailyStartValueQuote: null, bootstrapComplete: false};
    }
    throw error;
  }
  let parsed: Partial<AgentState>;
  try {
    parsed = JSON.parse(text) as Partial<AgentState>;
  } catch {
    throw new Error(
      `Agent state file ${path} is not valid JSON; refusing to trade with silently reset risk baselines. Repair the file, or remove it to start fresh.`,
    );
  }
  return {
    lastTradeAtMs: Number.isFinite(parsed.lastTradeAtMs) ? parsed.lastTradeAtMs! : null,
    utcDay: parsed.utcDay || day,
    dailyStartValueQuote: parsed.utcDay === day && parsed.dailyStartValueQuote ? parsed.dailyStartValueQuote : null,
    bootstrapComplete: parsed.bootstrapComplete === true,
  };
}

export async function saveState(path: string, state: AgentState): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
  await rename(tmpPath, path);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await appendFile(path, `${JSON.stringify(value, bigintReplacer)}\n`, {mode: 0o600});
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
