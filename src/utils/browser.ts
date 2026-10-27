import { spawn } from 'node:child_process';

/**
 * Open `url` in the default browser. False if it isn't an http(s) URL or no
 * opener could be started (none installed, as on a headless box).
 *
 * Only http(s) is opened, so a URL can't name a local file or start with `-`
 * and be read as an option. No opener goes through a shell: Windows uses
 * rundll32, because `cmd /c start` parses the URL again and treats its `&`
 * as a command separator.
 */
export async function openBrowser(url: string): Promise<boolean> {
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
  return startOpener(cmd.bin, cmd.args);
}

/**
 * Start `bin` detached. False if it couldn't be started. A missing program is
 * reported as an 'error' event, not thrown, and with no listener it would
 * crash the process, so this waits for 'spawn' or 'error' to know.
 */
export function startOpener(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
      child.once('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}
