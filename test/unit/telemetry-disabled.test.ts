import { expect } from 'chai';

import { telemetryDisabled } from '../../src/services/telemetry.service.js';

/** The two env vars that turn telemetry off, and the values that don't. */
describe('telemetryDisabled', () => {
  it('is off (telemetry on) with neither var set', () => {
    expect(telemetryDisabled({})).to.equal(false);
  });

  for (const name of ['DCD_TELEMETRY_DISABLED', 'DO_NOT_TRACK']) {
    for (const value of ['1', 'true', 'TRUE', 'yes', ' 1 ']) {
      it(`turns telemetry off for ${name}=${JSON.stringify(value)}`, () => {
        expect(telemetryDisabled({ [name]: value })).to.equal(true);
      });
    }

    for (const value of ['', '0', 'false', 'False', ' 0 ']) {
      it(`leaves telemetry on for ${name}=${JSON.stringify(value)}`, () => {
        expect(telemetryDisabled({ [name]: value })).to.equal(false);
      });
    }
  }

  it('turns telemetry off when either var says so', () => {
    expect(telemetryDisabled({ DCD_TELEMETRY_DISABLED: '0', DO_NOT_TRACK: '1' })).to.equal(true);
    expect(telemetryDisabled({ DCD_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '0' })).to.equal(true);
  });
});
