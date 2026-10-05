import { IsScalarRecord } from '../../../common/validators/record.validators.js';

export class SetFaultsDto {
  /**
   * Fault switches for the bundled LegacyCore mock, e.g.
   * `{ "maintenance_notice": true, "transient_errors": 1 }`. An empty object clears every fault.
   */
  @IsScalarRecord(20)
  faults!: Record<string, boolean | number | string>;
}
