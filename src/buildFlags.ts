declare const __CODEBUNNY_PROD__: boolean;

export const IS_PRODUCTION_BUILD = typeof __CODEBUNNY_PROD__ !== 'undefined'
  ? __CODEBUNNY_PROD__
  : false;

export function isDebugLoggingEnabled(): boolean {
  return !IS_PRODUCTION_BUILD;
}
