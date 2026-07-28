import { afterEach, describe, expect, it } from 'vitest';
import i18n, { normalizeLocale, setLocale, supportedLocales } from '../src/i18n';
import en from '../src/i18n/locales/en';
import ptBR from '../src/i18n/locales/pt-BR';
import { formatNumber } from '../src/i18n/format';
import { apiErrorMessage } from '../src/lib/api';

function leafPaths(value: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child && typeof child === 'object'
      ? leafPaths(child as Record<string, unknown>, path)
      : [path];
  });
}

describe('Agentis localization', () => {
  afterEach(async () => {
    await setLocale('en');
  });

  it('supports only the published locales and normalizes browser variants', () => {
    expect(supportedLocales).toEqual(['en', 'pt-BR']);
    expect(normalizeLocale('pt')).toBe('pt-BR');
    expect(normalizeLocale('pt-PT')).toBe('pt-BR');
    expect(normalizeLocale('en-GB')).toBe('en');
    expect(normalizeLocale('de')).toBe('en');
  });

  it('keeps every supported locale structurally complete', () => {
    expect(leafPaths(ptBR)).toEqual(leafPaths(en));
  });

  it('updates formatting and stable API-error summaries with the selected locale', async () => {
    await setLocale('pt-BR');

    expect(formatNumber(12345.6)).toBe('12.345,6');
    expect(apiErrorMessage({ code: 'AUTH_FORBIDDEN', message: 'forbidden' })).toBe(
      'Você não tem permissão para executar esta ação. (AUTH_FORBIDDEN)',
    );
    expect(i18n.language).toBe('pt-BR');
  });
});
