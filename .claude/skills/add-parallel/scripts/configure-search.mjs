import fs from 'node:fs';
import path from 'node:path';

const [group, provider, ...extra] = process.argv.slice(2);
if (
  extra.length ||
  !group ||
  !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(group) ||
  !['parallel', 'native', 'disabled'].includes(provider)
) {
  console.error(
    'Usage: node configure-search.mjs GROUP parallel|native|disabled',
  );
  process.exit(1);
}
const dir = path.join('data', 'sessions', group, '.claude');
const file = path.join(dir, 'nanoclaw-search.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Expected an object in ${file}`);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ ...config, provider }, null, 2) + '\n');
console.log(
  `Saved ${provider} web search for ${group}. Applies to the next query.`,
);
