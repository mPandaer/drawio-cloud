import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'vendor/drawio');
const source = join(vendor, 'src/main/webapp');
const output = join(root, 'build/editor');
const revision = '2201e54124bfbbf09d8addec60e6f8d73eed6f92';
const required = [
  'index.html', 'js/bootstrap.js', 'js/main.js', 'js/app.min.js',
  'js/PostConfig.js', 'js/viewer.min.js', 'js/shapes-14-6-5.min.js',
  'js/stencils.min.js', 'resources/dia.txt', 'resources/dia_zh.txt',
  'styles/grapheditor.css', 'js/extensions.min.js',
  'math4/es5/drawio-mathjax.min.js',
];

const actualRevision = execFileSync('git', ['-C', vendor, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (actualRevision !== revision) {
  throw new Error(`Expected draw.io v32.0.2 (${revision}); found ${actualRevision}`);
}
const changes = execFileSync('git', ['-C', vendor, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
if (changes.trim()) throw new Error('Editor submodule has local changes; refuse to package an unrecorded fork.');
for (const path of required) {
  if (!(await stat(join(source, path))).isFile()) throw new Error(`Missing official asset: ${path}`);
}

await mkdir(join(root, 'build'), { recursive: true });
const staging = await mkdtemp(join(root, 'build/.editor-'));
try {
  await cp(source, staging, {
    recursive: true,
    filter: (path) => !['WEB-INF', 'META-INF'].includes(path.slice(source.length + 1).split('/')[0]),
  });
  await cp(join(root, 'scripts/editor-preconfig.js'), join(staging, 'js/PreConfig.js'));
  await cp(join(vendor, 'LICENSE'), join(staging, 'LICENSE'));
  const files = [];
  async function inventory(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) await inventory(join(directory, entry.name), path + '/');
      else if (entry.isFile()) {
        const content = await readFile(join(directory, entry.name));
        files.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
      } else throw new Error(`Unsupported asset type: ${path}`);
    }
  }
  await inventory(staging);
  await writeFile(join(staging, 'editor-build.json'), JSON.stringify({
    version: 'v32.0.2', revision,
    launchPath: 'index.html?embed=1&proto=json&keepmodified=1&lang=zh&ui=kennedy&pwa=0',
    files,
  }, null, 2) + '\n');
  // Only the dedicated generated directory is replaced; product output is separate.
  await rm(output, { recursive: true, force: true });
  await chmod(staging, 0o755);
  await rename(staging, output);
  console.log(`Editor v32.0.2: ${files.length} files copied to ${output}`);
  console.log('Mount at /editor/ (including trailing slash) and use the launchPath in editor-build.json.');
} finally {
  await rm(staging, { recursive: true, force: true });
}
