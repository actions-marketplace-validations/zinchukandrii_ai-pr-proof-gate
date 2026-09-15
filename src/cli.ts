import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { evaluate, jsonReceipt, markdownReceipt, parseManifest } from './evaluator';
import { fixtures } from './fixtures';

interface CliOptions {
  input?: string;
  fixture?: string;
  jsonOut?: string;
  markdownOut?: string;
}

function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === '--fixture') options.fixture = args[++index];
    else if (current === '--json-out') options.jsonOut = args[++index];
    else if (current === '--markdown-out') options.markdownOut = args[++index];
    else if (!current.startsWith('--') && !options.input) options.input = current;
    else throw new Error(`Unknown or incomplete argument: ${current}`);
  }
  return options;
}

function writeExplicitOutput(path: string | undefined, content: string): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

export function runCli(args = process.argv.slice(2)): number {
  try {
    const options = parseArguments(args);
    let text: string;
    if (options.fixture) {
      const fixture = fixtures[options.fixture];
      if (!fixture) throw new Error(`Unknown fixture: ${options.fixture}`);
      text = JSON.stringify(fixture);
    } else if (options.input) {
      text = readFileSync(options.input, 'utf8');
    } else {
      throw new Error('Provide a manifest path or --fixture NAME');
    }

    const evaluation = evaluate(parseManifest(text));
    const json = jsonReceipt(evaluation);
    const markdown = markdownReceipt(evaluation);
    writeExplicitOutput(options.jsonOut, json);
    writeExplicitOutput(options.markdownOut, markdown);
    process.stdout.write(json);
    return evaluation.decision === 'PASS' ? 0 : evaluation.decision === 'REVIEW_REQUIRED' ? 10 : 20;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Invalid input'}\n`);
    return 2;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  process.exitCode = runCli();
}
