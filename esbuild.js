const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const external = [
  'vscode',
  '@lancedb/lancedb',
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

async function main() {
  if (!watch) {
    fs.rmSync(path.join(__dirname, 'out'), { recursive: true, force: true });
  }

  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: 'out/extension.js',
    define: {
      __REVIEWMP_PROD__: JSON.stringify(production),
    },
    external,
    sourcemap: production ? false : true,
    minify: production,
    sourcesContent: !production,
    logLevel: 'info',
    legalComments: 'none',
  });

  if (watch) {
    await ctx.watch();
    return;
  }

  try {
    await ctx.rebuild();
  } finally {
    await ctx.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
