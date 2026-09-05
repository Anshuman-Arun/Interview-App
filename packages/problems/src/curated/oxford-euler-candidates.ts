import { oxfordEulerQuadrilateralBalanceEntry, oxfordEulerQuadrilateralBalanceSpec } from "./oxford-euler-quadrilateral-balance.js";
import { oxfordEulerRandomChordMidpointEntry, oxfordEulerRandomChordMidpointSpec } from "./oxford-euler-random-chord-midpoint.js";
import { oxfordEulerCircleSweepEntry, oxfordEulerCircleSweepSpec } from "./oxford-euler-circle-sweep.js";
import { oxfordEulerTriangleMidpointCycleEntry, oxfordEulerTriangleMidpointCycleSpec } from "./oxford-euler-triangle-midpoint-cycle.js";
import { oxfordEulerBoxDiagonalBisectorEntry, oxfordEulerBoxDiagonalBisectorSpec } from "./oxford-euler-box-diagonal-bisector.js";
import { oxfordEulerLocallyBalancedLabelsEntry, oxfordEulerLocallyBalancedLabelsSpec } from "./oxford-euler-locally-balanced-labels.js";
import { oxfordEulerDiagonalBlendTransformEntry, oxfordEulerDiagonalBlendTransformSpec } from "./oxford-euler-diagonal-blend-transform.js";
import { oxfordEulerSelfAveragingSetsEntry, oxfordEulerSelfAveragingSetsSpec } from "./oxford-euler-self-averaging-sets.js";
import { oxfordEulerCornerBalancedTablesEntry, oxfordEulerCornerBalancedTablesSpec } from "./oxford-euler-corner-balanced-tables.js";
import { oxfordEulerTankGaugeModelEntry, oxfordEulerTankGaugeModelSpec } from "./oxford-euler-tank-gauge-model.js";
import { oxfordEulerPeriodicQueueModelEntry, oxfordEulerPeriodicQueueModelSpec } from "./oxford-euler-periodic-queue-model.js";
import { oxfordEulerKioskGridModelEntry, oxfordEulerKioskGridModelSpec } from "./oxford-euler-kiosk-grid-model.js";
import { oxfordEulerCoolingDataModelEntry, oxfordEulerCoolingDataModelSpec } from "./oxford-euler-cooling-data-model.js";
import { oxfordEulerRandomAdjacentConsecutivesEntry, oxfordEulerRandomAdjacentConsecutivesSpec } from "./oxford-euler-random-adjacent-consecutives.js";
import { oxfordEulerStopOnChangeEntry, oxfordEulerStopOnChangeSpec } from "./oxford-euler-stop-on-change.js";
import { oxfordEulerRandomSubsetBlocksEntry, oxfordEulerRandomSubsetBlocksSpec } from "./oxford-euler-random-subset-blocks.js";
import { oxfordEulerRandomHalvingIntervalEntry, oxfordEulerRandomHalvingIntervalSpec } from "./oxford-euler-random-halving-interval.js";

export const eulerOxfordCandidateSpecs = Object.freeze([
  oxfordEulerQuadrilateralBalanceSpec,
  oxfordEulerRandomChordMidpointSpec,
  oxfordEulerCircleSweepSpec,
  oxfordEulerTriangleMidpointCycleSpec,
  oxfordEulerBoxDiagonalBisectorSpec,
  oxfordEulerLocallyBalancedLabelsSpec,
  oxfordEulerDiagonalBlendTransformSpec,
  oxfordEulerSelfAveragingSetsSpec,
  oxfordEulerCornerBalancedTablesSpec,
  oxfordEulerTankGaugeModelSpec,
  oxfordEulerPeriodicQueueModelSpec,
  oxfordEulerKioskGridModelSpec,
  oxfordEulerCoolingDataModelSpec,
  oxfordEulerRandomAdjacentConsecutivesSpec,
  oxfordEulerStopOnChangeSpec,
  oxfordEulerRandomSubsetBlocksSpec,
  oxfordEulerRandomHalvingIntervalSpec
] as const);

export const eulerOxfordCandidateEntries = Object.freeze([
  oxfordEulerQuadrilateralBalanceEntry,
  oxfordEulerRandomChordMidpointEntry,
  oxfordEulerCircleSweepEntry,
  oxfordEulerTriangleMidpointCycleEntry,
  oxfordEulerBoxDiagonalBisectorEntry,
  oxfordEulerLocallyBalancedLabelsEntry,
  oxfordEulerDiagonalBlendTransformEntry,
  oxfordEulerSelfAveragingSetsEntry,
  oxfordEulerCornerBalancedTablesEntry,
  oxfordEulerTankGaugeModelEntry,
  oxfordEulerPeriodicQueueModelEntry,
  oxfordEulerKioskGridModelEntry,
  oxfordEulerCoolingDataModelEntry,
  oxfordEulerRandomAdjacentConsecutivesEntry,
  oxfordEulerStopOnChangeEntry,
  oxfordEulerRandomSubsetBlocksEntry,
  oxfordEulerRandomHalvingIntervalEntry
] as const);
