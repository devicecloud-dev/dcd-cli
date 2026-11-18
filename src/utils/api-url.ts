/**
 * Checks for an API URL given by hand (`--api-url`, `DCD_API_URL`), before
 * any credential is sent to it: the API key or login session goes with every
 * request, and a repository's MCP config can set DCD_API_URL. No imports, so
 * the telemetry service can use it too.
 */

/** This machine: plain http is fine, for a local API. */
function isLocalHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

/** DeviceCloud's own hosts. */
function isDeviceCloudHost(host: string): boolean {
  return host === 'devicecloud.dev' || host.endsWith('.devicecloud.dev');
}

export type ApiUrlCheck =
  | { ok: false; reason: string }
  | { ok: true; origin: string; warning: null | string };

/**
 * Whether credentials may be sent to `raw`: an http(s) URL with no user name
 * or password in it, and plain http only to this machine. A host that is not
 * devicecloud.dev passes with a warning (a staging or self-run API).
 */
export function checkApiUrl(raw: string): ApiUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `The API URL "${raw}" is not a URL. Use one like https://api.devicecloud.dev.` };
  }

  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `The API URL must start with https://, not ${url.protocol}//.` };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'The API URL must not contain a user name or password.' };
  }

  if (url.protocol === 'http:' && !isLocalHost(host)) {
    return {
      ok: false,
      reason: `Refusing to send your API key or login session to ${url.origin} over plain http, where anyone on the way can read it. Use https.`,
    };
  }

  const trusted = isDeviceCloudHost(host) || isLocalHost(host);
  return {
    ok: true,
    origin: url.origin,
    warning: trusted
      ? null
      : `The API URL ${url.origin} is not a devicecloud.dev host. Your API key or login session is sent to it with every request.`,
  };
}
