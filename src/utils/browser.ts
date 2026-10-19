import { spawn } from 'node:child_process';

/** Open `url` in the default browser. False if no opener could be started. */
export function openBrowser(url: string): boolean {
  const cmd =
    process.platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '""', url] }
        : { bin: 'xdg-open', args: [url] };
  try {
    const child = spawn(cmd.bin, cmd.args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
