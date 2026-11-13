import { useNavigate } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';

/** After a successful submission: toast + open the summary page. */
export function useSubmitAndOpen() {
  const navigate = useNavigate();
  const toast = useToast();

  return ({ source, duplicate }, { createdTitle, createdDescription }) => {
    if (duplicate) toast.info('Already in your library', 'Opening the existing summary.');
    else toast.success(createdTitle, createdDescription);
    navigate(`/library/${source.id}`);
  };
}
