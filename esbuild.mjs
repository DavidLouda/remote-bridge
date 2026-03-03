// @ts-check
import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * Plugin to handle native .node modules — marks them as external
 * so esbuild skips them. ssh2 gracefully falls back to pure JS crypto.
 * @type {esbuild.Plugin}
 */
const nativeModulesPlugin = {
    name: 'native-modules',
    setup(build) {
        // Mark .node binary files as external
        build.onResolve({ filter: /\.node$/ }, (args) => ({
            path: args.path,
            external: true,
        }));

        // Mark cpu-features as external (optional native dependency of ssh2)
        build.onResolve({ filter: /^cpu-features$/ }, (args) => ({
            path: args.path,
            external: true,
        }));
    },
};

/** @type {esbuild.BuildOptions} */
const buildOptions = {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    plugins: [nativeModulesPlugin],
    logLevel: 'info',
    target: 'node20',
};

async function main() {
    if (watch) {
        const ctx = await esbuild.context(buildOptions);
        await ctx.watch();
        console.log('Watching for changes...');
    } else {
        await esbuild.build(buildOptions);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
