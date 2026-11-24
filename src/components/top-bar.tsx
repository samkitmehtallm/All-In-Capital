'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/*
 * A slim top bar rather than a sidebar (brief §13): five destinations do not justify
 * giving up 240px of a board that has four columns on it. On mobile the same five
 * become a bottom tab bar, where thumbs already are.
 */

const NAV = [
  { href: '/', label: 'Board' },
  { href: '/calibration', label: 'Calibration' },
  { href: '/corrections', label: 'Corrections' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/settings', label: 'Settings' },
] as const;

function useTheme() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('aic-theme', next ? 'dark' : 'light');
    } catch {
      // A browser blocking site data is not a reason to refuse to change theme;
      // it just will not be remembered next visit.
    }
  };

  return { dark, toggle };
}

export function TopBar() {
  const pathname = usePathname();
  const { dark, toggle } = useTheme();

  const isActive = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-[var(--color-hairline)] bg-[var(--color-paper)]/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-6 px-4 sm:px-6">
          <Link
            href="/"
            className="font-[family-name:var(--font-display)] text-[15px] font-semibold tracking-[-0.02em]"
          >
            All In Capital
          </Link>

          <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(item.href) ? 'page' : undefined}
                className={`motion-quick rounded-[10px] px-3 py-1.5 text-[13.5px] ${
                  isActive(item.href)
                    ? 'bg-[var(--color-card)] text-[var(--color-ink)] hairline'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="motion-quick hidden items-center gap-2 rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-card)] px-3 py-1.5 text-[13px] text-[var(--color-subtle)] hover:text-[var(--color-ink)] sm:flex"
              aria-label="Search applications"
            >
              Search
              <kbd className="num rounded border border-[var(--color-hairline)] px-1.5 py-0.5 text-[11px]">
                ⌘K
              </kbd>
            </button>

            <button
              type="button"
              onClick={toggle}
              aria-pressed={dark}
              aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
              className="motion-quick grid h-9 w-9 place-items-center rounded-[10px] border border-[var(--color-hairline)] bg-[var(--color-card)] text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            >
              {dark ? '☾' : '☀'}
            </button>

            <span
              className="grid h-9 w-9 place-items-center rounded-full border border-[var(--color-hairline)] bg-[var(--color-card)] text-[12px] font-medium text-[var(--color-muted)]"
              title="Not signed in"
              aria-label="Account: not signed in"
            >
              —
            </span>
          </div>
        </div>
      </header>

      {/* Mobile: the same five, as a bottom tab bar. 44px minimum touch target. */}
      <nav
        aria-label="Sections"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[var(--color-hairline)] bg-[var(--color-paper)]/95 backdrop-blur md:hidden"
      >
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive(item.href) ? 'page' : undefined}
            className={`flex min-h-[52px] flex-col items-center justify-center gap-0.5 text-[11px] ${
              isActive(item.href) ? 'text-[var(--color-cobalt)]' : 'text-[var(--color-muted)]'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
