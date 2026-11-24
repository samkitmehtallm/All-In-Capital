import type { Metadata } from 'next';
import { Geist, JetBrains_Mono, Schibsted_Grotesk } from 'next/font/google';

import { TopBar } from '../components/top-bar';
import './globals.css';

/*
 * Schibsted Grotesk for headings, Geist for body, JetBrains Mono for every number.
 * Never Inter, Roboto or Arial (brief §13). Each has a real fallback stack in the
 * token definitions, so a blocked font request degrades rather than reflows.
 */
const schibsted = Schibsted_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-schibsted',
  display: 'swap',
});

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'All In Capital',
  description: 'Inbound triage for a pre-seed fund.',
};

/**
 * Applied before paint so the first frame is already in the right theme.
 * Without it a dark-mode user gets a white flash on every navigation.
 */
const THEME_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('aic-theme');
    var dark = stored ? stored === 'dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className={`${schibsted.variable} ${geist.variable} ${jetbrains.variable}`}>
        {/* Keyboard users reach the board without tabbing the whole top bar. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[10px] focus:bg-[var(--color-signal)] focus:px-4 focus:py-2 focus:text-white"
        >
          Skip to content
        </a>
        <TopBar />
        <main id="main" className="mx-auto w-full max-w-[1400px] px-4 pb-20 pt-6 sm:px-6">
          {children}
        </main>
      </body>
    </html>
  );
}
