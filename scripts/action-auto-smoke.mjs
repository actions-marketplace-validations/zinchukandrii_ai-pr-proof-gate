import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const project = process.cwd();
const root = resolve(project, '.tmp/action-auto-smoke');
rmSync(root, { recursive: true, force: true });
mkdirSync(resolve(root, 'src'), { recursive: true });
mkdirSync(resolve(root, 'assets'), { recursive: true });

function run(file, args, options = {}) {
  return spawnSync(file, args, { cwd: root, encoding: 'utf8', ...options });
}

function mustRun(file, args) {
  const result = run(file, args);
  if (result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

mustRun('git', ['init', '-b', 'main']);
mustRun('git', ['config', 'user.name', 'Proof Gate Test']);
mustRun('git', ['config', 'user.email', 'proofgate@example.invalid']);
writeFileSync(resolve(root, 'src/example.ts'), Array.from({ length: 20 }, (_, index) => `export const value${index} = ${index};`).join('\n') + '\n');
mustRun('git', ['add', '.']);
mustRun('git', ['commit', '-m', 'base']);
const baseSha = mustRun('git', ['rev-parse', 'HEAD']);
mustRun('git', ['mv', 'src/example.ts', 'src/renamed-example.ts']);
writeFileSync(resolve(root, 'src/renamed-example.ts'), readFileSync(resolve(root, 'src/renamed-example.ts'), 'utf8') + 'export const added = true;\n');
writeFileSync(resolve(root, 'assets/logo.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
mustRun('git', ['add', '.']);
mustRun('git', ['commit', '-m', 'head']);
const headSha = mustRun('git', ['rev-parse', 'HEAD']);

writeFileSync(resolve(root, '.proofgate.json'), JSON.stringify({ version: 1, declaredScope: ['src/**', 'assets/**'] }));
writeFileSync(resolve(root, 'event.json'), JSON.stringify({
  action: 'synchronize',
  number: 9,
  repository: { full_name: 'acme/project' },
  pull_request: {
    title: 'Safe title\n::error::must-not-run',
    base: { sha: baseSha, repo: { full_name: 'acme/project' } },
    head: { sha: headSha, repo: { full_name: 'fork-owner/project' } },
    user: { type: 'Bot', login: 'renovate[bot]' },
  },
}));

const baseEnvironment = {
  ...process.env,
  INPUT_MODE: 'auto',
  INPUT_CONFIG: '.proofgate.json',
  'INPUT_REPORT-DIR': '.proofgate',
  GITHUB_WORKSPACE: root,
  GITHUB_EVENT_PATH: resolve(root, 'event.json'),
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_OUTPUT: resolve(root, 'github-output.txt'),
  GITHUB_STEP_SUMMARY: resolve(root, 'summary.md'),
};

const action = resolve(project, 'dist-action/index.js');
const valid = spawnSync('node', [action], { cwd: root, env: baseEnvironment, encoding: 'utf8' });
if (valid.status !== 1) throw new Error(`Expected REVIEW_REQUIRED exit 1 for bot fork, received ${valid.status}: ${valid.stderr}`);
const manifest = JSON.parse(readFileSync(resolve(root, '.proofgate/proofgate-manifest.json'), 'utf8'));
if (manifest.changedFiles.length !== 2) throw new Error(`Expected two generated changed files, received ${manifest.changedFiles.length}`);
if (!manifest.changedFiles.some((item) => item.path === 'src/renamed-example.ts')) throw new Error('Generated manifest did not preserve the rename target');
if (!manifest.changedFiles.some((item) => item.path === 'assets/logo.bin' && item.binary === true)) throw new Error('Generated manifest did not preserve the binary file');
if (manifest.authorType !== 'automation' || manifest.title !== 'Safe title\n::error::must-not-run') throw new Error('Event metadata was not preserved as inert data');
if (!manifest.riskFlags.includes('fork-pull-request')) throw new Error('Fork metadata was not preserved as a risk flag');
const receipt = JSON.parse(readFileSync(resolve(root, '.proofgate/proofgate-report.json'), 'utf8'));
if (receipt.decision !== 'REVIEW_REQUIRED' || !receipt.findings.some((item) => item.ruleId === 'PG007')) throw new Error('Expected PG007 review decision');
if (valid.stdout.includes('must-not-run')) throw new Error('Untrusted PR title reached workflow command output');
if (!readFileSync(resolve(root, 'github-output.txt'), 'utf8').includes('manifest-json=.proofgate/proofgate-manifest.json')) throw new Error('Generated manifest output missing');

const wrongEvent = spawnSync('node', [action], {
  cwd: root,
  env: { ...baseEnvironment, GITHUB_EVENT_NAME: 'push', 'INPUT_REPORT-DIR': '.proofgate-invalid' },
  encoding: 'utf8',
});
if (wrongEvent.status !== 2 || !wrongEvent.stderr.includes('only pull_request')) throw new Error('Non-PR event did not fail closed');

console.log('ACTION_AUTO_SMOKE_PASS diff=2 rename=target binary=true fork=accepted-as-data bot=PG007 push=exit2');
