/**
 * StrategyEvolutionService — the controller that closes the loop. Pure decision
 * logic over strategy stats; no DB needed (stubbed StrategyService).
 */
import { describe, expect, it, vi } from 'vitest';
import { StrategyEvolutionService, twoProportionZ, type EvolutionMode } from '../../src/services/app/strategyEvolution.js';
import type { StrategyRecord, StrategyService } from '../../src/services/app/strategyService.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as import('../../src/logger.js').Logger;

function strat(over: Partial<StrategyRecord>): StrategyRecord {
  const wins = over.wins ?? 0;
  const trials = over.trials ?? 0;
  return {
    id: over.key ?? 'id', appId: 'app1', key: over.key ?? 'k', hypothesis: over.hypothesis ?? 'h',
    experimentKey: over.experimentKey ?? 'exp', variant: over.variant ?? null, generation: 0, parentId: null,
    metric: null, status: over.status ?? 'active', wins, trials,
    winRate: trials > 0 ? wins / trials : 0, confidence: (wins + 1) / (trials + 2),
    createdAt: '', updatedAt: '',
  };
}

function serviceWith(list: StrategyRecord[]) {
  const promote = vi.fn(async (_ws: string, _app: string, key: string) => strat({ key, status: 'proven' }));
  const retire = vi.fn((_ws: string, _app: string, key: string) => strat({ key, status: 'retired' }));
  const strategies = { list: () => list, promote, retire } as unknown as Pick<StrategyService, 'list' | 'promote' | 'retire'>;
  return { svc: new StrategyEvolutionService({ strategies, logger }), promote, retire };
}

describe('twoProportionZ', () => {
  it('is ~0 for equal proportions and large for a strong lead', () => {
    expect(Math.abs(twoProportionZ(50, 100, 50, 100))).toBeLessThan(0.01);
    expect(twoProportionZ(80, 100, 40, 100)).toBeGreaterThan(1.96);
  });
});

describe('StrategyEvolutionService.evaluate', () => {
  it('insufficient_data below the min-trials floor', () => {
    const { svc } = serviceWith([strat({ key: 'a', wins: 3, trials: 5 }), strat({ key: 'b', wins: 1, trials: 5 })]);
    expect(svc.evaluate('ws', 'app1')[0]!.status).toBe('insufficient_data');
  });

  it('no_clear_winner when the lead is not significant', () => {
    const { svc } = serviceWith([strat({ key: 'a', wins: 52, trials: 100 }), strat({ key: 'b', wins: 50, trials: 100 })]);
    expect(svc.evaluate('ws', 'app1')[0]!.status).toBe('no_clear_winner');
  });

  it('declares a winner on a large, significant lead and marks losers to retire', () => {
    const { svc } = serviceWith([
      strat({ key: 'a', wins: 80, trials: 100 }),
      strat({ key: 'b', wins: 40, trials: 100 }),
    ]);
    const d = svc.evaluate('ws', 'app1')[0]!;
    expect(d.status).toBe('winner');
    expect(d.winnerKey).toBe('a');
    expect(d.retireKeys).toContain('b');
    expect(d.spawnFromKey).toBe('a');
  });

  it('act mode promotes the winner and retires losers; surface mode does nothing', async () => {
    const list = [strat({ key: 'a', wins: 80, trials: 100 }), strat({ key: 'b', wins: 40, trials: 100 })];
    const { svc, promote, retire } = serviceWith(list);
    const d = svc.evaluate('ws', 'app1')[0]!;
    const surfaced = await svc.apply('ws', d, 'surface' as EvolutionMode);
    expect(surfaced.applied).toBe(false);
    expect(promote).not.toHaveBeenCalled();
    const acted = await svc.apply('ws', d, 'act');
    expect(acted.applied).toBe(true);
    expect(promote).toHaveBeenCalledWith('ws', 'app1', 'a');
    expect(retire).toHaveBeenCalledWith('ws', 'app1', 'b');
  });
});
