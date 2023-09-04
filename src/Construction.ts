import { ConstructionSiteStruct } from "ConstructionSite";
import { any, forEach, sortBy } from "lodash";

export function construction(room: Room) {
    console.log('construction');

    //calculateConstructionSites(room);

    if (!room.memory.constructionSites) { room.memory.constructionSites = [] as ConstructionSiteStruct[]; }

    let sites = room.memory.constructionSites as ConstructionSiteStruct[];
    sites = _.filter(sites, (site) => {
        return Game.getObjectById(site.id) != null;
    });

    if (sites.length == 0) {
        let s = room.find(FIND_MY_CONSTRUCTION_SITES);
        if (s.length == 0) { return; }

        room.memory.constructionSites.push({ id: s[0].id, Builders: [] as Id<Creep>[] });
    }

    if (sites.length == 0) { return; }

    forEach(sites, (s) => {
        RemoveDeadCreeps(s);
        AddNewlySpawnedCreeps(s, room);
        SpawnBuilderCreep(s, room);
        BuildConstructionSite(s);
    });

    room.memory.constructionSites = sites;
}

function RemoveDeadCreeps(site: ConstructionSiteStruct) {
    site.Builders = _.filter(site.Builders, (builder) => {
        return Game.getObjectById(builder) != null;
    });
}

function AddNewlySpawnedCreeps(site: ConstructionSiteStruct, room: Room): void {
    if (site.Builders.length == 0) {
        let idleBuilders = room.find(FIND_MY_CREEPS, {
            filter: (creep) => {
                return creep.memory.role == "builder" && !creep.spawning;
            }
        });

        if (idleBuilders.length == 0) { return }

        let ConstructionSite = Game.getObjectById(site.id)!;

        let idleBuilder = sortBy(idleBuilders, (creep) => {
            return creep.pos.getRangeTo(ConstructionSite.pos);
        })[0];

        site.Builders.push(idleBuilder.id);

        idleBuilder.memory.role = "busyBuilder";
    }
}

function SpawnBuilderCreep(
    site: ConstructionSiteStruct,
    room: Room): boolean {
    if (site.Builders.length < 1) {

        let spawns = room.find(FIND_MY_SPAWNS);
        let ConstructionSite = Game.getObjectById(site.id)!;
        spawns = sortBy(spawns, s => s.pos.findPathTo(ConstructionSite.pos).length);
        let spawn = spawns[0];

        return spawn.spawnCreep(
            [WORK, WORK, CARRY, MOVE],
            spawn.name + Game.time,
            { memory: { role: "builder" } }) == OK;
    }

    return false;
}

function BuildConstructionSite(site: ConstructionSiteStruct) {
    let ConstructionSite = Game.getObjectById(site.id)!;
    let builders = site.Builders.map((builder) => {
        return Game.getObjectById(builder)!;
    });

    if (builders.length == 0) { return; }
    let builder = builders[0];

    if (builder.pos.getRangeTo(ConstructionSite.pos) > 3) {
        builder.moveTo(ConstructionSite.pos);
    } else {
        builder.build(ConstructionSite);
    }
}

function calculateConstructionSites(room: Room) {
    let constructionSites = room.find(FIND_MY_CONSTRUCTION_SITES);
    forEach(constructionSites, (site) => {
        if (!any(room.memory.constructionSites, (s) => { return s.id == site.id })) {
            let newSite = {
                id: site.id,
                Builders: [] as Id<Creep>[]
            } as ConstructionSiteStruct;
            room.memory.constructionSites.push(newSite);
        }
    });
}
