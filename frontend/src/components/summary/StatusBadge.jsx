import Badge from '../common/Badge';
import Spinner from '../common/Spinner';
import { SOURCE_STATUS, isInProgress } from '../../utils/sourceStatus';

export default function StatusBadge({ status, className }) {
  const meta = SOURCE_STATUS[status] ?? { label: status, badge: 'neutral' };
  return (
    <Badge variant={meta.badge} className={className}>
      {isInProgress(status) && <Spinner size="sm" className="h-2.5 w-2.5" />}
      {meta.label}
    </Badge>
  );
}
