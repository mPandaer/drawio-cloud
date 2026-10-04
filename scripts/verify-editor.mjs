import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'build/editor');
const build = () => execFileSync(process.execPath, [join(root, 'scripts/build-editor.mjs')], { stdio: 'inherit' });
build();
const first = await readFile(join(output, 'editor-build.json'), 'utf8');
build();
assert.equal(await readFile(join(output, 'editor-build.json'), 'utf8'), first);
assert.equal((await stat(output)).mode & 0o777, 0o755, 'Editor directory must be traversable by the static service UID');
const manifest = JSON.parse(first);
assert.equal(new URL(manifest.launchPath, 'http://verification.invalid/editor/').searchParams.get('keepmodified'), '1');
const menus = await readFile(join(root, 'vendor/drawio/src/main/webapp/js/diagramly/Menus.js'), 'utf8');
const saveClearing = menus.match(/if \(urlParams\['modified'\] != '0' && urlParams\['keepmodified'\] != '1'\)\s*\{\s*editorUi\.editor\.modified = false;\s*editorUi\.clearStatus\(\);\s*\}/);
assert.ok(saveClearing, 'Official embed save must gate local state clearing on keepmodified');
for (const file of manifest.files) {
  const content = await readFile(join(output, file.path));
  assert.equal(content.length, file.bytes, file.path);
  assert.equal(createHash('sha256').update(content).digest('hex'), file.sha256, file.path);
}
await assert.rejects(stat(join(output, 'WEB-INF')));
await assert.rejects(stat(join(output, 'META-INF')));

const preconfig = await readFile(join(output, 'js/PreConfig.js'), 'utf8');
const init = await readFile(join(root, 'vendor/drawio/src/main/webapp/js/diagramly/Init.js'), 'utf8');
const graphInit = await readFile(join(root, 'vendor/drawio/src/main/webapp/js/grapheditor/Init.js'), 'utf8');
for (const href of ['http://192.168.50.12:8080/editor/index.html', 'https://draw.example.test/tools/editor/']) {
  const location = new URL(href);
  const context = { URL, location, navigator: { userAgent: 'verification' }, structuredClone, urlParams: {}, isLocalStorage: false };
  context.window = context;
  runInNewContext(preconfig + '\n' + init + '\n' + graphInit, context);
  const base = new URL('./', href).href;
  assert.equal(context.DRAWIO_BASE_URL + '/', base);
  assert.equal(context.DRAWIO_SERVER_URL, base);
  for (const [key, path] of Object.entries({ RESOURCE_BASE: 'resources/dia', STENCIL_PATH: 'stencils', SHAPES_PATH: 'shapes', IMAGE_PATH: 'images', GRAPH_IMAGE_PATH: 'img', CSS_PATH: 'styles', mxImageBasePath: 'mxgraph/images', DRAW_MATH_URL: 'math4/es5' })) {
    assert.equal(context[key], new URL(path, base).href, key);
  }
  assert.equal(context.mxLanguage, 'zh');
  assert.equal(context.urlParams.embed, '1');
  assert.equal(context.urlParams.proto, 'json');
  assert.equal(context.urlParams.keepmodified, '1');
  assert.equal(context.EXPORT_URL, null);
  assert.equal(context.urlParams.offline, undefined);
  assert.equal(context.urlParams.lockdown, undefined);
  for (const key of ['gapi', 'picker', 'db', 'od', 'gh', 'gl', 'tr', 'ms365']) assert.equal(context.urlParams[key], '0');
  assert.equal(context.PROXY_URL, 'https://app.diagrams.net/proxy');
  assert.equal(context.ICON_SERVICE_PATH, 'https://app.diagrams.net/api/icons');
}

function localAssets(html, base) {
  const assets = [];
  for (const [tag] of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(match => [match[1].toLowerCase(), match[2]]));
    if (attributes.rel?.toLowerCase() === 'canonical') continue;
    const path = attributes.src ?? attributes.href;
    if (!path) continue;
    const url = new URL(path, base);
    assert.ok(url.origin === new URL(base).origin && url.pathname.startsWith(new URL(base).pathname), `Nonlocal startup asset: ${path}`);
    assets.push(path);
  }
  return assets;
}

// This bounded HTTP check serves only generated editor assets, never product data.
const files = new Set(manifest.files.map((file) => file.path));
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://verification.invalid').pathname.replace(/^\/editor\//, '');
  if (!files.has(path)) { response.writeHead(404).end(); return; }
  try { response.end(await readFile(join(output, path))); }
  catch { response.writeHead(500).end(); }
});
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}/editor/`;
  const html = await readFile(join(output, 'index.html'), 'utf8');
  const assets = localAssets(html, base);
  const externalProbe = html.replace('src="js/bootstrap.js"', 'src="https://cdn.example/bootstrap.js"');
  assert.throws(() => localAssets(externalProbe, base), /Nonlocal startup asset/);
  assets.push('js/PreConfig.js', 'js/app.min.js', 'js/PostConfig.js', 'resources/dia_zh.txt', 'js/stencils.min.js', 'js/shapes-14-6-5.min.js', 'math4/es5/drawio-mathjax.min.js');
  for (const path of new Set(assets)) {
    const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, path);
    assert.ok((await response.arrayBuffer()).byteLength > 0, path);
  }
  console.log(`PASS: repeat builds identical; ${manifest.files.length} asset hashes verified; LAN/HTTPS nested prefixes survive official Init; ${new Set(assets).size} local HTTP assets loaded without public requests.`);
  console.log('Browser init, optional online services, client export and product save round trip still require integration acceptance.');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
