import { helper } from './helper';

export function buildService() {
  return helper();
}

export function mapValue(input: string) {
  return `${input}:${helper()}`;
}
