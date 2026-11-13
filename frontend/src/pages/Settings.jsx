import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import PageContainer from '../components/layout/PageContainer';
import { Section, SectionBody, SectionHeader, SettingsNav } from '../components/settings/SettingsSection';
import Button from '../components/common/Button';
import Input from '../components/common/Input';
import Badge from '../components/common/Badge';
import Spinner from '../components/common/Spinner';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import * as systemService from '../services/systemService';
import { getErrorMessage } from '../utils/errors';
import { formatDate } from '../utils/format';
import StudyPreferences from '../components/settings/StudyPreferences';

const SERVICE_LABELS = {
  database: 'Database (MongoDB)',
  redis: 'Job queue (Redis)',
  processingService: 'Processing service',
};

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 60000;

function ProfileSection() {
  const { user } = useAuth();
  return (
    <Section>
      <SectionHeader title="Profile" description="Your account details." />
      <SectionBody className="grid gap-5 sm:grid-cols-2">
        <Input label="Name" value={user.name} readOnly disabled />
        <Input label="Email" value={user.email} readOnly disabled />
        <p className="text-xs text-stone-500 sm:col-span-2">Member since {formatDate(user.createdAt)}</p>
      </SectionBody>
    </Section>
  );
}

function SessionSection() {
  const { logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  async function handleLogout() {
    setBusy(true);
    try {
      await logout();
    } catch {
      // Local session is cleared regardless.
    }
    toast.info('Signed out');
    navigate('/login', { replace: true });
  }

  return (
    <Section>
      <SectionHeader title="Session" description="Sign out of Briefly on this device." />
      <SectionBody>
        <Button variant="secondary" onClick={handleLogout} loading={busy}>
          Sign out
        </Button>
      </SectionBody>
    </Section>
  );
}

function SystemStatusSection() {
  const toast = useToast();
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null);
  const [jobRunning, setJobRunning] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await systemService.getSystemStatus();
      if (mounted.current) setStatus(result);
    } catch (err) {
      if (mounted.current) setError(getErrorMessage(err, 'Could not load system status.'));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  async function runPipelineTest() {
    setJobRunning(true);
    setJob(null);
    try {
      let current = await systemService.createTestJob('Pipeline check from the Settings page');
      setJob(current);
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (mounted.current && current.status !== 'completed' && current.status !== 'failed') {
        if (Date.now() > deadline) throw new Error('timeout');
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        current = await systemService.getJob(current.id);
        if (mounted.current) setJob(current);
      }
      if (!mounted.current) return;
      if (current.status === 'completed') toast.success('Pipeline test completed');
      else toast.error('Pipeline test failed', current.error?.message);
    } catch (err) {
      if (mounted.current) {
        toast.error(
          'Pipeline test could not run',
          err.message === 'timeout' ? 'The job did not finish in time. Is the worker running?' : getErrorMessage(err)
        );
      }
    } finally {
      if (mounted.current) setJobRunning(false);
    }
  }

  return (
    <Section>
      <SectionHeader
        title="System status"
        description="Connectivity between the app and its backend services."
        action={
          <Button variant="ghost" size="sm" onClick={loadStatus} disabled={loading} aria-label="Refresh system status">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </Button>
        }
      />
      <SectionBody className="space-y-5">
        {loading && !status ? (
          <div className="flex items-center gap-2 text-sm text-stone-500">
            <Spinner size="sm" /> Checking services…
          </div>
        ) : error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : (
          <ul className="divide-y divide-stone-200/70 border-y border-stone-200">
            <li className="flex items-center justify-between px-1 py-2.5 text-sm">
              <span className="text-stone-700">API (Express)</span>
              <Badge variant="success">Up</Badge>
            </li>
            {Object.entries(SERVICE_LABELS).map(([key, label]) => {
              const up = status?.services?.[key]?.status === 'up';
              return (
                <li key={key} className="flex items-center justify-between px-1 py-2.5 text-sm">
                  <span className="text-stone-700">{label}</span>
                  <Badge variant={up ? 'success' : 'danger'}>{up ? 'Up' : 'Down'}</Badge>
                </li>
              );
            })}
          </ul>
        )}

        <div className="rounded-md border border-stone-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium text-stone-900">Background pipeline test</p>
              <p className="mt-0.5 text-xs text-stone-500">
                Queues a job that a worker sends to the processing service and records the result.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={runPipelineTest} loading={jobRunning}>
              Run test
            </Button>
          </div>
          {job && (
            <div className="mt-3 flex items-center gap-2 text-xs text-stone-600">
              {job.status === 'completed' ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" aria-hidden="true" />
              ) : job.status === 'failed' ? (
                <CircleAlert className="h-3.5 w-3.5 text-red-600" aria-hidden="true" />
              ) : (
                <Spinner size="sm" className="text-stone-400" />
              )}
              <span>
                Job <span className="font-mono">{job.id.slice(-8)}</span>: {job.status}
                {job.attempts > 0 && ` (attempt ${job.attempts} of ${job.maxAttempts})`}
                {job.status === 'failed' && job.error?.message && ` · ${job.error.message}`}
              </span>
            </div>
          )}
        </div>
      </SectionBody>
    </Section>
  );
}

export default function Settings() {
  return (
    <PageContainer width="narrow" eyebrow="Account" title="Settings" description="Your profile, study defaults, session and the health of your workspace.">
      <SettingsNav />
      <div className="[&>section:first-child]:border-t-0">
        <ProfileSection />
        <StudyPreferences />
        <SessionSection />
        <SystemStatusSection />
      </div>
    </PageContainer>
  );
}
