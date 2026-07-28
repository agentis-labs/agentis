import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en';

export const LOCALE_STORAGE_KEY = 'agentis.locale';
export const supportedLocales = ['en', 'pt-BR'] as const;
export type SupportedLocale = (typeof supportedLocales)[number];

const resources = {
  en: { translation: en },
} as const;

export function isSupportedLocale(locale: string | undefined | null): locale is SupportedLocale {
  return Boolean(locale && supportedLocales.includes(locale as SupportedLocale));
}

export function normalizeLocale(locale: string | undefined | null): SupportedLocale {
  if (!locale) return 'en';
  if (isSupportedLocale(locale)) return locale;
  return locale.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

export async function setLocale(locale: SupportedLocale): Promise<void> {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  }
  await ensureLocaleResources(locale);
  await i18n.changeLanguage(locale);
}

function detectInitialLocale(): SupportedLocale {
  if (typeof window !== 'undefined') {
    return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY) ?? window.navigator.language);
  }
  return 'en';
}

async function ensureLocaleResources(locale: SupportedLocale): Promise<void> {
  if (locale !== 'pt-BR' || i18n.hasResourceBundle('pt-BR', 'translation')) return;
  const { default: ptBR } = await import('./locales/pt-BR');
  i18n.addResourceBundle('pt-BR', 'translation', ptBR, true, true);
}

export const initI18n = (async () => {
  const locale = detectInitialLocale();
  await ensureLocaleResources(locale);
  await i18n
    .use(initReactI18next)
    .init({
      lng: locale,
      resources,
      fallbackLng: 'en',
      supportedLngs: supportedLocales,
      load: 'currentOnly',
      ns: ['translation'],
      defaultNS: 'translation',
      interpolation: { escapeValue: false },
      returnNull: false,
    });
})();

function syncDocumentLocale(locale: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = normalizeLocale(locale);
  document.documentElement.dir = 'ltr';
}

i18n.on('languageChanged', syncDocumentLocale);
syncDocumentLocale(i18n.resolvedLanguage ?? i18n.language);

export default i18n;
