import { Outlet } from 'react-router-dom';
import TopBar from './TopBar';

/**
 * Application shell: a quiet top bar and the page on the warm canvas.
 * No sidebar; navigation inside workspaces is contextual (tabs).
 * Bottom padding on phones leaves room for the bottom navigation bar.
 */
export default function AppLayout() {
  return (
    <div className="min-h-screen bg-stone-50">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow-popover"
      >
        Skip to content
      </a>
      <TopBar />
      <main id="main-content" tabIndex={-1} className="pb-24 focus:outline-none md:pb-0">
        <Outlet />
      </main>
    </div>
  );
}
