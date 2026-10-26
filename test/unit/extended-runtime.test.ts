import { expect } from 'chai';

import { countExtendedRuntimeFlows } from '../../src/services/execution-plan.service.js';

/**
 * `dcd cloud` notes how many flows opted into the extended runtime, because
 * the API bills each of them at 2x (dcd#1624). It must count exactly the
 * values the API treats as opted in: YAML `true` and the string 'true'.
 */
describe('countExtendedRuntimeFlows', () => {
  it('counts flows whose override is true or "true"', () => {
    expect(
      countExtendedRuntimeFlows({
        'a.yaml': { EXTENDED_RUNTIME: true },
        'b.yaml': { EXTENDED_RUNTIME: 'true' },
        'c.yaml': { DEVICE_LOCALE: 'de_DE' },
        'd.yaml': {},
      }),
    ).to.equal(2);
  });

  it('ignores values the API would not treat as opted in', () => {
    expect(
      countExtendedRuntimeFlows({
        'a.yaml': { EXTENDED_RUNTIME: false },
        'b.yaml': { EXTENDED_RUNTIME: 'false' },
        'c.yaml': { EXTENDED_RUNTIME: 'TRUE' },
        'd.yaml': { EXTENDED_RUNTIME: 1 },
      }),
    ).to.equal(0);
  });
});
