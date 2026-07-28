import i18n from './index';

function locale(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? 'en';
}

export function formatDate(
  value: Date | number | string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat(locale(), options).format(new Date(value));
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale(), options).format(value);
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options: Intl.RelativeTimeFormatOptions = { numeric: 'auto' },
): string {
  return new Intl.RelativeTimeFormat(locale(), options).format(value, unit);
}

export function formatList(
  values: readonly string[],
  options: Intl.ListFormatOptions = { style: 'long', type: 'conjunction' },
): string {
  return new Intl.ListFormat(locale(), options).format(values);
}
