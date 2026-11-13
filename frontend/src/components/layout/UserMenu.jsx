import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Gauge, LogOut, Settings } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import { cn } from '../../utils/cn';
import { getInitials } from '../../utils/format';

export function Avatar({ name, className }) {
  return (
    <span
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-stone-900 text-[0.6875rem] font-semibold tracking-wide text-stone-50',
        className
      )}
      aria-hidden="true"
    >
      {getInitials(name)}
    </span>
  );
}

/** Profile button (top-right). The menu holds account pages and sign-out. */
export default function UserMenu() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function handlePointer(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) setOpen(false);
    }
    function handleKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  async function handleLogout() {
    setOpen(false);
    try {
      await logout();
    } catch {
      // The local session is cleared regardless; nothing else to do.
    }
    toast.info('Signed out');
    navigate('/login', { replace: true });
  }

  if (!user) return null;
  const item = 'flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-left text-sm text-stone-700 transition-colors hover:bg-stone-100';

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="rounded-full ring-offset-2 ring-offset-stone-50 transition hover:ring-2 hover:ring-stone-300"
      >
        <Avatar name={user.name} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-64 rounded-lg border border-stone-200 bg-white p-1 shadow-popover">
          <div className="px-2.5 py-2.5">
            <p className="truncate text-sm font-medium text-stone-900">{user.name}</p>
            <p className="truncate text-xs text-stone-500">{user.email}</p>
          </div>
          <div className="my-1 border-t border-stone-200/70" />
          <Link to="/settings" role="menuitem" onClick={() => setOpen(false)} className={item}>
            <Settings className="h-4 w-4 text-stone-400" aria-hidden="true" />
            Settings
          </Link>
          <Link to="/usage" role="menuitem" onClick={() => setOpen(false)} className={item}>
            <Gauge className="h-4 w-4 text-stone-400" aria-hidden="true" />
            AI usage
          </Link>
          <div className="my-1 border-t border-stone-200/70" />
          <button type="button" role="menuitem" onClick={handleLogout} className={item}>
            <LogOut className="h-4 w-4 text-stone-400" aria-hidden="true" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
