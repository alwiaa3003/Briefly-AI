import { Link, useLocation } from 'react-router-dom';
import Logo from '../common/Logo';
import SearchAction from './SearchAction';
import UserMenu from './UserMenu';
import { PRIMARY_NAV } from './navigation';
import { cn } from '../../utils/cn';

/**
 * Editorial top bar: brand (left), compact primary navigation, search + profile (right).
 * On phones the same <nav> becomes a fixed bottom bar, so there is a single main navigation.
 */
export default function TopBar() {
  const location = useLocation();
  return (
    <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-stone-50">
      <div className="mx-auto flex h-16 max-w-page items-center gap-8 px-5 sm:px-8 lg:px-12">
        <Link to="/" aria-label="Briefly home" className="shrink-0 rounded-md">
          <Logo />
        </Link>

        <nav
          aria-label="Main"
          className={cn(
            'fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-stone-50/95 backdrop-blur pb-[env(safe-area-inset-bottom)]',
            'md:static md:z-auto md:border-0 md:bg-transparent md:pb-0 md:backdrop-blur-none'
          )}
        >
          <ul className="mx-auto grid max-w-md grid-cols-4 md:flex md:max-w-none md:items-center md:gap-1">
            {PRIMARY_NAV.map(({ to, label, icon: Icon, match }) => {
              const active = match(location);
              return (
                <li key={to}>
                  <Link
                    to={to}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex flex-col items-center gap-1 px-2 py-2.5 text-[0.6875rem] font-semibold transition-colors md:flex-row md:gap-0 md:rounded-md md:px-3 md:py-1.5 md:text-[0.875rem]',
                      active ? 'text-stone-900' : 'text-stone-600 hover:text-stone-900'
                    )}
                  >
                    <Icon className={cn('h-5 w-5 md:hidden', active ? 'text-stone-900' : 'text-stone-400')} aria-hidden="true" />
                    {label}
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute inset-x-3 -bottom-px hidden h-px bg-stone-900 transition-opacity md:block md:-bottom-[1.0625rem]',
                        active ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <SearchAction />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
