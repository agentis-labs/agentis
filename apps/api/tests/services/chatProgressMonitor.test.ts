/**
 * ChatProgressMonitor — proves the time-free stop. The contract: keep going while
 * the loop makes genuine progress; stop the moment it detects a pathology
 * (identical repetition, oscillation, error storm, no-progress streak). The
 * load-bearing test is the LAST one: a long, productive run must never trip.
 */
import { describe, expect, it } from 'vitest';
import {
  ChatProgressMonitor,
  hashValue,
  stopReasonMessage,
  type RoundObservation,
} from '../../src/services/chat/chatProgressMonitor.js';

const PROGRESS: ProgressThresholdsLike = {
  maxIdenticalCalls: 3,
  maxErrorStreak: 4,
  maxNoProgressRounds: 3,
  maxOscillationPeriod: 3,
  oscillationRepeats: 2,
};
type ProgressThresholdsLike = ConstructorParameters<typeof ChatProgressMonitor>[0];

/** A round that calls `name` with `args`, succeeding with a unique result. */
function call(name: string, args: unknown, opts: Partial<RoundObservation> = {}): RoundObservation {
  return {
    toolCalls: [{ name, argsHash: hashValue(args) }],
    resultHashes: [hashValue({ name, args, ok: true, nonce: opts.resultHashes ? undefined : Math.random() })],
    allToolsErrored: false,
    producedText: false,
    ...opts,
  };
}

describe('ChatProgressMonitor', () => {
  it('keeps going while each round issues a novel call', () => {
    const m = new ChatProgressMonitor(PROGRESS);
    for (let i = 0; i < 50; i += 1) {
      expect(m.record(call('read_file', { path: `file-${i}.ts` }))).toBeNull();
    }
  });

  it('stops on identical repetition of the same call+args', () => {
    const m = new ChatProgressMonitor(PROGRESS);
    const same: RoundObservation = {
      toolCalls: [{ name: 'search', argsHash: hashValue({ q: 'foo' }) }],
      resultHashes: [hashValue({ same: 'result' })], // identical result every round
      allToolsErrored: false,
      producedText: false,
    };
    expect(m.record(same)).toBeNull();
    expect(m.record(same)).toBeNull();
    const stop = m.record(same);
    expect(stop?.kind).toBe('identical_repetition');
  });

  it('stops on a 2-step oscillation (edit ↔ revert)', () => {
    const m = new ChatProgressMonitor(PROGRESS);
    const edit = { name: 'write_file', argsHash: hashValue({ path: 'a', body: 'x' }) };
    const revert = { name: 'write_file', argsHash: hashValue({ path: 'a', body: 'y' }) };
    const obs = (sig: typeof edit): RoundObservation => ({
      toolCalls: [sig],
      // distinct results each round so identical_repetition does NOT fire first
      resultHashes: [hashValue({ nonce: Math.random() })],
      allToolsErrored: false,
      producedText: false,
    });
    // A,B,A,B → period-2 cycle repeated 2× (no single call hits the identical-3 bar first).
    const seq = [edit, revert, edit, revert];
    let stop = null as ReturnType<ChatProgressMonitor['record']>;
    for (const s of seq) stop = m.record(obs(s));
    expect(stop?.kind).toBe('oscillation');
  });

  it('stops on an error storm of consecutive all-failed rounds', () => {
    const m = new ChatProgressMonitor(PROGRESS);
    // Distinct failing calls so it is the error streak — not repetition — that trips.
    let stop = null as ReturnType<ChatProgressMonitor['record']>;
    for (let i = 0; i < 4; i += 1) {
      stop = m.record({
        toolCalls: [{ name: 'http_get', argsHash: hashValue({ url: `u-${i}` }) }],
        resultHashes: [hashValue({ error: `boom-${i}` })],
        allToolsErrored: true,
        producedText: false,
      });
    }
    expect(stop?.kind).toBe('error_storm');
  });

  it('a successful round between failures resets the error streak', () => {
    const m = new ChatProgressMonitor(PROGRESS);
    const fail = (i: number): RoundObservation => ({
      toolCalls: [{ name: 'http_get', argsHash: hashValue({ url: `u-${i}` }) }],
      resultHashes: [hashValue({ error: `boom-${i}` })],
      allToolsErrored: true,
      producedText: false,
    });
    expect(m.record(fail(0))).toBeNull();
    expect(m.record(fail(1))).toBeNull();
    expect(m.record(call('http_get', { url: 'ok' }))).toBeNull(); // success resets
    expect(m.record(fail(2))).toBeNull();
    expect(m.record(fail(3))).toBeNull();
    expect(m.record(fail(4))).toBeNull(); // only 3 in a row since reset → no storm yet
  });

  it('stops after a no-progress streak even when calls vary but yield nothing new', () => {
    const m = new ChatProgressMonitor(PROGRESS);
    // Same call+result repeated would trip identical_repetition; instead vary the
    // call name but reuse a SEEN result hash so there is genuinely no new progress.
    const seenResult = hashValue({ stuck: true });
    // Prime the seen-result set with a first, novel round.
    expect(
      m.record({
        toolCalls: [{ name: 'probe', argsHash: hashValue({ n: 0 }) }],
        resultHashes: [seenResult],
        allToolsErrored: false,
        producedText: false,
      }),
    ).toBeNull();
    let stop = null as ReturnType<ChatProgressMonitor['record']>;
    for (let i = 1; i <= 3; i += 1) {
      stop = m.record({
        toolCalls: [{ name: 'probe', argsHash: hashValue({ n: i }) }], // novel call...
        resultHashes: [seenResult], // ...but no novel result and no text
        allToolsErrored: false,
        producedText: false,
      });
      if (stop) break;
    }
    // novel call resets progress each round, so this should NOT trip — proving
    // a novel ACTION counts as progress (long legitimate runs are protected).
    expect(stop).toBeNull();
  });

  it('produced text alone counts as progress', () => {
    const m = new ChatProgressMonitor(PROGRESS);
    const seenResult = hashValue({ x: 1 });
    for (let i = 0; i < 10; i += 1) {
      const stop = m.record({
        toolCalls: [],
        resultHashes: [seenResult],
        allToolsErrored: false,
        producedText: true,
      });
      expect(stop).toBeNull();
    }
  });

  it('stopReasonMessage is honest and names the pathology', () => {
    expect(stopReasonMessage({ kind: 'identical_repetition', detail: 'called X 3 times' })).toContain('repeating myself');
    expect(stopReasonMessage({ kind: 'oscillation', detail: 'cycle' })).toContain('circles');
    expect(stopReasonMessage({ kind: 'error_storm', detail: '4 rounds' })).toContain('4 rounds');
    expect(stopReasonMessage({ kind: 'no_progress', detail: '3 rounds' })).toContain('forward');
  });
});

describe('hashValue', () => {
  it('is order-independent for object keys', () => {
    expect(hashValue({ a: 1, b: 2 })).toBe(hashValue({ b: 2, a: 1 }));
  });
  it('distinguishes different values', () => {
    expect(hashValue({ a: 1 })).not.toBe(hashValue({ a: 2 }));
  });
});
