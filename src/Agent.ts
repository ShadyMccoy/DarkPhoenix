import { Node } from "./Node";
import { NodeAgentRoutine } from "./routines/NodeAgentRoutine";

export class Agent {
  private routines: NodeAgentRoutine[] = [];

  constructor(private node: Node) {}

  run(): void {
    for (const routine of this.routines) {
      try {
        routine.process();
      } catch (error) {
        console.log(`Error running routine:`, error);
      }
    }
  }

  addRoutine(routine: NodeAgentRoutine): void {
    this.routines.push(routine);
    routine.initialize();
  }

  removeRoutine(routine: NodeAgentRoutine): void {
    this.routines = this.routines.filter(r => r !== routine);
  }
}
