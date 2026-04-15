import * as fs from 'fs';
import * as path from 'path';

export interface ResolveOpenCodePathOptions {
  configuredPath?: string;
  pathValue?: string;
}

export function getOpenCodeMissingErrorMessage(): string {
  return 'Could not find opencode. Install OpenCode and ensure it is on PATH, or set reviewmp.opencodePath to the OpenCode executable path.';
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getExecutableCandidates(command: string): string[] {
  if (process.platform !== 'win32') {
    return [command];
  }

  const extensions = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);

  if (path.extname(command)) {
    return [command];
  }

  return extensions.map((extension) => `${command}${extension.toLowerCase()}`);
}

export function resolveOpenCodePath(options: ResolveOpenCodePathOptions = {}): string {
  const configuredPath = options.configuredPath?.trim();

  if (configuredPath && configuredPath !== 'opencode') {
    return options.configuredPath as string;
  }

  const pathValue = options.pathValue ?? process.env.PATH ?? '';
  for (const pathEntry of pathValue.split(path.delimiter)) {
    if (!pathEntry) {
      continue;
    }

    for (const candidate of getExecutableCandidates('opencode')) {
      const candidatePath = path.join(pathEntry, candidate);
      if (isExecutable(candidatePath)) {
        return candidatePath;
      }
    }
  }

  throw new Error(getOpenCodeMissingErrorMessage());
}
