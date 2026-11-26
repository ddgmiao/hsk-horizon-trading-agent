import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AgentState>;
    return {
      lastTradeAtMs: Number.isFinite(parsed.lastTradeAtMs) ? parsed.lastTradeAtMs! : null,
      utcDay: parsed.utcDay || day,
      dailyStartValueQuote: parsed.utcDay === day && parsed.dailyStartValueQuote ? parsed.dailyStartValueQuote : null,
      bootstrapComplete: parsed.bootstrapComplete === true,
    };
  } catch {
    return {lastTradeAtMs: null, utcDay: day, dailyStartValueQuote: null, bootstrapComplete: false};
  }
}

export async function saveState(path: string, state: AgentState): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), {recursive: true});
  await appendFile(path, `${JSON.stringify(value, bigintReplacer)}\n`, {mode: 0o600});
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
