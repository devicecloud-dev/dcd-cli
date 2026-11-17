import { expect } from 'chai';

import { scrubArgv } from '../../src/services/telemetry.service.js';

/**
 * Telemetry keeps the argv of every command. What a caller gives a command
 * as a secret must not be in it: the link of `device open-link`, which is a
 * positional and so has no flag name to go by, and the text of `device type`.
 */
describe('telemetry: scrubArgv', () => {
  const R = '<redacted>';

  it('redacts the link of device open-link, with or without --sensitive, wherever it sits', () => {
    expect(scrubArgv(['device', 'open-link', 'myapp://sign-in?token=SECRET', '--sensitive'])).to.deep.equal([
      'device',
      'open-link',
      R,
      '--sensitive',
    ]);
    expect(scrubArgv(['device', 'open-link', '--sensitive', '--json', 'myapp://sign-in?token=SECRET'])).to.deep.equal([
      'device',
      'open-link',
      '--sensitive',
      '--json',
      R,
    ]);
    // No flag: the link is the caller's all the same, and may carry a token they did not think to mark.
    expect(scrubArgv(['device', 'open-link', 'https://example.com/reset?token=SECRET'])).to.deep.equal([
      'device',
      'open-link',
      R,
    ]);
  });

  it('redacts a link too malformed to send, and the session id with it', () => {
    expect(scrubArgv(['device', 'open-link', 'brave-teal-otter', 'example.com/reset?token=SECRET'])).to.deep.equal([
      'device',
      'open-link',
      R,
      R,
    ]);
  });

  it('finds open-link behind a flag and its value, and keeps only the API URL of what follows', () => {
    const scrubbed = scrubArgv([
      '--api-url',
      'https://dev-api.devicecloud.dev',
      'device',
      '--api-key',
      'dcd_SECRETKEY',
      'open-link',
      'myapp://x?token=SECRET',
      '--api-url',
      'https://dev-api.devicecloud.dev',
      '--url=myapp://y?token=SECRET',
      '--other',
      'myapp://z?token=SECRET',
    ]);
    expect(scrubbed).to.deep.equal([
      '--api-url',
      'https://dev-api.devicecloud.dev',
      'device',
      '--api-key',
      R,
      'open-link',
      R,
      '--api-url',
      'https://dev-api.devicecloud.dev',
      `--url=${R}`,
      '--other',
      R,
    ]);
    expect(JSON.stringify(scrubbed)).to.not.contain('SECRET');
  });

  it('redacts the text of device type, in both spellings, and keeps the label of a tap', () => {
    expect(scrubArgv(['device', 'type', '--text', 'hunter2', '--sensitive'])).to.deep.equal([
      'device',
      'type',
      '--text',
      R,
      '--sensitive',
    ]);
    expect(scrubArgv(['device', 'type', 'brave-teal-otter', '--text=hunter2'])).to.deep.equal([
      'device',
      'type',
      'brave-teal-otter',
      `--text=${R}`,
    ]);
    expect(scrubArgv(['device', 'tap', '--text', 'Log in', '--timeout', '2'])).to.deep.equal([
      'device',
      'tap',
      '--text',
      'Log in',
      '--timeout',
      '2',
    ]);
  });

  it('still redacts the flags it always did, and leaves other commands alone', () => {
    expect(scrubArgv(['cloud', '--api-key', 'dcd_SECRETKEY', '-e', 'PASSWORD=hunter2', '--env=TOKEN=abc', 'flows/'])).to.deep.equal([
      'cloud',
      '--api-key',
      R,
      '-e',
      R,
      `--env=${R}`,
      'flows/',
    ]);
    expect(scrubArgv(['device', 'set-location', '--latitude', '51.5074', '--longitude', '-0.1278'])).to.deep.equal([
      'device',
      'set-location',
      '--latitude',
      '51.5074',
      '--longitude',
      '-0.1278',
    ]);
    // A link is only a link after `device open-link`.
    expect(scrubArgv(['upload', 'open-link', 'app.apk'])).to.deep.equal(['upload', 'open-link', 'app.apk']);
  });
});
