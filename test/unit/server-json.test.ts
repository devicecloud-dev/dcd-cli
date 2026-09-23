import { expect } from 'chai';
import { readFileSync } from 'node:fs';

/**
 * server.json is the MCP registry manifest. Registry clients turn an npm entry
 * into `npx <runtimeArguments> <identifier>@<version> <packageArguments>` (VS
 * Code's McpManagementService does exactly this), and the server is this
 * package's *second* bin — so the manifest has to name it through
 * `npx --package=<pkg> dcd-mcp`, or npx runs the default `dcd` bin instead.
 */
interface Argument {
  name?: string;
  type: 'named' | 'positional';
  value?: string;
}

interface ServerJson {
  packages: Array<{
    identifier: string;
    packageArguments?: Argument[];
    runtimeArguments?: Argument[];
    runtimeHint?: string;
    version: string;
  }>;
  version: string;
}

const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')) as T;

const server = readJson<ServerJson>('server.json');
const npmPackage = server.packages[0];

/** A client's rendering of registry arguments into argv (named → flag, value). */
const render = (args: Argument[] = []): string[] =>
  args.flatMap((a) =>
    a.type === 'named' ? [a.name!, ...(a.value ? [a.value] : [])] : [a.value!],
  );

describe('server.json (MCP registry manifest)', () => {
  it('assembles into an npx command that runs the dcd-mcp bin', () => {
    const argv = [
      ...render(npmPackage.runtimeArguments),
      `${npmPackage.identifier}@${npmPackage.version}`,
      ...render(npmPackage.packageArguments),
    ];
    const pinned = `@devicecloud.dev/dcd@${server.version}`;

    expect(npmPackage.runtimeHint).to.equal('npx');
    // npx runs the first positional after --package; the identifier the
    // client appends is only an extra argument, which dcd-mcp ignores.
    expect(argv).to.deep.equal(['-y', '--package', pinned, 'dcd-mcp', pinned]);

    const { bin } = readJson<{ bin: Record<string, string> }>('package.json');
    expect(bin).to.have.property('dcd-mcp');
  });

  it('pins the last stable release everywhere, which release-please keeps in step', () => {
    const { '.': stable } = readJson<Record<string, string>>(
      '.release-please-manifest.json',
    );
    const packagePin = render(npmPackage.runtimeArguments).find((a) =>
      a.startsWith('@devicecloud.dev/dcd@'),
    );

    expect(server.version).to.equal(stable);
    expect(npmPackage.version).to.equal(stable);
    expect(packagePin).to.equal(`@devicecloud.dev/dcd@${stable}`);
  });
});
