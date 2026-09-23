import { expect } from 'chai';
import { readFileSync } from 'node:fs';

/**
 * server.json is the MCP registry manifest. Registry clients turn an npm entry
 * into `npx <runtimeArguments> <identifier>@<version> <packageArguments>` (VS
 * Code's McpManagementService does exactly this), and the server is this
 * package's *second* bin — so the manifest has to name it through
 * `npx --package=<pkg> dcd-mcp`, or npx runs the default `dcd` bin instead.
 *
 * The runtime arguments end with a bare `--package`, so the
 * `<identifier>@<version>` the client appends becomes its value, and
 * `dcd-mcp` follows as the package argument. The pin therefore lives only in
 * `packages[].version`, a bare version string release-please can rewrite.
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

interface ReleasePleaseConfig {
  packages: Record<
    string,
    { 'extra-files'?: Array<{ jsonpath?: string; path: string; type: string }> }
  >;
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

    expect(npmPackage.runtimeHint).to.equal('npx');
    expect(argv).to.deep.equal([
      '-y',
      '--package',
      `@devicecloud.dev/dcd@${npmPackage.version}`,
      'dcd-mcp',
    ]);

    const { bin } = readJson<{ bin: Record<string, string> }>('package.json');
    expect(bin).to.have.property('dcd-mcp');
  });

  it('pins the last stable release, and only in the bare version fields', () => {
    const { '.': stable } = readJson<Record<string, string>>(
      '.release-please-manifest.json',
    );

    expect(server.version).to.equal(stable);
    expect(npmPackage.version).to.equal(stable);

    // A version embedded in an argument can't be kept current: release-please's
    // json updater replaces the whole matched value with the bare version.
    const argv = [
      ...render(npmPackage.runtimeArguments),
      ...render(npmPackage.packageArguments),
    ];
    expect(argv.filter((a) => /@\d/.test(a))).to.deep.equal([]);
  });

  it('only lets release-please rewrite bare version fields in server.json', () => {
    const config = readJson<ReleasePleaseConfig>('release-please-config.json');
    const serverJsonPaths = Object.values(config.packages)
      .flatMap((pkg) => pkg['extra-files'] ?? [])
      .filter((file) => file.path === 'server.json')
      .map((file) => file.jsonpath);

    expect(serverJsonPaths).to.have.members(['$.version', '$.packages[*].version']);
  });
});
