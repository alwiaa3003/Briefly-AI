import { Compass } from 'lucide-react';
import { ButtonLink } from '../components/common/Button';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-5 text-center">
      <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-full bg-stone-100">
        <Compass className="h-5 w-5 text-stone-500" aria-hidden="true" />
      </div>
      <p className="eyebrow mb-2">404</p>
      <h1 className="page-title">Page not found</h1>
      <p className="mt-3 max-w-sm text-[0.9375rem] leading-relaxed text-stone-500">
        The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.
      </p>
      <ButtonLink to="/" className="mt-7">
        Back to overview
      </ButtonLink>
    </div>
  );
}
