/**
 * One-off live-console rescue (spec 26 incident 2026-07-23): the colony wedged
 * in a scheduler deadlock (a mustFund miner walls the drained spawn network; the
 * tender that would refill it only pierces the wall at staffing===0, so with 1
 * tender alive the network can't reach the miner's cost -> fleet death spiral).
 * This injects extra tenders (corpId moving-W43N23-tender, which the live
 * ExtensionTenderCorp adopts and counts as staffing) to refill the network from
 * the 61k storage and break the wall. Low-risk: extra tenders self-correct once
 * staffing >= target. Runs the SAME proxy/api dance as deploy-code.ts.
 *
 * Usage: SCREEPS_TOKEN=... npx ts-node -P tsconfig.test.json scripts/rescue-console.ts
 */
import { spawnSync } from "child_process";

declare const fetch: (url: string, init?: any) => Promise<any>;

function ensureFetchUsesProxy(): void {
  const proxied = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxied || process.env.NODE_USE_ENV_PROXY === "1") return;
  const result = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, NODE_USE_ENV_PROXY: "1" }
  });
  process.exit(result.status ?? 1);
}
ensureFetchUsesProxy();

const API = process.env.SCREEPS_API_URL ?? "https://screeps.com/api";

async function api(path: string, init: any = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "X-Token": process.env.SCREEPS_TOKEN ?? "", "Content-Type": "application/json", ...init.headers }
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${res.status}`);
  const body = await res.json();
  if (body.ok !== 1) throw new Error(`${path} -> ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// Spawn the biggest tender the current spawn-network energy affords (2..8 CARRY+
// MOVE pairs), memory shaped so ExtensionTenderCorp adopts + runs it. Logs the
// spawnCreep return code and energyAvailable to the in-game console.
const EXPR = `(function(){var s=Game.spawns['Spawn1'];if(!s)return 'no-spawn';var e=s.room.energyAvailable;var c=Math.max(2,Math.min(8,Math.floor(e/100/2)));var b=[];for(var i=0;i<c;i++)b.push(CARRY);for(var i=0;i<c;i++)b.push(MOVE);var r=s.spawnCreep(b,'rescueT'+Game.time,{memory:{workType:'tank',corpId:'moving-W43N23-tender'}});console.log('[RESCUE] spawnCreep='+r+' e='+e+' pairs='+c+' spawning='+(s.spawning?'yes':'no'));return r;})()`;

async function main(): Promise<void> {
  if (!process.env.SCREEPS_TOKEN) {
    console.error("SCREEPS_TOKEN required");
    process.exit(1);
  }
  const r = await api("/user/console", { method: "POST", body: JSON.stringify({ expression: EXPR, shard: "shard1" }) });
  console.log("console POST accepted:", JSON.stringify(r).slice(0, 120));
  console.log("(the expression runs next tick; verify with a telemetry capture)");
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
