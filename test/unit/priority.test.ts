import { expect } from 'chai';
import { parseArgs } from 'citty';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { executionFlags } from '../../src/config/flags/execution.flags.js';
import type { IExecutionPlan } from '../../src/services/execution-plan.service.js';
import {
  type TestSubmissionConfig,
  TestSubmissionService,
} from '../../src/services/test-submission.service.js';
import { validateEnum } from '../../src/utils/cli.js';

const PRIORITY_OPTIONS = ['low', 'normal', 'high'] as const;

/**
 * --priority reorders only the org's own queued runs (dcd#1581). It goes to
 * the API as a top-level submission field, never inside `config`, and the
 * default ('normal') is not sent at all, so older APIs see an unchanged wire
 * shape.
 */
describe('priority', () => {
  let workspace: string;
  let flowFile: string;

  before(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-priority-'));
    flowFile = path.join(workspace, 'flow.yaml');
    fs.writeFileSync(flowFile, 'appId: com.example\n---\n- launchApp\n');
  });

  after(() => {
    fs.rmSync(workspace, { force: true, recursive: true });
  });

  /** The string-encoded fields the submission would send. */
  async function fieldsFor(
    overrides: Partial<TestSubmissionConfig>,
  ): Promise<Record<string, string>> {
    const executionPlan: IExecutionPlan = {
      flowMetadata: {},
      flowOverrides: {},
      flowsToRun: [flowFile],
      includedFiles: [],
      referencedFiles: [],
      totalFlowFiles: 1,
    };
    const { fields } = await new TestSubmissionService().buildTestPayload({
      appBinaryId: 'binary-1',
      cliVersion: '0.0.0-test',
      commonRoot: workspace,
      encrypt: false,
      executionPlan,
      flowFile,
      maestroVersion: '2.10.0',
      ...overrides,
    });
    return fields;
  }

  describe('the --priority flag', () => {
    const parse = (argv: string[]) => parseArgs(argv, executionFlags).priority;

    it('defaults to normal', () => {
      expect(parse([])).to.equal('normal');
    });

    it('accepts an explicit value', () => {
      expect(parse(['--priority', 'high'])).to.equal('high');
      expect(parse(['--priority', 'low'])).to.equal('low');
    });
  });

  describe('validation', () => {
    it('accepts low, normal and high', () => {
      for (const value of PRIORITY_OPTIONS) {
        expect(validateEnum(value, PRIORITY_OPTIONS, 'priority')).to.equal(
          value,
        );
      }
    });

    it('rejects anything else', () => {
      expect(() =>
        validateEnum('urgent', PRIORITY_OPTIONS, 'priority'),
      ).to.throw('Invalid value for --priority');
    });
  });

  describe('the submission payload', () => {
    it('sends high as a top-level field', async () => {
      expect((await fieldsFor({ priority: 'high' })).priority).to.equal('high');
    });

    it('sends low as a top-level field', async () => {
      expect((await fieldsFor({ priority: 'low' })).priority).to.equal('low');
    });

    it('sends nothing for normal or when unset', async () => {
      expect((await fieldsFor({ priority: 'normal' })).priority).to.equal(
        undefined,
      );
      expect((await fieldsFor({})).priority).to.equal(undefined);
    });

    it('never puts it inside config', async () => {
      const fields = await fieldsFor({ priority: 'high' });
      expect(JSON.parse(fields.config)).to.not.have.property('priority');
    });
  });
});
