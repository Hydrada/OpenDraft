import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const reviewed = JSON.parse(await readFile('docs/research/LICENSE_OVERRIDES.json', 'utf8'));
const entries = [];
for (const [relative, info] of Object.entries(lock.packages)) {
  if (!relative.includes('node_modules/') || info.dev || info.link) continue;
  let pkg;
  try { pkg = JSON.parse(await readFile(path.join(relative, 'package.json'), 'utf8')); }
  catch { continue; } // Optional packages for other platforms are not installed.
  const files = (await readdir(relative)).filter(name => /^(license|licence|notice|copying)(\.|$)/i.test(name));
  let license = pkg.license ?? info.license ?? 'UNKNOWN';
  let licenseEvidence;
  const review = reviewed[`${pkg.name}@${pkg.version}`];
  if (license === 'UNKNOWN' && review) {
    const bytes = await readFile(path.join(relative, review.file));
    if (createHash('sha256').update(bytes).digest('hex') !== review.sha256) throw new Error(`Reviewed license hash mismatch for ${pkg.name}@${pkg.version}.`);
    license = review.license; licenseEvidence = review;
  }
  entries.push({name:pkg.name,version:pkg.version,license,path:relative,licenseFiles:files.map(name => `${relative}/${name}`),...(licenseEvidence ? {licenseEvidence} : {})});
}
entries.sort((a,b) => a.name.localeCompare(b.name));
await mkdir('docs/generated', {recursive:true});
await writeFile('docs/generated/DEPENDENCY_LICENSES.json', JSON.stringify({generatedAt:new Date().toISOString(),scope:'Installed production npm packages, including installed optional dependencies. Metadata inventory only; bundled third-party notices require separate review.',packages:entries}, null, 2) + '\n');
console.log(`Inventoried ${entries.length} installed runtime packages. Unknown licenses: ${entries.filter(item=>item.license==='UNKNOWN').length}.`);
if (entries.some(item=>item.license==='UNKNOWN')) process.exitCode=1;
