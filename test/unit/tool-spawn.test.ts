import { expect } from 'chai';

import { vscodeAddArgs } from '../../src/utils/mcp-install.js';
import { cmdArgument, findOnWindowsPath, toolSpawn } from '../../src/utils/tool-spawn.js';

/** One cmd.exe parse pass: carets escape outside quotes, quotes toggle, & | < > outside quotes are operators. */
function cmdPass(line: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!quoted && ch === '^') {
      out += line[++i] ?? '';
      continue;
    }

    if (!quoted && '&|<>'.includes(ch)) throw new Error(`cmd would treat ${ch} as an operator in: ${line}`);
    if (ch === '"') quoted = !quoted;
    out += ch;
  }

  return out;
}

/** CommandLineToArgvW's rules for the arguments after the program name. */
function argv(line: string): string[] {
  const args: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '';
    let quoted = false;
    while (i < line.length && (quoted || (line[i] !== ' ' && line[i] !== '\t'))) {
      let slashes = 0;
      while (line[i] === '\\') {
        slashes++;
        i++;
      }

      if (line[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"';
        else quoted = !quoted;
        i++;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < line.length) arg += line[i++];
      }
    }

    args.push(arg);
  }

  return args;
}

/** What a program started by `code.cmd ... %*` sees for the given arguments. */
function throughBatch(args: string[]): string[] {
  // `cmd /s /c "<line>"` parses the line once; the batch file's %* line is parsed again.
  return argv(cmdPass(cmdPass(args.map((arg) => cmdArgument(arg)).join(' '))));
}

describe('toolSpawn', () => {
  const files = new Set([
    String.raw`C:\Program Files\Microsoft VS Code\bin\code.cmd`,
    String.raw`C:\Users\a\AppData\Roaming\npm\claude.cmd`,
    String.raw`C:\tools\claude.exe`,
  ]);
  const exists = (file: string) => files.has(file);
  const env = {
    ComSpec: String.raw`C:\Windows\system32\cmd.exe`,
    PATH: String.raw`C:\Windows;"C:\Program Files\Microsoft VS Code\bin";C:\Users\a\AppData\Roaming\npm`,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };

  it('spawns the command as given off Windows', () => {
    expect(toolSpawn('code', ['--add-mcp', '{}'], 'darwin', env, exists)).to.deep.equal({
      args: ['--add-mcp', '{}'],
      command: 'code',
    });
  });

  it('finds a .cmd on PATH, and an .exe before a .cmd in a later folder', () => {
    expect(findOnWindowsPath('code', env, exists)).to.equal(String.raw`C:\Program Files\Microsoft VS Code\bin\code.cmd`);
    expect(findOnWindowsPath('claude', { ...env, PATH: `C:\\tools;${env.PATH}` }, exists)).to.equal(
      String.raw`C:\tools\claude.exe`,
    );
    expect(findOnWindowsPath('cursor', env, exists)).to.equal(undefined);
  });

  it('is undefined on Windows when the command is not on PATH', () => {
    expect(toolSpawn('cursor', [], 'win32', env, exists)).to.equal(undefined);
  });

  it('spawns an .exe directly', () => {
    expect(toolSpawn('claude', ['mcp'], 'win32', { ...env, PATH: 'C:\\tools' }, exists)).to.deep.equal({
      args: ['mcp'],
      command: String.raw`C:\tools\claude.exe`,
    });
  });

  it('runs a .cmd through cmd.exe with verbatim arguments', () => {
    const spawn = toolSpawn('code', ['--add-mcp', '{}'], 'win32', env, exists)!;
    expect(spawn.command).to.equal(env.ComSpec);
    expect(spawn.windowsVerbatimArguments).to.equal(true);
    expect(spawn.args.slice(0, 3)).to.deep.equal(['/d', '/s', '/c']);
    expect(cmdPass(spawn.args[3].slice(1, -1))).to.match(/^C:\\Program Files\\Microsoft VS Code\\bin\\code\.cmd /);
  });

  it('gets the --add-mcp JSON to VS Code unchanged', () => {
    const add = vscodeAddArgs({
      args: [String.raw`C:\Users\a b\AppData\Roaming\npm\node_modules\@devicecloud.dev\dcd\dist\index.js`, 'mcp', '--read-only'],
      command: String.raw`C:\Program Files (x86)\nodejs\node.exe`,
    });
    expect(throughBatch(add)).to.deep.equal(add);
  });

  it('keeps cmd characters, quotes and trailing backslashes intact', () => {
    const args = ['a&b|c', '<in>', '100%PATH%', 'say "hi"', String.raw`C:\dir\ `, String.raw`end\\`, '^caret!', '"&"', 'x" | "y', ''];
    expect(throughBatch(args)).to.deep.equal(args);
  });
});
