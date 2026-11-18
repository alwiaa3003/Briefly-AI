import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import PageLoader from '../common/PageLoader';
import ServerUnavailable from '../common/ServerUnavailable';

/** Renders child routes only for signed-in users; otherwise redirects to /login. */
export default function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader label="Restoring your session" />;
  if (status === 'unavailable') return <ServerUnavailable />;
  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
