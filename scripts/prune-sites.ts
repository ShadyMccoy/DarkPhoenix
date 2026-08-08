/**
 * Break-glass: inspect and prune STRAY construction sites.
 *
 * Why this exists (audit t72850264): the colony's entire construction
 * allocation - 10 e/t at sink priority 70, ABOVE the controller, plus 0.135
 * p/t of spawn budget - was held by ONE site in W41N25: 4,582 of 5,000 done,
 * 418 remaining, in a room we do not mine, that is not in intel at all, 114
 * tiles from spawn. It had delivered 0.00 e/t of build for the whole window and
 * its corp stood at creeps 0.
 *
 * WHAT THE INSPECTION FOUND, and why nothing was pruned. The list mode is what
 * identified the site: a CONTAINER at (35,40) in W41N25 - and W41N25 turns out
 * to be a two-source remote we last harvested ~12,000 ticks earlier, unowned,
 * unreserved, safe, well inside scout range. So the site is not debris: it is a
 * real 92%-paid asset for a room the PLAN stopped funding, and removing it
 * would burn 4,582e of sunk work to fix an accounting problem.
 *
 * The fix went into the plan instead (flowAdapter: construction sinks are
 * scoped to the rooms the colony works). The site stands, costs nothing while
 * unfunded, and is admitted again on the same solve if W41N25 returns.
 *
 * The lesson worth keeping: LOOK before pruning. The colony-level ledger said
 * "one site, 418 remaining, room we don't work" and read like debris; the
 * per-site probe said "container, two-source remote, harvested this fiscal
 * year" and read like an investment. Same site, opposite verdicts.
 *
 * LISTS BY DEFAULT. `--remove <room>` is the only destructive path and it names
 * exactly one room. Progress on a removed site is NOT refunded by the engine -
 * but that energy is already spent either way, so the only live question is
 * whether the REMAINING work is worth a builder's trip.
 *
 * Usage:
 *   SCREEPS_TOKEN=... npx ts-node -P tsconfig.test.json scripts/prune-sites.ts
 *   SCREEPS_TOKEN=... npx ts-node -P tsconfig.test.json scripts/prune-sites.ts --remove W41N25
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
const SHARD = process.env.SCREEPS_SHARD ?? "shard1";

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

const LIST = `(function(){var out=[];for(var id in Game.constructionSites){var s=Game.constructionSites[id];out.push(s.pos.roomName+' '+s.structureType+' '+s.progress+'/'+s.progressTotal+' @'+s.pos.x+','+s.pos.y);}console.log('[SITES] '+(out.length?out.join(' | '):'none'));return out.length;})()`;

const removeIn = (room: string): string =>
  `(function(){var n=0,d=[];for(var id in Game.constructionSites){var s=Game.constructionSites[id];if(s.pos.roomName!=='${room}')continue;d.push(s.structureType+' '+s.progress+'/'+s.progressTotal+' @'+s.pos.x+','+s.pos.y);if(s.remove()===OK)n++;}console.log('[SITES] removed '+n+' in ${room}: '+(d.join(' | ')||'none'));return n;})()`;

async function main(): Promise<void> {
  if (!process.env.SCREEPS_TOKEN) {
    console.error("SCREEPS_TOKEN required");
    process.exit(1);
  }
  const i = process.argv.indexOf("--remove");
  const room = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && !/^[EW]\d+[NS]\d+$/.test(room ?? "")) {
    console.error("--remove needs a room name, e.g. --remove W41N25");
    process.exit(1);
  }
  const expression = room ? removeIn(room) : LIST;
  console.log(room ? `REMOVING every site in ${room} on ${SHARD}` : `listing sites on ${SHARD}`);
  await api("/user/console", { method: "POST", body: JSON.stringify({ expression, shard: SHARD }) });
  console.log("console POST accepted - the expression runs next tick.");
  console.log("Read the [SITES] line from the in-game console, or recapture and read core.siteLedger.");
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
