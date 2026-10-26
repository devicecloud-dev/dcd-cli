import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dryRunFlows } from '../../src/mcp/tools/run-cloud-test.js';
import { plan } from '../../src/services/execution-plan.service.js';
import { buildTestMetadataMap, computeCommonRoot } from '../../src/services/flow-paths.js';

/** What dcd_run_cloud_test's dry run lists for a folder, given these filters. */
async function preview(dir: string, filters: { excludeTags?: string[]; includeTags?: string[] }) {
  const executionPlan = await plan({
    excludeTags: filters.excludeTags ?? [],
    includeTags: filters.includeTags ?? [],
    input: `${dir}/`,
    warn() {},
  });
  const commonRoot = computeCommonRoot(
    executionPlan.flowsToRun,
    executionPlan.referencedFiles,
    executionPlan.includedFiles,
  );
  const map = buildTestMetadataMap(executionPlan.flowMetadata, commonRoot);
  return {
    // What `dcd cloud --dry-run` lists.
    cli: executionPlan.flowsToRun.map((f) => path.basename(f)).sort(),
    mcp: dryRunFlows(executionPlan, map, commonRoot)
      .map((f) => path.basename(f.file))
      .sort(),
  };
}

describe('dcd_run_cloud_test dry run', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-dry-run-'));
    const flow = (name: string, tag: string) =>
      fs.writeFileSync(path.join(dir, name), `appId: x\ntags:\n  - ${tag}\n---\n- launchApp\n`);
    flow('android-a.yaml', 'android');
    flow('android-b.yaml', 'android');
    flow('ios-a.yaml', 'ios');
  });

  afterEach(() => fs.rmSync(dir, { force: true, recursive: true }));

  it('lists only the flows the include tags pick, as the CLI does', async () => {
    const { cli, mcp } = await preview(dir, { includeTags: ['ios'] });
    expect(mcp).to.deep.equal(['ios-a.yaml']);
    expect(mcp).to.deep.equal(cli);
  });

  it('leaves out the flows the exclude tags drop, as the CLI does', async () => {
    const { cli, mcp } = await preview(dir, { excludeTags: ['android'] });
    expect(mcp).to.deep.equal(['ios-a.yaml']);
    expect(mcp).to.deep.equal(cli);
  });

  it('lists every flow with no filters, with its tags', async () => {
    const executionPlan = await plan({ excludeTags: [], includeTags: [], input: `${dir}/`, warn() {} });
    const root = computeCommonRoot(executionPlan.flowsToRun, [], []);
    const flows = dryRunFlows(executionPlan, buildTestMetadataMap(executionPlan.flowMetadata, root), root);
    expect(flows).to.deep.equal([
      { file: './android-a.yaml', flowName: 'android-a', tags: ['android'] },
      { file: './android-b.yaml', flowName: 'android-b', tags: ['android'] },
      { file: './ios-a.yaml', flowName: 'ios-a', tags: ['ios'] },
    ]);
  });
});
