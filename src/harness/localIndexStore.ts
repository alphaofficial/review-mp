import fs from 'node:fs';
import path from 'node:path';

export class LocalIndexStore<State extends object> {
  private readonly statePath: string;

  constructor(rootDirectory: string, filename: string, private readonly defaultState: State) {
    this.statePath = path.join(rootDirectory, filename);
  }

  async read(): Promise<State> {
    try {
      const content = await fs.promises.readFile(this.statePath, 'utf8');
      return {
        ...this.defaultState,
        ...JSON.parse(content),
      } as State;
    } catch {
      return structuredClone(this.defaultState);
    }
  }

  async write(state: State): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.statePath), { recursive: true });
    await fs.promises.writeFile(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  async reset(): Promise<void> {
    await fs.promises.rm(this.statePath, { force: true });
  }
}
