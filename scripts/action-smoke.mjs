import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const scratch = resolve(root, '.tmp/action-smoke');
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });

function runCase(name, manifest, expectedStatus, expectedDecision) {
  const caseDir = resolve(scratch, name);
  mkdirSync(caseDir, { recursive: true });
  const output = resolve(caseDir, 'github-output.txt');
  const summary = resolve(caseDir, 'summary.md');
  writeFileSync(output, '');
  writeFileSync(summary, '');

  const result = spawnSync(process.execPath, ['dist-action/index.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      INPUT_MANIFEST: manifest,
      'INPUT_REPORT-DIR': `.tmp/action-smoke/${name}/reports`,
    },
  });

  if (result.status !== expectedStatus) {
    throw new Error(`${name}: expected exit ${expectedStatus}, got ${result.status}\n${result.stderr || result.stdout}`);
  }
  const outputText = readFileSync(output, 'utf8');
  if (!outputText.includes(`decision=${expectedDecision}`)) {
    throw new Error(`${name}: missing decision output ${expectedDecision}`);
  }
  const reportPath = resolve(caseDir, 'reports/proofgate-report.json');
  if (!existsSync(reportPath)) throw new Error(`${name}: missing JSON receipt`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.decision !== expectedDecision || report.schemaVersion !== 'proofgate-evaluation/v1') {
    throw new Error(`${name}: invalid receipt`);
  }
}

runCase('safe', 'fixtures/safe.json', 0, 'PASS');
runCase('blocked', 'fixtures/blocked.json', 1, 'BLOCKED');

const outside = spawnSync(process.execPath, ['dist-action/index.js'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    GITHUB_WORKSPACE: root,
    INPUT_MANIFEST: '../outside.json',
    'INPUT_REPORT-DIR': '.tmp/action-smoke/outside/reports',
  },
});
if (outside.status !== 2 || !outside.stderr.includes('GITHUB_WORKSPACE')) {
  throw new Error(`outside-path case did not fail closed: ${outside.status}\n${outside.stderr}`);
}

process.stdout.write('ACTION_SMOKE_PASS safe=0 blocked=1 outside=2\n');
