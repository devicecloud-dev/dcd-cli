import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { loginCommand } from '../../src/commands/login.js';
import { telemetry } from '../../src/services/telemetry.service.js';
import { canPrompt } from '../../src/utils/ci.js';
import { CliError } from '../../src/utils/cli.js';
import { readConfig, writeConfig } from '../../src/utils/config-store.js';
import {
  matchOrg,
  OrgListItem,
  selectOrg,
  SelectOrgOptions,
} from '../../src/utils/orgs.js';

/**
 * How `dcd login` picks an org (dcd-cli#241): `--org`, else the only org, else
 * the picker starting on the last login's org. Without a TTY nobody can answer
 * the picker, so the last login's org is used, and a missing one is an error
 * rather than a hang.
 */
describe('login org selection', () => {
  const ACME: OrgListItem = { id: '1', name: 'Acme Corp', slug: 'acme' };
  const BETA: OrgListItem = { id: '2', name: 'Beta Labs', slug: 'beta' };
  const ORGS = [ACME, BETA];

  /** The message of the CliError selectOrg rejects with. */
  async function selectError(orgs: OrgListItem[], opts: SelectOrgOptions): Promise<string> {
    try {
      await selectOrg(orgs, opts);
    } catch (error) {
      expect(error).to.be.instanceOf(CliError);
      return (error as Error).message;
    }

    throw new Error('expected selectOrg to throw');
  }

  describe('selectOrg', () => {
    it('uses --org by name, ignoring case, over the last org', async () => {
      for (const interactive of [true, false]) {
        expect(
          await selectOrg(ORGS, { requested: 'BETA LABS', lastOrgId: ACME.id, interactive }),
        ).to.deep.equal({ org: BETA, fromLastLogin: false });
      }
    });

    it('matches --org by id or slug too', async () => {
      expect((await selectOrg(ORGS, { requested: '2', interactive: false })).org).to.equal(BETA);
      expect((await selectOrg(ORGS, { requested: 'acme', interactive: false })).org).to.equal(ACME);
    });

    it('rejects an --org the user is not a member of, naming the ones they are', async () => {
      expect(await selectError(ORGS, { requested: 'Nope', interactive: false })).to.equal(
        'No org named "Nope". Available: Acme Corp, Beta Labs',
      );
    });

    it('checks --org even when there is only one org', async () => {
      expect(
        await selectError([ACME], { requested: 'Beta Labs', interactive: false }),
      ).to.match(/^No org named "Beta Labs"/);
    });

    it('points an ambiguous --org name at the picker', async () => {
      const twin = { id: '3', name: 'Acme Corp' };
      expect(
        await selectError([ACME, twin], { requested: 'acme corp', interactive: true }),
      ).to.equal(
        'Multiple orgs named "acme corp". Run `dcd login` without --org to pick interactively.',
      );
    });

    it('fails when the user has no orgs', async () => {
      expect(await selectError([], { interactive: true })).to.equal(
        'No organizations found for this user.',
      );
    });

    it('uses the only org without prompting or needing a last org', async () => {
      expect(await selectOrg([ACME], { interactive: false })).to.deep.equal({
        org: ACME,
        fromLastLogin: false,
      });
    });

    it('without a TTY, uses the last login org and says it did', async () => {
      expect(await selectOrg(ORGS, { lastOrgId: BETA.id, interactive: false })).to.deep.equal({
        org: BETA,
        fromLastLogin: true,
      });
    });

    it('without a TTY or a last org, fails pointing at --org instead of hanging', async () => {
      expect(await selectError(ORGS, { interactive: false })).to.equal(
        "You belong to more than one organization, and there's no terminal to pick one in. Run `dcd login --org <name>` with one of: Acme Corp, Beta Labs",
      );
    });

    it('without a TTY, fails when the last org is no longer available', async () => {
      expect(await selectError(ORGS, { lastOrgId: '9', interactive: false })).to.equal(
        "The organization from your last login is no longer available, and there's no terminal to pick another in. Run `dcd login --org <name>` with one of: Acme Corp, Beta Labs",
      );
    });
  });

  describe('the picker', () => {
    /** Open the picker, press Enter, and return the org it chose. */
    async function pressEnter(lastOrgId: string | undefined): Promise<OrgListItem> {
      const input = new PassThrough();
      const output = new Writable({ write: (_chunk, _encoding, done) => done() });
      const selection = selectOrg(ORGS, { lastOrgId, interactive: true, input, output });
      setImmediate(() => input.write('\r'));
      return (await selection).org;
    }

    it('starts on the last login org, so Enter keeps it', async () => {
      expect(await pressEnter(BETA.id)).to.equal(BETA);
    });

    it('starts on the first org when the last one is gone', async () => {
      expect(await pressEnter('9')).to.equal(ACME);
    });
  });

  describe('matchOrg', () => {
    it('keeps the switch-org hint for an ambiguous name', () => {
      const twin = { id: '3', name: 'Acme Corp' };
      expect(() =>
        matchOrg([ACME, twin], 'Acme Corp', '`dcd switch-org` without arguments'),
      ).to.throw(
        CliError,
        'Multiple orgs named "Acme Corp". Run `dcd switch-org` without arguments to pick interactively.',
      );
    });
  });

  describe('canPrompt', () => {
    const realIsTTY = process.stdin.isTTY;
    const setStdinTTY = (value: boolean | undefined) => {
      // isTTY is a plain (writable) property on the stream in Node.
      (process.stdin as { isTTY?: boolean }).isTTY = value;
    };

    afterEach(() => setStdinTTY(realIsTTY));

    it('needs stdin and the output the prompt draws on to both be terminals', () => {
      setStdinTTY(true);
      expect(canPrompt({ isTTY: true })).to.equal(true);
      expect(canPrompt({ isTTY: false })).to.equal(false);
      expect(canPrompt({})).to.equal(false);

      setStdinTTY(false);
      expect(canPrompt({ isTTY: true })).to.equal(false);
    });
  });

  describe('dcd login without a TTY', () => {
    const API_URL = 'https://api.devicecloud.dev';
    const ORIGINAL_ENV = { ...process.env };
    const realFetch = globalThis.fetch;
    const realExit = process.exit;
    const realFlushSync = telemetry.flushSync;
    const realIsTTY = process.stdin.isTTY;
    let tempDir: string;

    const claimed = {
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user_email: 'u@example.com',
      user_id: 'u1',
    };

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcd-login-org-test-'));
      process.env.DCD_CONFIG_DIR = tempDir;
      (process.stdin as { isTTY?: boolean }).isTTY = false;

      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      globalThis.fetch = (async (input: unknown) => {
        const url = String(input);
        if (url === `${API_URL}/cli-login/claim`) return json(claimed);
        if (url === `${API_URL}/me/orgs`) return json({ orgs: ORGS });
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch;

      // A failure must fail the test, not end the mocha process, and must not
      // ship failure telemetry to the real API on its way out.
      process.exit = ((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit;
      telemetry.flushSync = () => {};
    });

    afterEach(() => {
      globalThis.fetch = realFetch;
      process.exit = realExit;
      telemetry.flushSync = realFlushSync;
      (process.stdin as { isTTY?: boolean }).isTTY = realIsTTY;
      process.env = { ...ORIGINAL_ENV };
      fs.rmSync(tempDir, { force: true, recursive: true });
    });

    /** A still-valid session from an earlier login to `apiUrl` that chose Beta Labs. */
    const loggedInBefore = (apiUrl: string) =>
      writeConfig({
        version: 1,
        env: apiUrl === API_URL ? 'prod' : 'dev',
        api_url: apiUrl,
        supabase_url: 'https://cloud.devicecloud.dev',
        session: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_email: 'u@example.com',
          user_id: 'u1',
        },
        current_org_id: BETA.id,
        current_org_name: BETA.name,
      });

    /** Run `dcd login --json --no-browser`, capturing its output and the error it ends with. */
    async function login(args: Record<string, unknown> = {}) {
      let stdout = '';
      let stderr = '';
      let error: unknown;
      const realStdout = process.stdout.write.bind(process.stdout);
      const realStderr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((chunk: string) => {
        stdout += chunk;
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string) => {
        stderr += chunk;
        return true;
      }) as typeof process.stderr.write;
      try {
        await (loginCommand.run as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
          args: { 'api-url': API_URL, browser: false, json: true, ...args },
        });
      } catch (caught) {
        error = caught;
      } finally {
        process.stdout.write = realStdout;
        process.stderr.write = realStderr;
      }

      return { stdout, stderr: stripVTControlCharacters(stderr), error };
    }

    it('signs in again over a live session and keeps the last org, without prompting', async () => {
      loggedInBefore(API_URL);
      const { stdout, stderr, error } = await login();

      expect(error).to.equal(undefined);
      expect(JSON.parse(stdout)).to.deep.equal({
        status: 'SUCCESS',
        user: 'u@example.com',
        org: { id: BETA.id, name: BETA.name },
        env: 'prod',
      });
      expect(stderr).to.include('Already logged in as u@example.com — signing in again.');
      expect(stderr).to.include(
        'No terminal to pick an organization in, so using Beta Labs from your last login.',
      );
      expect(readConfig()).to.include({ current_org_id: BETA.id, current_org_name: BETA.name });
      expect(readConfig()!.session!.access_token).to.equal('new-access');
    });

    it('uses --org over the last org', async () => {
      loggedInBefore(API_URL);
      const { stdout, stderr, error } = await login({ org: 'acme' });

      expect(error).to.equal(undefined);
      expect(JSON.parse(stdout).org).to.deep.equal({ id: ACME.id, name: ACME.name });
      expect(stderr).to.not.include('from your last login');
      expect(readConfig()!.current_org_id).to.equal(ACME.id);
    });

    it('ignores an org saved by a login to another API, as org ids differ per environment', async () => {
      loggedInBefore('https://api.dev.devicecloud.dev');
      const { stdout, error } = await login();

      expect((error as Error).message).to.equal('process.exit(1)');
      expect(JSON.parse(stdout)).to.deep.equal({
        status: 'FAILED',
        error:
          "You belong to more than one organization, and there's no terminal to pick one in. Run `dcd login --org <name>` with one of: Acme Corp, Beta Labs",
      });
      // Nothing was saved: the old dev session is still there.
      expect(readConfig()!.session!.access_token).to.equal('old-access');
    });

    it('rejects a blank --org before signing in', async () => {
      const { stdout, error } = await login({ org: ' ' });

      expect(error).to.be.instanceOf(CliError);
      expect((error as Error).message).to.equal('--org needs an organization name or id.');
      expect(stdout).to.equal('');
    });
  });
});
