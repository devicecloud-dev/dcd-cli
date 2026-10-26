import { expect } from 'chai';

import { stripAnsi } from '../../src/utils/styling.js';
import { ux } from '../../src/utils/progress.js';

// The non-interactive path (CI, pipes) prints plain lines instead of animating,
// so it can be asserted on directly by capturing console.log.
describe('progress (non-interactive)', () => {
  const originalLog = console.log;
  const originalCI = process.env.CI;
  let lines: string[];

  beforeEach(() => {
    process.env.CI = 'true';
    lines = [];
    console.log = (line: string) => {
      lines.push(stripAnsi(line));
    };
  });

  afterEach(() => {
    console.log = originalLog;
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
  });

  it('prints the title and initial status on one line', () => {
    ux.action.start('Waiting for results', 'Initializing');
    ux.action.stop();
    expect(lines).to.deep.equal(['Waiting for results · Initializing']);
  });

  it('prints each distinct status once', () => {
    ux.action.start('Uploading');
    ux.action.status = '10%';
    ux.action.status = '10%';
    ux.action.status = '50%';
    ux.action.stop();
    expect(lines).to.deep.equal(['Uploading', '10%', '50%']);
  });

  it('marks a stop with ✓ and a failure with ✗', () => {
    ux.action.start('Uploading');
    ux.action.stop('completed');
    ux.action.start('Uploading');
    ux.action.fail('failed');
    expect(lines).to.deep.equal(['Uploading', '✓ completed', 'Uploading', '✗ failed']);
  });
});
