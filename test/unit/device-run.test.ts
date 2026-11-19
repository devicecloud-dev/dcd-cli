import { expect } from 'chai';
import { stripVTControlCharacters } from 'node:util';

import { parseRunReport, printRunResult, runFailureMessage } from '../../src/utils/device-run.js';

/** A directory run that failed, as the runner reports it (from QA). */
const FAILED_DIR = JSON.stringify({
  success: false,
  device_id: 'emulator-5554',
  total_flows: 1,
  total_commands_executed: 0,
  results: [
    {
      file: 'run-test.yml',
      success: false,
      error: 'Assertion is false: "Welcome" is visible',
      message: 'Flow execution failed',
    },
  ],
  env_vars: { MAESTRO_CLI_NO_ANALYTICS: 'false' },
  message: 'Some flows failed to execute',
});

function printed(passed: boolean, result: Parameters<typeof printRunResult>[2], label = 'flow.yaml'): string {
  const lines: string[] = [];
  printRunResult((line) => lines.push(stripVTControlCharacters(line)), passed, result, label);
  return lines.join('\n');
}

/** A single flow that failed, as a newer API answers: its own words in error, the report in output. */
const FAILED_INLINE = {
  success: false,
  error:
    'Invalid File Path at flow.yaml:7:3. flow.yaml is the flow you sent inline; line 7 refers to another file (runFlow, runScript, addMedia), which was not sent with it.',
  output: JSON.stringify({ success: false, device_id: 'x', message: 'Invalid File Path at flow.yaml:7:3' }),
  failed_at: { file: 'flow.yaml', line: 7, command: 'runFlow: common/setup.yaml', call_chain: ['flow.yaml:7'] },
};

describe('dcd device run output', () => {
  describe("the API's own words and where it failed", () => {
    it("uses the API's text for a single failed flow, not the runner's", () => {
      const report = parseRunReport(FAILED_INLINE)!;
      expect(report.flows[0].error).to.equal(FAILED_INLINE.error);
      expect(report.flows[0].failed_at).to.deep.equal(FAILED_INLINE.failed_at);
      expect(runFailureMessage(FAILED_INLINE, report)).to.equal(FAILED_INLINE.error);
      expect(printed(false, FAILED_INLINE)).to.include('which was not sent with it');
    });

    it('says where each failed flow of a bundle failed, and how it got there', () => {
      const result = {
        success: false,
        flows: [
          { file: 'a.yaml', success: true, error: null },
          {
            file: 'main.yaml',
            success: false,
            error: 'Element not found',
            failed_at: { file: 'sub/check.yaml', line: 5, command: 'tapOn: Next', call_chain: ['main.yaml:4', 'sub/check.yaml:5'] },
          },
        ],
      };
      const out = printed(false, result);
      expect(out).to.include('main.yaml failed at sub/check.yaml:5  tapOn: Next  (via main.yaml:4)');
      expect(runFailureMessage(result, parseRunReport(result))).to.equal(
        'main.yaml: Element not found (at sub/check.yaml:5  tapOn: Next  (via main.yaml:4))',
      );
    });

    it('does not say where twice when the text says it already', () => {
      const result = {
        success: false,
        flows: [
          {
            file: 'main.yaml',
            success: false,
            error: 'Element not found (at main.yaml:9)',
            failed_at: { file: 'main.yaml', line: 9, command: null, call_chain: [] },
          },
        ],
      };
      expect(printed(false, result)).not.to.include('failed at main.yaml:9');
    });
  });

  describe('parseRunReport', () => {
    it('reads a directory report from error, one row per flow', () => {
      expect(parseRunReport({ success: false, error: FAILED_DIR })).to.deep.equal({
        flows: [{ file: 'run-test.yml', success: false, error: 'Assertion is false: "Welcome" is visible' }],
        message: 'Some flows failed to execute',
      });
    });

    it('reads a single-flow report from output', () => {
      const output = JSON.stringify({
        success: true,
        device_id: 'emulator-5554',
        commands_executed: 4,
        message: 'Flow executed successfully',
        env_vars: { USER: 'me' },
      });
      expect(parseRunReport({ success: true, output })).to.deep.equal({
        flows: [{ file: null, success: true, error: null }],
        message: 'Flow executed successfully',
      });
    });

    it('prefers result.flows when the API sends it', () => {
      const flows = [
        { file: 'a.yaml', success: true, error: null },
        { file: 'b.yaml', success: false, error: 'Element not found' },
      ];
      expect(parseRunReport({ success: false, flows, error: FAILED_DIR })!.flows).to.deep.equal(flows);
    });

    it('leaves plain text alone', () => {
      expect(parseRunReport({ success: false, error: 'Element not found: Login' })).to.equal(null);
      expect(parseRunReport({ success: false, error: '{not json' })).to.equal(null);
      expect(parseRunReport({ success: true, output: '{"other":1}' })).to.equal(null);
      expect(parseRunReport({ success: true })).to.equal(null);
    });
  });

  describe('runFailureMessage', () => {
    it('names each failing flow and why, not the raw report', () => {
      const result = { success: false, error: FAILED_DIR };
      expect(runFailureMessage(result, parseRunReport(result))).to.equal(
        'run-test.yml: Assertion is false: "Welcome" is visible',
      );
    });

    it('falls back to the error text, then a default', () => {
      expect(runFailureMessage({ success: false, error: 'boom' }, null)).to.equal('boom');
      expect(runFailureMessage({ success: false }, null)).to.equal('The flow failed.');
    });
  });

  describe('printRunResult', () => {
    it('prints one line per flow and a summary, without the runner fields', () => {
      const out = printed(false, { success: false, error: FAILED_DIR });
      expect(out).to.include('Flow failed');
      expect(out).to.include('run-test.yml');
      expect(out).to.include('Assertion is false');
      expect(out).not.to.include('env_vars');
      expect(out).not.to.include('MAESTRO_CLI_NO_ANALYTICS');
      expect(out).not.to.include('emulator-5554');
      expect(out).not.to.include('total_commands_executed');
    });

    it("shows a failed run's screen text, so a near miss is plain", () => {
      const out = printed(false, {
        success: false,
        error: 'Assertion is false',
        screen_text: ['Star at the centre'],
      });
      expect(out).to.include('On screen after the failure');
      expect(out).to.include('"Star at the centre"');
      expect(printed(true, { success: true, screen_text: ['x'] })).not.to.include('On screen');
    });

    it('counts the failures in a run of several flows', () => {
      const out = printed(false, {
        success: false,
        flows: [
          { file: 'a.yaml', success: true, error: null },
          { file: 'b.yaml', success: false, error: 'Element not found' },
        ],
      });
      expect(out).to.include('1 of 2 flows failed');
      expect(out).to.match(/a\.yaml\s+passed/);
      expect(out).to.match(/b\.yaml\s+failed\s+Element not found/);
    });

    it('names a single flow by its label and drops the raw JSON on a pass', () => {
      const output = JSON.stringify({ success: true, device_id: 'x', commands_executed: 3, message: 'ok' });
      const out = printed(true, { success: true, output }, 'login.yaml');
      expect(out).to.include('Flow passed');
      expect(out).to.match(/login\.yaml\s+passed/);
      expect(out).not.to.include('device_id');
      expect(out).not.to.include('Output');
    });

    it('shows plain text as it came', () => {
      const out = printed(false, { success: false, error: 'Element not found: Login' });
      expect(out).to.include('Error');
      expect(out).to.include('Element not found: Login');
    });
  });
});
