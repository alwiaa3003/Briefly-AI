import { Route, Routes } from 'react-router-dom';
import AppLayout from './components/layout/AppLayout';
import ProtectedRoute from './components/routing/ProtectedRoute';
import PublicOnlyRoute from './components/routing/PublicOnlyRoute';
import Login from './pages/auth/Login';
import Register from './pages/auth/Register';
import Dashboard from './pages/Dashboard';
import Summarize from './pages/Summarize';
import Library from './pages/Library';
import SummaryDetail from './pages/SummaryDetail';
import Settings from './pages/Settings';
import AskAI from './pages/AskAI';
import Study from './pages/Study';
import Usage from './pages/Usage';
import NotFound from './pages/NotFound';

export default function App() {
  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="summarize" element={<Summarize />} />
          <Route path="library" element={<Library />} />
          <Route path="library/:id" element={<SummaryDetail />} />
          <Route path="ask" element={<AskAI />} />
          <Route path="ask/:conversationId" element={<AskAI />} />
          <Route path="study" element={<Study />} />
          <Route path="settings" element={<Settings />} />
          <Route path="usage" element={<Usage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
