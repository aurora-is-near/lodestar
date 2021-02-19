/**
 * @module chain/stateTransition/epoch
 */

import {phase0} from "@chainsafe/lodestar-types";
import {IBeaconConfig} from "@chainsafe/lodestar-config";

import {processRewardsAndPenalties} from "./balanceUpdates";
import {processFinalUpdates} from "./finalUpdates";
import {processJustificationAndFinalization} from "./justification";
import {processRegistryUpdates} from "./registryUpdates";
import {processSlashings} from "./slashings";
import {processForkChanged} from "./fork";

export * from "./balanceUpdates";
export * from "./finalUpdates";
export * from "./justification";
export * from "./registryUpdates";
export * from "./slashings";

export function processEpoch(config: IBeaconConfig, state: phase0.BeaconState): phase0.BeaconState {
  // Justification
  processJustificationAndFinalization(config, state);

  // Rewards and penalties
  processRewardsAndPenalties(config, state);

  // Validator Registry
  processRegistryUpdates(config, state);

  // TODO Later Phase
  // processRevealDeadlines

  // TODO Later Phase
  // processChallengeDeadlines

  // Slashings
  processSlashings(config, state);

  // Final Updates
  processFinalUpdates(config, state);

  // check and process planned hard fork
  processForkChanged(config, state);

  // TODO Later Phase
  // afterProcessFinalUpdates

  return state;
}