import { forEach } from "lodash";
import { bootstrap } from "bootstrap";
import { energyMining } from "EnergyMining";
import { energyCarrying } from "EnergyCarrying";

export function RoomProgram(room: Room) {
  forEach(getRoomRoutines(room), (routine) => {
    switch (routine) {
      case "bootstrap":
        bootstrap(room);
        break;
      case "energyMining":
        energyMining(room);
        break;
      case "energyCarrying":
        energyCarrying(room);
        break;
      default:
        console.log(`Routine '${routine}' not found.`);
    }
  });
}

function getRoomRoutines(room : Room) : string[]
{
  if (room.controller?.level == 1 ) {
    return ["energyCarrying", "energyMining", "bootstrap"];
  } else {
    return ["energyMining"];
  }
}

