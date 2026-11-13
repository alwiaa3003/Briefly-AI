import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { cn } from '../../utils/cn';

/** Top-bar search: expands into a field and opens the library with the query (title search). */
export default function SearchAction() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    function onKey(event) {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable;
      if (event.key === '/' && !typing) {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function submit(event) {
    event.preventDefault();
    const q = value.trim();
    navigate(q ? `/library?q=${encodeURIComponent(q)}` : '/library');
    setOpen(false);
    setValue('');
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search your library"
        title="Search (/)"
        className="flex h-9 w-9 items-center justify-center rounded-md text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
      >
        <Search className="h-[1.125rem] w-[1.125rem]" aria-hidden="true" />
      </button>
    );
  }

  return (
    <form role="search" onSubmit={submit} className={cn('flex items-center gap-1')}>
      <label htmlFor="global-search" className="sr-only">
        Search your library
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" aria-hidden="true" />
        <input
          ref={inputRef}
          id="global-search"
          type="search"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
          onBlur={() => !value && setOpen(false)}
          placeholder="Search your library"
          maxLength={100}
          className="control h-9 w-44 pl-8 sm:w-64"
        />
      </div>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen(false)}
        aria-label="Close search"
        className="flex h-9 w-9 items-center justify-center rounded-md text-stone-500 hover:bg-stone-100"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </form>
  );
}
