# Agentis UI localization

Agentis uses `i18next` only for product-owned web UI. English (`en`) is the canonical resource and every supported locale must preserve its complete key shape.

Do localize interface text: navigation, controls, empty states, dialogs, toasts, and client-rendered descriptions of stable API error codes. Do not localize operator input, agent output, workflow names or descriptions, code, logs, connector payloads, or server diagnostic text.

Use a feature path for every key (`settings.language.title`), interpolate values (`t('confirm.typeToConfirm', { value })`), and prefer `Intl` helpers from `src/i18n/format.ts` for dates, quantities, relative time, and lists. New UI strings require English and Brazilian Portuguese entries in the same change.
