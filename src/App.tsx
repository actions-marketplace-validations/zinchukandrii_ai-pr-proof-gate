import { useEffect, useMemo, useState } from 'react';
import { evaluate, jsonReceipt, markdownReceipt, parseManifest, type Evaluation } from './evaluator';
import { fixtures, safeFixture } from './fixtures';

const STORAGE_KEY = 'ai-pr-proof-gate:draft:v1';

function saveDownload(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const safeText = useMemo(() => JSON.stringify(safeFixture, null, 2), []);
  const [text, setText] = useState(() => localStorage.getItem(STORAGE_KEY) ?? safeText);
  const [result, setResult] = useState<Evaluation | null>(null);
  const [error, setError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, text);
  }, [text]);

  function selectFixture(name: string): void {
    const fixture = fixtures[name];
    if (!fixture) return;
    setText(JSON.stringify(fixture, null, 2));
    setResult(null);
    setError('');
    setCopyNotice('');
  }

  function runEvaluation(): void {
    try {
      const next = evaluate(parseManifest(text));
      setResult(next);
      setError('');
      setCopyNotice('');
    } catch (caught) {
      setResult(null);
      setCopyNotice('');
      setError(caught instanceof Error ? caught.message : 'Invalid input');
    }
  }

  function reset(): void {
    localStorage.removeItem(STORAGE_KEY);
    setText(safeText);
    setResult(null);
    setError('');
    setCopyNotice('');
  }

  async function copyReceipt(): Promise<void> {
    if (!result) return;
    await navigator.clipboard.writeText(markdownReceipt(result));
    setCopyNotice('Markdown receipt copied.');
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">LOCAL · DETERMINISTIC · FAIL-CLOSED</p>
          <h1>AI PR Proof Gate</h1>
          <p className="subtitle">Evidence-contract validation before a maintainer merges human or AI-generated changes.</p>
        </div>
        <button className="secondary" type="button" onClick={reset}>Reset safe fixture</button>
      </header>

      <section className="journey" aria-label="Evidence trace">
        <span>Manifest</span><i aria-hidden="true" /><span>Rules PG001–PG008</span><i aria-hidden="true" /><span>Decision</span><i aria-hidden="true" /><span>Receipt</span>
      </section>

      <section className="toolbar" aria-label="Evaluation controls">
        <label htmlFor="fixture">Fixture</label>
        <select id="fixture" defaultValue="safe" onChange={(event) => selectFixture(event.target.value)}>
          {Object.keys(fixtures).map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button className="primary" type="button" onClick={runEvaluation}>Run proof gate</button>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-heading"><h2>Evidence manifest</h2><span>{text.length.toLocaleString()} chars</span></div>
          <label className="sr-only" htmlFor="manifest">Pull-request evidence manifest JSON</label>
          <textarea id="manifest" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
          {error && <div className="error" role="alert"><strong>Input rejected</strong><span>{error}</span></div>}
        </div>

        <div className="panel result-panel" aria-live="polite">
          <div className="panel-heading"><h2>Decision receipt</h2>{result && <span>proofgate-evaluation/v1</span>}</div>
          {!result ? (
            <div className="empty"><strong>No decision yet</strong><p>Run the proof gate. Parser errors clear any previous decision so a stale PASS cannot survive.</p></div>
          ) : (
            <>
              <div className={`decision ${result.decision.toLowerCase()}`} data-testid="decision">
                <span>DECISION</span><strong>{result.decision}</strong>
              </div>
              <ol className="findings">
                {result.findings.map((finding, index) => (
                  <li key={`${finding.ruleId}-${finding.subject ?? index}`}>
                    <code>{finding.ruleId}</code>
                    <div><strong>{finding.decision}</strong><p>{finding.message}</p>{finding.subject && <small>{finding.subject}</small>}</div>
                  </li>
                ))}
              </ol>
              <div className="receipt-actions">
                <button type="button" onClick={copyReceipt}>Copy Markdown</button>
                <button type="button" onClick={() => saveDownload('proofgate-report.json', jsonReceipt(result), 'application/json')}>Download JSON</button>
                <button type="button" onClick={() => saveDownload('proofgate-report.md', markdownReceipt(result), 'text/markdown')}>Download Markdown</button>
              </div>
              {copyNotice && <p className="notice" role="status">{copyNotice}</p>}
            </>
          )}
        </div>
      </section>

      <footer>Runs locally. No repository token, network request, runtime AI, or automatic merge.</footer>
    </main>
  );
}
