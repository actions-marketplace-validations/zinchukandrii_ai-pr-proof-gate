import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { evaluate } from './evaluator';
import {
  autoManifestFromEvent,
  collectGitDiff,
  escapeWorkflowCommand,
  type GitRunner,
  loadProofGateConfig,
  parseGitDiff,
  parsePullRequestEvent,
  workflowAnnotation,
} from './github';

function eventPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'opened',
    number: 7,
    repository: { full_name: 'acme/project' },
    pull_request: {
      title: 'Safe title',
      base: { sha: 'a'.repeat(40), repo: { full_name: 'acme/project' } },
      head: { sha: 'b'.repeat(40), repo: { full_name: 'acme/project' } },
      user: { type: 'User', login: 'octocat' },
    },
    ...overrides,
  });
}

describe('GitHub pull-request event parsing', () => {
  it('accepts only the pull_request event and validates exact SHAs', () => {
    const event = parsePullRequestEvent(eventPayload(), 'pull_request');
    expect(event).toMatchObject({ number: 7, repository: 'acme/project', fork: false, authorType: 'human' });
    expect(() => parsePullRequestEvent(eventPayload(), 'push')).toThrow(/pull_request/);
    const raw = JSON.parse(eventPayload());
    raw.pull_request.head.sha = 'b'.repeat(39) + ';';
    expect(() => parsePullRequestEvent(JSON.stringify(raw), 'pull_request')).toThrow(/SHA/);
  });

  it('labels bot and fork metadata without rejecting safe fork evaluation', () => {
    const raw = JSON.parse(eventPayload());
    raw.pull_request.user = { type: 'Bot', login: 'renovate[bot]' };
    raw.pull_request.head.repo.full_name = 'fork-owner/project';
    const event = parsePullRequestEvent(JSON.stringify(raw), 'pull_request');
    expect(event).toMatchObject({ authorType: 'automation', fork: true });
    const manifest = autoManifestFromEvent(event, [], { declaredScope: ['**'], checks: [], evidence: [], riskFlags: [], approvals: [] });
    expect(manifest.repository).toBe('acme/project');
    expect(manifest.riskFlags).toContain('fork-pull-request');
  });
});

describe('git diff collection', () => {
  it('parses spaces, binary files, and NUL-delimited rename records', () => {
    const names = 'A\0src/with space.ts\0R100\0src/old.ts\0src/new-name.ts\0M\0assets/logo.png\0';
    const stats = '4\t1\tsrc/with space.ts\0' + '4\t2\t\0src/old.ts\0src/new-name.ts\0' + '-\t-\tassets/logo.png\0';
    expect(parseGitDiff(names, stats)).toEqual([
      { path: 'src/with space.ts', additions: 4, deletions: 1 },
      { path: 'src/new-name.ts', additions: 4, deletions: 2 },
      { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
    ]);
  });

  it('executes git with validated argv only and a merge-base range', () => {
    const event = parsePullRequestEvent(eventPayload(), 'pull_request');
    const runner = vi.fn<GitRunner>((_file, args, _options) =>
      args.includes('--name-status') ? 'A\0src/a.ts\0' : '1\t0\tsrc/a.ts\0',
    );
    expect(collectGitDiff(event, '/repo', runner)).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 0 }]);
    expect(runner).toHaveBeenCalledTimes(2);
    for (const [file, args, options] of runner.mock.calls) {
      expect(file).toBe('git');
      expect(args).toContain(`${'a'.repeat(40)}...${'b'.repeat(40)}`);
      expect(args).not.toContain(event.title);
      expect(options).toMatchObject({ cwd: '/repo', shell: false });
    }
  });
});

describe('repository config and evidence', () => {
  it('loads verified check evidence from a bounded workspace-relative file', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'proofgate-'));
    mkdirSync(join(workspace, '.proofgate-evidence'));
    writeFileSync(join(workspace, '.proofgate.json'), JSON.stringify({
      version: 1,
      declaredScope: ['src/**'],
      requiredChecks: [{ id: 'tests', evidenceFile: '.proofgate-evidence/tests.json' }],
    }));
    writeFileSync(join(workspace, '.proofgate-evidence/tests.json'), JSON.stringify({ status: 'pass', kind: 'test-report', summary: '25 tests passed' }));
    const config = loadProofGateConfig(workspace);
    expect(config.checks).toEqual([{ id: 'tests', status: 'pass', required: true, evidenceId: 'config-tests' }]);
    expect(config.evidence).toEqual([{ id: 'config-tests', kind: 'test-report', summary: '25 tests passed', artifactPath: '.proofgate-evidence/tests.json' }]);
    const event = parsePullRequestEvent(eventPayload(), 'pull_request');
    expect(evaluate(autoManifestFromEvent(event, [{ path: 'src/a.ts', additions: 1, deletions: 0 }], config)).decision).toBe('PASS');
  });

  it('fails closed when required evidence is missing and rejects traversal configuration', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'proofgate-'));
    writeFileSync(join(workspace, '.proofgate.json'), JSON.stringify({
      version: 1,
      declaredScope: ['src/**'],
      requiredChecks: [{ id: 'tests', evidenceFile: '.proofgate-evidence/missing.json' }],
    }));
    const config = loadProofGateConfig(workspace);
    const event = parsePullRequestEvent(eventPayload(), 'pull_request');
    const result = evaluate(autoManifestFromEvent(event, [{ path: 'src/a.ts', additions: 1, deletions: 0 }], config));
    expect(result.decision).toBe('BLOCKED');
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'PG005' })]));
    writeFileSync(join(workspace, '.proofgate.json'), JSON.stringify({ version: 1, declaredScope: ['src/**'], requiredChecks: [{ id: 'bad', evidenceFile: '../secret' }] }));
    expect(() => loadProofGateConfig(workspace)).toThrow(/evidenceFile/);
  });

  it('rejects evidence symlinks leaving the workspace and static approvals', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'proofgate-'));
    const outside = mkdtempSync(join(tmpdir(), 'proofgate-outside-'));
    writeFileSync(join(outside, 'evidence.json'), JSON.stringify({ status: 'pass', summary: 'outside' }));
    symlinkSync(join(outside, 'evidence.json'), join(workspace, 'linked-evidence.json'));
    writeFileSync(join(workspace, '.proofgate.json'), JSON.stringify({
      version: 1,
      requiredChecks: [{ id: 'tests', evidenceFile: 'linked-evidence.json' }],
    }));
    expect(() => loadProofGateConfig(workspace)).toThrow(/leaves workspace/);
    writeFileSync(join(workspace, '.proofgate.json'), JSON.stringify({ version: 1, approvals: [{ id: 'fake' }] }));
    expect(() => loadProofGateConfig(workspace)).toThrow(/Static approvals/);
  });
});

describe('workflow command safety', () => {
  it('escapes command and property metacharacters from untrusted text', () => {
    expect(escapeWorkflowCommand('a%b\r\n:c')).toBe('a%25b%0D%0A:c');
    expect(workflowAnnotation({ ruleId: 'PG001', decision: 'BLOCKED', message: 'bad\n::error::x', subject: 'src/a,b.ts' }))
      .toBe('::error file=src/a%2Cb.ts,title=PG001::bad%0A::error::x');
  });
});
