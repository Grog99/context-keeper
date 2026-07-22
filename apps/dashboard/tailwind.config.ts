import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * Tokeny design-systemu (`context/design-system.md` §7.2), wklejone jako baza — kolory/radius/
 * fontFamily/fontSize czytają CSS variables z `globals.css`, więc jasny/ciemny motyw i toggle
 * użytkownika (`data-theme`) działają bez zmian tutaj. Dodatkowe klucze POZA §7.2 verbatim (`faint`,
 * `border.strong`, `input`, `ring`, `accent-subtle`) — niezbędne dla komponentów produktowych/shadcn,
 * które w makiecie (`design-system-mockup.html`) używają tych zmiennych wprost (np. focus ring,
 * obrys aktywny inputu).
 */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        surface: 'var(--surface)',
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        faint: 'var(--faint)',
        border: { DEFAULT: 'var(--border)', strong: 'var(--border-strong)' },
        input: 'var(--input)',
        ring: 'var(--ring)',
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          foreground: 'var(--primary-foreground)',
        },
        'accent-subtle': 'var(--accent-subtle)',
        success: { DEFAULT: 'var(--success)', subtle: 'var(--success-subtle)', foreground: 'var(--success-foreground)' },
        warning: { DEFAULT: 'var(--warning)', subtle: 'var(--warning-subtle)', foreground: 'var(--warning-foreground)' },
        danger: { DEFAULT: 'var(--danger)', subtle: 'var(--danger-subtle)', foreground: 'var(--danger-foreground)' },
        info: { DEFAULT: 'var(--info)', subtle: 'var(--info-subtle)', foreground: 'var(--info-foreground)' },
        neutral: { DEFAULT: 'var(--neutral)', subtle: 'var(--neutral-subtle)', foreground: 'var(--neutral-foreground)' },
      },
      borderRadius: { lg: '8px', md: '6px', sm: '4px' },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          '"SFMono-Regular"',
          '"Cascadia Code"',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        '2xs': ['11px', '16px'],
        xs: ['12px', '16px'],
        sm: ['13px', '18px'],
        base: ['14px', '20px'],
        md: ['15px', '24px'],
        lg: ['18px', '26px'],
        xl: ['22px', '30px'],
        '2xl': ['28px', '34px'],
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
