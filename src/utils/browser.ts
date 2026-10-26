import { spawn } from 'node:child_process';

/**
 * Open `url` in the default browser. False if it isn't an http(s) URL or no
 * opener could be started.
 *
 * Only http(s) is opened, so a URL can't name a local file or start with `-`
 * and be read as an option. No opener goes through a shell: Windows uses
 * rundll32, because `cmd /c start` parses the URL again and treats its `&`
 * as a command separator.
 */
export function openBrowser(url: string): boolean {
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    href = parsed.href;
  } catch {
    return false;
  }

  const cmd =
    process.platform === 'darwin'
      ? { bin: 'open', args: [href] }
      : process.platform === 'win32'
        ? { bin: 'rundll32', args: ['url.dll,FileProtocolHandler', href] }
        : { bin: 'xdg-open', args: [href] };
  try {
    const child = spawn(cmd.bin, cmd.args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
