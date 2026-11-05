import { expect } from 'chai';

import { matchesRules } from '../../src/services/notices.service.js';

// The gpu1 retirement notice (dcd `deprecate-runner-gpu1-2026-11-09`) is gated
// on `runner_type equals gpu1` with no min_client_version. That is only safe
// because an older CLI — which has no runner_type in its context — evaluates
// the gate as false rather than showing the notice to everyone.
describe('notice gating on runner_type', () => {
  const gpu1Gate = {
    rules: [{ field: 'runner_type', op: 'equals' as const, value: 'gpu1' }],
  };

  it('shows the notice to a run that asks for gpu1', () => {
    expect(matchesRules(gpu1Gate, { runner_type: 'gpu1' })).to.equal(true);
  });

  it('hides it from runs on any other runner, including the default', () => {
    expect(matchesRules(gpu1Gate, { runner_type: 'default' })).to.equal(false);
    expect(matchesRules(gpu1Gate, { runner_type: 'cpu1' })).to.equal(false);
  });

  it('hides it from a context with no runner_type, as an older CLI sends', () => {
    expect(matchesRules(gpu1Gate, { platform: 'android' })).to.equal(false);
  });
});

// The allure and html-detailed retirement notices (dcd
// `deprecate-report-{allure,html-detailed}-2026-12-07`) are gated on `report`
// with no min_client_version, for the same reason as gpu1: a CLI from before
// 5.12.0 has no report in its context and must evaluate the gate as false.
describe('notice gating on report', () => {
  const allureGate = {
    rules: [{ field: 'report', op: 'equals' as const, value: 'allure' }],
  };

  it('shows the notice to a run that asks for allure', () => {
    expect(matchesRules(allureGate, { report: 'allure' })).to.equal(true);
  });

  it('hides it from runs with another format, or none', () => {
    expect(matchesRules(allureGate, { report: 'junit' })).to.equal(false);
    expect(matchesRules(allureGate, { report: 'html-detailed' })).to.equal(false);
    expect(matchesRules(allureGate, { report: undefined })).to.equal(false);
  });

  it('hides it from a context with no report, as an older CLI sends', () => {
    expect(matchesRules(allureGate, { platform: 'android' })).to.equal(false);
  });
});
