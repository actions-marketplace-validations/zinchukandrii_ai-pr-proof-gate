import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { evaluate, jsonReceipt, markdownReceipt, parseManifest, type Evaluation } from './evaluator';
import {
  autoManifestFromEvent,
  collectGitDiff,
  loadProofGateConfig,
  parsePullRequestEvent,
  workflowAnnotation,
} from './github';

function assertInsideRoot(root: string, candidate: string, label: string): void {
  const relation = relative(root, candidate);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} leaves GITHUB_WORKSPACE`);
  }
}

function insideWorkspace(workspace: string, candidate: string): string {
  const root = realpathSync(workspace);
  const absolute = resolve(root, candidate);
  assertInsideRoot(root, absolute, `Path ${candidate}`);

  let existingAncestor = absolute;
  while (!existsSync(existingAncestor) && dirname(existingAncestor) !== existingAncestor) {
    existingAncestor = dirname(existingAncestor);
  }
  assertInsideRoot(root, realpathSync(existingAncestor), `Resolved path ${candidate}`);
  if (existsSync(absolute)) assertInsideRoot(root, realpathSync(absolute), `Resolved path ${candidate}`);
  return absolute;
}

function ensureOutputDirectory(workspace: string, candidate: string): string {
  const directory = insideWorkspace(workspace, candidate);
  mkdirSync(directory, { recursive: true });
  return insideWorkspace(workspace, candidate);
}

function appendTrustedFile(path: string | undefined, value: string): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, value, 'utf8');
}

function manualEvaluation(workspace: string, manifestInput: string): Evaluation {
  const manifestPath = insideWorkspace(workspace, manifestInput);
  const stats = statSync(manifestPath);
  if (!stats.isFile()) throw new Error('Manifest path must be a regular file');
  return evaluate(parseManifest(readFileSync(manifestPath, 'utf8')));
}

function automaticEvaluation(
  workspace: string,
  reportDirectory: string,
  environment: NodeJS.ProcessEnv,
): Evaluation {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required in auto mode');
  const eventStats = statSync(eventPath);
  if (!eventStats.isFile() || eventStats.size > 2 * 1024 * 1024) throw new Error('Invalid GITHUB_EVENT_PATH file');

  const event = parsePullRequestEvent(
    readFileSync(eventPath, 'utf8'),
    environment.GITHUB_EVENT_NAME ?? '',
  );
  const configInput = environment.INPUT_CONFIG || '.proofgate.json';
  const config = loadProofGateConfig(workspace, configInput);
  const manifest = autoManifestFromEvent(event, collectGitDiff(event, workspace), config);
  writeFileSync(
    resolve(reportDirectory, 'proofgate-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return evaluate(manifest);
}

export function runAction(environment: NodeJS.ProcessEnv = process.env): number {
  try {
    const workspace = environment.GITHUB_WORKSPACE || process.cwd();
    const reportInput = environment['INPUT_REPORT-DIR'] || '.proofgate';
    const reportDirectory = ensureOutputDirectory(workspace, reportInput);
    const manifestInput = environment.INPUT_MANIFEST || 'proofgate-manifest.json';
    const autoMode = environment.INPUT_MODE === 'auto' || manifestInput === 'auto';

    const evaluation = autoMode
      ? automaticEvaluation(workspace, reportDirectory, environment)
      : manualEvaluation(workspace, manifestInput);

    const jsonPath = resolve(reportDirectory, 'proofgate-report.json');
    const markdownPath = resolve(reportDirectory, 'proofgate-report.md');
    const json = jsonReceipt(evaluation);
    const markdown = markdownReceipt(evaluation);
    writeFileSync(jsonPath, json, 'utf8');
    writeFileSync(markdownPath, markdown, 'utf8');

    for (const finding of evaluation.findings) {
      process.stdout.write(`${workflowAnnotation(finding)}\n`);
    }
    appendTrustedFile(
      environment.GITHUB_OUTPUT,
      [
        `decision=${evaluation.decision}`,
        `report-json=${relative(workspace, jsonPath)}`,
        autoMode ? `manifest-json=${relative(workspace, resolve(reportDirectory, 'proofgate-manifest.json'))}` : 'manifest-json=',
        '',
      ].join('\n'),
    );
    appendTrustedFile(environment.GITHUB_STEP_SUMMARY, markdown);
    process.stdout.write(`AI PR Proof Gate: ${evaluation.decision}\n`);
    return evaluation.decision === 'PASS' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`AI PR Proof Gate failed closed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    return 2;
  }
}

process.exitCode = runAction();
