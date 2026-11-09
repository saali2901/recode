import type { ReactNode } from 'react';
import type { Route } from '../hooks';
import { ThemeSwitcher } from './ThemeSwitcher';

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const link = (href: string, label: string, active: boolean) => (
    <li>
      <a className="navbar__link" href={href} aria-current={active ? 'page' : undefined}>
        {label}
      </a>
    </li>
  );
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="navbar app-navbar">
        <a className="navbar__brand" href="#/">
          ReCode
        </a>
        <nav aria-label="Main" className="app-nav">
          <ul className="navbar__links">
            {link('#/', 'Projects', route.name === 'projects' || route.name === 'project')}
            {link('#/settings', 'Settings', route.name === 'settings')}
            {link('#/doctor', 'Doctor', route.name === 'doctor')}
          </ul>
        </nav>
        <div className="navbar__end">
          <ThemeSwitcher />
        </div>
      </header>
      <main id="main" className="container app-main">
        {children}
      </main>
    </>
  );
}
