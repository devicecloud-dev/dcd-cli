import { expect } from 'chai';
import {
  ENVIRONMENTS,
  findEnvByApiUrl,
  inferEnvFromApiUrl,
  resolveFrontendUrl,
} from '../../src/config/environments.js';

/**
 * The dev API answers on two hostnames: `dev-api.devicecloud.dev` (current)
 * and `api.dev.devicecloud.dev` (older). Both must resolve to dev. A dev URL
 * that fell through to prod would send uploads to the prod Supabase project.
 */
describe('environments', () => {
  const DEV_URLS = [
    'https://dev-api.devicecloud.dev',
    'https://dev-api.devicecloud.dev/',
    'https://api.dev.devicecloud.dev',
    'https://api.dev.devicecloud.dev/',
  ];

  it('treats both dev hostnames as dev', () => {
    for (const url of DEV_URLS) {
      expect(inferEnvFromApiUrl(url), url).to.equal('dev');
      expect(findEnvByApiUrl(url), url).to.equal(ENVIRONMENTS.dev);
      expect(resolveFrontendUrl(url), url).to.equal('https://dev.console.devicecloud.dev');
    }
  });

  it('uses dev-api as the dev API URL', () => {
    expect(ENVIRONMENTS.dev.apiUrl).to.equal('https://dev-api.devicecloud.dev');
  });

  it('keeps prod as prod', () => {
    expect(inferEnvFromApiUrl('https://api.devicecloud.dev')).to.equal('prod');
    expect(findEnvByApiUrl('https://api.devicecloud.dev')).to.equal(ENVIRONMENTS.prod);
  });

  it('treats localhost as dev', () => {
    expect(inferEnvFromApiUrl('http://localhost:8000')).to.equal('dev');
  });
});
