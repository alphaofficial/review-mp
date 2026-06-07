const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const external = [
  'vscode',
  'tree-sitter',
  'tree-sitter-c',
  'tree-sitter-c-sharp',
  'tree-sitter-cpp',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-kotlin',
  'tree-sitter-php',
  'tree-sitter-python',
  'tree-sitter-ruby',
  'tree-sitter-rust',
  'tree-sitter-typescript',
  'node-gyp-build',
];

const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',
  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });

    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (!location) {
          continue;
        }

        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }

      console.log('[watch] build finished');
    });
  },
};

async function main() {
  if (!watch) {
    fs.rmSync(path.join(__dirname, 'out'), { recursive: true, force: true });
  }

  const sharedOptions = {
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    define: {
      __CODEBUNNY_PROD__: JSON.stringify(production),
    },
    external,
    sourcemap: production ? false : true,
    minify: production,
    sourcesContent: !production,
    logLevel: 'info',
    legalComments: 'none',
    plugins: [esbuildProblemMatcherPlugin],
  };

  const contexts = await Promise.all([
    esbuild.context({
      ...sharedOptions,
      entryPoints: ['src/extension.ts'],
      outfile: 'out/extension.js',
    }),
    esbuild.context({
      ...sharedOptions,
      entryPoints: ['src/services/code-index/workerProcess.ts'],
      outfile: 'out/workerProcess.js',
    }),
  ]);

  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    return;
  }

  try {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.dispose()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
