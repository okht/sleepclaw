import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const app = resolve(import.meta.dirname, '..');
const root = resolve(app, '../plugins/sleepclaw');
const runtime = join(root, 'runtime');
mkdirSync(runtime, { recursive: true });
const built = await build({ entryPoints: [join(app, 'src/tools-cli.ts')], outfile: join(runtime, 'sleepclaw-tools.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', metafile: true, sourcemap: false, legalComments: 'eof', absWorkingDir: app });
const packages = new Map<string, { name: string; version: string; license: string; files: string[] }>();
for (const input of Object.keys(built.metafile!.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let dir = dirname(resolve(app, input));
  while (dir !== app && dir !== dirname(dir)) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.name && pkg.version) {
        const key = `${pkg.name}@${pkg.version}`;
        if (!packages.has(key)) {
          const files: string[] = [];
          for (const file of readdirSync(dir).filter(file => /^(license|licence|copying)(\.|$)/i.test(file))) {
            const destination = join(runtime, 'licenses', pkg.name.replace(/[@/]/g, '_'), file);
            mkdirSync(dirname(destination), { recursive: true }); cpSync(join(dir, file), destination);
            files.push(relative(runtime, destination).replaceAll('\\', '/'));
          }
          packages.set(key, { name: pkg.name, version: pkg.version, license: pkg.license ?? 'See source', files });
        }
        break;
      }
    }
    dir = dirname(dir);
  }
}
writeFileSync(join(runtime, 'dependencies.json'), JSON.stringify([...packages.values()], null, 2) + '\n');
console.log(`Built ${relative(app, runtime)} with ${packages.size} dependency notices. No Pi runtime or credentials included.`);
