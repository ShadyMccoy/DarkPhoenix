/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * @fileoverview runWithCop - stand up a scenario, tick it, and run the
 * {@link CorpCop} every tick. The one entry point both the integration tests and
 * the `corp-cop` CLI use, so "watch for orphans while this runs" is one call.
 *
 * @module test/integration/diagnostics/runWithCop
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../scenario/Scenario";
import * as library from "../scenario/library";
import { CorpCop, Invariant, snapshotFromMemory } from "./CorpCop";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

export interface CopRunOptions {
  /** Scenario factory name in scenario/library (e.g. "twoSourceRcl3"). */
  scenario?: string;
  ticks?: number;
  port?: number;
  /** Override the rule set (defaults to CorpCop's DEFAULT_INVARIANTS). */
  invariants?: Invariant[];
  /** Sample the cop every N ticks (1 = every tick). Cheap, so default 1. */
  sampleEvery?: number;
}

export interface CopRunResult {
  cop: CorpCop;
  ticks: number;
  scenario: string;
}

/**
 * Run a scenario for `ticks` ticks, feeding each tick's exported memory to a
 * CorpCop. Returns the cop so the caller can assert on `.sustained()` / print
 * `.report()`. Tears the server down before returning.
 */
export async function runWithCop(opts: CopRunOptions = {}): Promise<CopRunResult> {
  const scenarioName = opts.scenario ?? "twoSourceRcl3";
  const ticks = opts.ticks ?? 300;
  const sampleEvery = Math.max(1, opts.sampleEvery ?? 1);
  const port = opts.port ?? 27000 + Math.floor(Math.random() * 1000);

  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();

  const mainJs = readFileSync("dist/main.js").toString();
  const factory = (library as any)[scenarioName];
  if (typeof factory !== "function") throw new Error(`unknown scenario "${scenarioName}"`);
  const scenario = factory();
  const { bot } = await loadScenario(server, scenario, mainJs);
  await server.start();

  const cop = new CorpCop(opts.invariants);

  for (let t = 0; t < ticks; t++) {
    await server.tick();
    if (t % sampleEvery !== 0 && t !== ticks - 1) continue;
    let mem: any = {};
    try {
      mem = JSON.parse((await bot.memory) || "{}");
    } catch {
      mem = {};
    }
    cop.observe(snapshotFromMemory(t, mem));
  }

  await server.stop?.();
  return { cop, ticks, scenario: scenarioName };
}
