import type { Manifest } from './evaluator';

export const safeFixture: Manifest = {
  version: '1',
  repository: 'example/maintainer-tool',
  pullRequestNumber: 42,
  title: 'Add deterministic parser coverage',
  declaredScope: ['src/**', 'tests/**'],
  changedFiles: [
    { path: 'src/parser.ts', additions: 38, deletions: 4 },
    { path: 'tests/parser.test.ts', additions: 64, deletions: 0 },
  ],
  checks: [
    { id: 'tests', status: 'pass', commandLabel: 'npm test', evidenceId: 'ev-tests' },
    { id: 'typecheck', status: 'pass', commandLabel: 'npm run typecheck', evidenceId: 'ev-types' },
  ],
  authorType: 'human',
  riskFlags: [],
  evidence: [
    { id: 'ev-tests', kind: 'test-report', summary: 'Behavior tests passed.' },
    { id: 'ev-types', kind: 'typecheck', summary: 'TypeScript completed without errors.' },
  ],
  approvals: [],
};

const clone = (): Manifest => structuredClone(safeFixture);

const outOfScope = clone();
outOfScope.changedFiles = [{ path: 'docs/release.md', additions: 4, deletions: 0 }];

const failedCheck = clone();
failedCheck.checks[0].status = 'fail';

const skippedCheck = clone();
skippedCheck.checks[0].status = 'skipped';

const riskyPath = clone();
riskyPath.declaredScope = ['.github/**'];
riskyPath.changedFiles = [{ path: '.github/workflows/release.yml', additions: 12, deletions: 1 }];

const missingEvidence = clone();
missingEvidence.checks[0].evidenceId = 'does-not-exist';

const automated = clone();
automated.authorType = 'automation';

const approvedAutomation = clone();
approvedAutomation.authorType = 'automation';
approvedAutomation.approvals = [{ id: 'approval-1', reviewer: 'maintainer', status: 'approved' }];

const binaryChange = clone();
binaryChange.changedFiles = [{ path: 'src/fixture.bin', additions: 0, deletions: 0, binary: true }];

export const fixtures: Record<string, Manifest> = {
  safe: safeFixture,
  outOfScope,
  failedCheck,
  skippedCheck,
  riskyPath,
  missingEvidence,
  automated,
  approvedAutomation,
  binaryChange,
};
