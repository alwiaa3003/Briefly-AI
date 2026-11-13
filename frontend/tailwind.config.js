/** @type {import('tailwindcss').Config} */

/*
 * Briefly design tokens (light theme only).
 *
 * `stone` is re-tuned to warm editorial neutrals and `brand` is a restrained
 * terracotta, so every existing `stone-*` / `brand-*` class across the app picks
 * up the same palette. Use stone for text, surfaces and lines; reserve brand for
 * small accents (active navigation marker, links, focus ring, selected states).
 *
 *   canvas   stone-50   #F7F5F0   app background
 *   wash     stone-100  #F1EEE7   quiet fills (chips, user messages)
 *   line     stone-200  #E7E3DA   thin dividers
 *   muted    stone-500  #827D73   secondary text
 *   ink      stone-900  #292824   primary text, primary buttons
 *   accent   brand-500  #A8755C   muted terracotta, used sparingly
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        serif: ['Newsreader', 'ui-serif', 'Georgia', 'Cambria', 'serif'],
      },
      colors: {
        // Warm editorial neutrals (Editorial Reading Studio).
        stone: {
          50: '#F7F5F0',
          100: '#F1EEE7',
          150: '#ECE8E0',
          200: '#E7E3DA',
          300: '#D6D1C6',
          400: '#8A8478',
          500: '#5F5B54',
          600: '#514E48',
          700: '#45423C',
          800: '#36342F',
          900: '#242421',
          950: '#1C1B18',
        },
        // Muted terracotta accent (#A8755C at 500).
        brand: {
          50: '#FAF4F0',
          100: '#F3E6DE',
          200: '#E6CBBC',
          300: '#D3A993',
          400: '#BE8D74',
          500: '#A8755C',
          600: '#93634C',
          700: '#7A513E',
          800: '#634234',
          900: '#4F352B',
        },
        surface: '#FFFFFF',
        // Input placeholders: lighter than muted text (#5F5B54) so they never read as entered values.
        placeholder: '#716D65',
      },
      boxShadow: {
        // Deliberately faint: hierarchy comes from spacing and type, not elevation.
        card: '0 1px 2px 0 rgb(36 36 33 / 0.03)',
        popover: '0 8px 24px -6px rgb(36 36 33 / 0.12), 0 2px 6px -2px rgb(36 36 33 / 0.06)',
        panel: '0 0 0 1px rgb(233 230 223 / 1), 0 1px 3px 0 rgb(36 36 33 / 0.03)',
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        reading: ['1.0625rem', { lineHeight: '1.8' }],
      },
      maxWidth: {
        reading: '44rem',
        page: '76rem',
        prose: '40rem',
      },
      transitionTimingFunction: {
        calm: 'cubic-bezier(0.2, 0, 0, 1)',
      },
    },
  },
  plugins: [],
};
