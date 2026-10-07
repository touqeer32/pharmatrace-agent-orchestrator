import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { redact } from './redact';

export async function appendModelTrace(
  runId: string,
  event: Record<string, unknown>,
): Promise<void> {
  if (process.env.MODEL_TRACE_ENABLED !== 'true') return;

  const directory = process.env.MODEL_TRACE_DIR ?? 'logs/model-traces';
  const file = join(directory, `${runId}.json`);
  await mkdir(dirname(file), { recursive: true });
  let trace: { runId: string; events: Array<Record<string, unknown>> } = { runId, events: [] };
  try {
    trace = JSON.parse(await readFile(file, 'utf8')) as typeof trace;
  } catch {
    // First event for this run.
  }
  trace.events.push(redact({ ...event, recordedAt: new Date().toISOString() }) as Record<string, unknown>);
  await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
}
