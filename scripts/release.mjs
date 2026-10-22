// Deterministic release packager. Run after `npm run build`.
// Produces web (static host) and self-host (collaboration server + app) archives whose bytes depend
// only on input file contents: sorted entries, fixed timestamps, no host metadata.
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? Date.parse('2026-10-21T00:00:00Z') / 1000);
if (!Number.isInteger(epoch) || epoch < 315532800) throw new Error('SOURCE_DATE_EPOCH must be an integer >= 1980-01-01.');
const mtime = new Date(epoch * 1000);
const out = path.resolve(process.argv[2] ?? path.join(root, 'release', version));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function files(dir) {
  const result = [];
  for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.posix.join(dir.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) result.push(...await files(relative)); else if (entry.isFile()) result.push(relative);
  }
  return result;
}
async function archive(prefix, list) {
  const entries = {};
  for (const file of [...new Set(list)].sort()) entries[`${prefix}/${file}`] = [new Uint8Array(await readFile(path.join(root, file))), { mtime, level: 9 }];
  return zipSync(entries, { mtime });
}

const dist = await files('apps/opendraft/dist');
if (!dist.includes('apps/opendraft/dist/index.html')) throw new Error('Run npm run build first.');
const notices = ['desktop/THIRD_PARTY_NOTICES.md', 'docs/generated/DEPENDENCY_LICENSES.json', 'README.md', 'KNOWN_LIMITATIONS.md'];
const web = await archive(`opendraft-web-${version}`, [...dist, 'docs/STATIC_HOSTING.md', ...notices]);
const selfhost = await archive(`opendraft-selfhost-${version}`, [
  ...dist, ...(await files('apps/opendraft/src')), 'server/collab-server.mjs', 'package.json', 'package-lock.json',
  'docs/SELF_HOSTING.md', 'docs/COLLABORATION.md', ...notices,
]);

await rm(out, { recursive: true, force: true }); await mkdir(out, { recursive: true });
const outputs = { [`opendraft-web-${version}.zip`]: web, [`opendraft-selfhost-${version}.zip`]: selfhost };
const sums = [];
for (const [name, bytes] of Object.entries(outputs)) { await writeFile(path.join(out, name), bytes); sums.push(`${sha256(bytes)}  ${name}`); }
await writeFile(path.join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
const manifest = { name: 'OpenDraft', version, sourceDateEpoch: epoch, node: '>=24', distTreeSha256: sha256((await Promise.all(dist.sort().map(async file => `${sha256(await readFile(path.join(root, file)))}  ${file}`))).join('\n')), artifacts: sums.map(line => { const [hash, name] = line.split('  '); return { name, sha256: hash }; }) };
await writeFile(path.join(out, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(sums.join('\n'));
