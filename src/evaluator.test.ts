import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, evaluate, jsonReceipt, markdownReceipt, parseManifest } from './evaluator';
import { fixtures, safeFixture } from './fixtures';

const encode = (value: unknown) => JSON.stringify(value);

describe('AI PR Proof Gate evaluator', () => {
  it('A1 returns PG008 PASS for a safe evidence contract', () => {
    const result = evaluate(parseManifest(encode(safeFixture)));
    expect(result.decision).toBe('PASS');
    expect(result.findings).toEqual([expect.objectContaining({ ruleId: 'PG008', decision: 'PASS' })]);
  });

  it.each([
    ['A2', fixtures.outOfScope, 'BLOCKED', 'PG001'],
    ['A3', fixtures.failedCheck, 'BLOCKED', 'PG002'],
    ['A4', fixtures.skippedCheck, 'REVIEW_REQUIRED', 'PG003'],
    ['A5', fixtures.riskyPath, 'REVIEW_REQUIRED', 'PG004'],
    ['A6', fixtures.missingEvidence, 'BLOCKED', 'PG005'],
    ['A8', fixtures.automated, 'REVIEW_REQUIRED', 'PG007'],
    ['PG006', fixtures.binaryChange, 'REVIEW_REQUIRED', 'PG006'],
  ])('%s produces %s with %s', (_id, fixture, decision, ruleId) => {
    const result = evaluate(fixture);
    expect(result.decision).toBe(decision);
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId }));
  });

  it('approved human review clears automation and risky-path review requirements', () => {
    expect(evaluate(fixtures.approvedAutomation).decision).toBe('PASS');
  });

  it.each([
    ['malformed JSON', '{'],
    ['unsupported version', encode({ ...safeFixture, version: '2' })],
    ['traversal path', encode({ ...safeFixture, changedFiles: [{ path: '../secret', additions: 1, deletions: 0 }] })],
    ['absolute path', encode({ ...safeFixture, changedFiles: [{ path: '/etc/passwd', additions: 1, deletions: 0 }] })],
    ['Windows path', encode({ ...safeFixture, changedFiles: [{ path: 'C:/secret', additions: 1, deletions: 0 }] })],
    ['unknown check status', encode({ ...safeFixture, checks: [{ id: 'x', status: 'wat', evidenceId: 'ev-tests' }] })],
    ['duplicate check IDs', encode({ ...safeFixture, checks: [safeFixture.checks[0], safeFixture.checks[0]] })],
    ['unsafe artifact path', encode({ ...safeFixture, evidence: [{ id: 'e', kind: 'test', summary: 'x', artifactPath: '../x' }] })],
  ])('A7 rejects %s', (_case, manifest) => {
    expect(() => parseManifest(manifest)).toThrow();
  });

  it('A7 rejects oversized input', () => {
    expect(() => parseManifest('x'.repeat(DEFAULT_POLICY.maxManifestCharacters + 1))).toThrow(/exceeds/);
  });

  it('required checks without an evidence reference fail closed', () => {
    const manifest = structuredClone(safeFixture);
    delete manifest.checks[0].evidenceId;
    const result = evaluate(manifest);
    expect(result.decision).toBe('BLOCKED');
    expect(result.findings).toContainEqual(expect.objectContaining({ ruleId: 'PG005' }));
  });

  it('non-required skipped checks do not block PASS', () => {
    const manifest = structuredClone(safeFixture);
    manifest.checks.push({ id: 'optional', status: 'skipped', required: false });
    expect(evaluate(manifest).decision).toBe('PASS');
  });

  it('receipts are stable, machine-readable, and contain no fabricated timestamp', () => {
    const result = evaluate(safeFixture);
    expect(JSON.parse(jsonReceipt(result)).decision).toBe('PASS');
    expect(markdownReceipt(result)).toContain('PG008');
    expect(jsonReceipt(result)).not.toMatch(/generatedAt|timestamp/i);
  });

  it('escapes untrusted repository and path text in Markdown receipts', () => {
    const manifest = structuredClone(safeFixture);
    manifest.repository = '<img src=x onerror=alert(1)>';
    manifest.declaredScope = ['safe/**'];
    manifest.changedFiles = [{ path: 'src/`bad`<x>.ts', additions: 1, deletions: 0 }];
    const markdown = markdownReceipt(evaluate(manifest));
    expect(markdown).not.toContain('<img');
    expect(markdown).not.toContain('<x>');
    expect(markdown).toContain('&lt;img');
    expect(markdown).toContain('&#96;');
  });
});
