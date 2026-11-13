import PageContainer from '../components/layout/PageContainer';
import AiUsage from '../components/settings/AiUsage';
import { SettingsNav } from '../components/settings/SettingsSection';

/** AI usage: Briefly's own budgets and today's usage. Google's real quotas are only shown in AI Studio. */
export default function Usage() {
  return (
    <PageContainer width="narrow" eyebrow="Account" title="AI usage">
      <SettingsNav />
      <div className="pt-8">
        <AiUsage />
      </div>
    </PageContainer>
  );
}
