declare const __REVIEWMP_PROD__: boolean;

export const IS_PRODUCTION_BUILD = typeof __REVIEWMP_PROD__ !== 'undefined'
  ? __REVIEWMP_PROD__
  : false;

export function isDebugLoggingEnabled(): boolean {
  return !IS_PRODUCTION_BUILD;
}
