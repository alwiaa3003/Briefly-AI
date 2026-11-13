import Spinner from './Spinner';

export default function PageLoader({ label = 'Loading' }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-50 text-stone-400">
      <Spinner size="lg" label={label} />
    </div>
  );
}
