import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import PageLoader from '../common/PageLoader';
import ServerUnavailable from '../common/ServerUnavailable';

/**
 * Login/register pages. Once the user is signed in they are sent back to the
 * page they originally requested (set by ProtectedRoute), or the dashboard.
 */
export default function PublicOnlyRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <PageLoader />;
  if (status === 'unavailable') return <ServerUnavailable />;
  if (status === 'authenticated') {
    const from = location.state?.from;
    const target = typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/';
    return <Navigate to={target} replace />;
  }
  return <Outlet />;
}
