/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#08090b',
        surface: '#0f1014',
        'surface-2': '#15171c',
        line: '#22262d',
        'text-primary': '#e8eaee',
        'text-muted': '#7a8390',
        accent: '#9cffb0',
        'accent-soft': '#9cffb01a',
        danger: '#ff7a7a',
        warn: '#f6c177',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px rgba(0,0,0,0.55)',
        glow: '0 0 0 1px rgba(156,255,176,0.4), 0 0 24px rgba(156,255,176,0.25)',
      },
      borderRadius: {
        node: '14px',
      },
    },
  },
  plugins: [],
};
