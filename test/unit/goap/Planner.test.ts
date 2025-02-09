import '../mock';  // Import the mock before any tests
import { expect } from 'chai';
import { GoapPlanner } from '../../../src/goap/Planner';
import { HarvestEnergyAction } from '../../../src/goap/actions/HarvestEnergyAction';
import { SpawnHarvesterAction } from '../../../src/goap/actions/SpawnHarvesterAction';
import { UpgradeControllerAction } from '../../../src/goap/actions/UpgradeControllerAction';
import { ProfitAction } from '../../../src/goap/actions/ProfitAction';
import { Node } from '../../../src/Node';
import { SpawnUpgraderAction } from '../../../src/goap/actions/SpawnUpgraderAction';

describe('GoapPlanner', () => {
    let planner: GoapPlanner;
    let node: Node;

    beforeEach(() => {
        planner = new GoapPlanner();
        node = new Node({
            assets: [  // No position provided
                { type: 'energy', amount: 1000 },  // Initial energy available
                { type: 'controller', amount: 1 }  // Controller present
            ]
        });
    });

    it('should create a plan to upgrade controller from scratch', () => {
        // Available actions
        const actions = [
            new HarvestEnergyAction(node),
            new SpawnHarvesterAction(node),
            new SpawnUpgraderAction(node),
            new UpgradeControllerAction(node),
            new ProfitAction(node),
        ];

        // Initial state - nothing
        const initialState = {};

        // Goal state - want controller progress
        const goalState = {
            'controllerProgress': 1
        };

        console.log('hi');

        const plan = planner.findPlan(actions, initialState, goalState);

        expect(plan).to.not.be.null;
        expect(plan!.actions).to.have.lengthOf(3);

        // Verify correct sequence
        expect(plan!.actions[0].name).to.equal('SpawnHarvester');
        expect(plan!.actions[1].name).to.equal('HarvestEnergy');
        expect(plan!.actions[2].name).to.equal('UpgradeController');
    });

    it('should find shorter plan when prerequisites exist', () => {
        const actions = [
            new HarvestEnergyAction(node),
            new UpgradeControllerAction(node)
        ];

        // Initial state - already have a harvester
        const initialState = {
            'availableHarvester': 1,
            'availableUpgrader': 1
        };

        const goalState = {
            'controllerProgress': 1
        };

        const plan = planner.findPlan(actions, initialState, goalState);

        expect(plan).to.not.be.null;
        expect(plan!.actions).to.have.lengthOf(2);
        expect(plan!.actions[0].name).to.equal('HarvestEnergy');
        expect(plan!.actions[1].name).to.equal('UpgradeController');
    });

    it('should return null when goal is impossible', () => {
        const actions = [
            new HarvestEnergyAction(node)
        ];

        const initialState = {};
        const goalState = {
            'controllerProgress': 1
        };

        const plan = planner.findPlan(actions, initialState, goalState);
        expect(plan).to.be.null;
    });
});

describe('GoapPlanner - Pull Planning', () => {
    let planner: GoapPlanner;
    let node: Node;

    beforeEach(() => {
        planner = new GoapPlanner();
        node = new Node({
            assets: [  // No position provided
                { type: 'energy', amount: 100 },  // Initial energy available
                { type: 'controller', amount: 1 }  // Controller present
            ]
        });
    });

    it('should create a plan to generate dollars', () => {
        // Register actions
        const actions = [
            new HarvestEnergyAction(node),
            new SpawnHarvesterAction(node),
            new UpgradeControllerAction(node),
            new ProfitAction(node)
        ];

        // Goal state - want dollars
        const goalState = {
            'dollars': 10
        };

        // Initial state - no progress yet
        const initialState = {
            'energy': 100,
            'controllerProgress': 0,
            'availableHarvester': 0,
            'availableUpgrader': 0
        };

        // Set the current state in the node
        node.updateState(initialState);

        // Find the plan
        const plan = planner.findPlan(actions, initialState, goalState);

        expect(plan).to.not.be.null;
        expect(plan!.actions).to.have.lengthOf(5);  // Should include all actions in the chain

        // Verify correct sequence
        expect(plan!.actions[0].name).to.equal('SpawnHarvester');  // First, spawn a harvester
        expect(plan!.actions[1].name).to.equal('HarvestEnergy');   // Then, harvest energy
        expect(plan!.actions[2].name).to.equal('UpgradeController'); // Next, upgrade the controller
        expect(plan!.actions[3].name).to.equal('GenerateProfit');   // Finally, generate profit
    });
});
