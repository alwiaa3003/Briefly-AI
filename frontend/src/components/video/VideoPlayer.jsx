import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Film } from 'lucide-react';
import Spinner from '../common/Spinner';
import * as sourceService from '../../services/sourceService';
import { youtubeEmbedUrl } from '../../utils/youtube';

/** Privacy-enhanced YouTube embed. Seeking reloads the embed at the requested second. */
const YouTubePlayer = forwardRef(function YouTubePlayer({ videoId, title }, ref) {
  const [start, setStart] = useState({ seconds: 0, autoplay: false, nonce: 0 });

  useImperativeHandle(ref, () => ({
    seek(seconds) {
      setStart((current) => ({ seconds, autoplay: true, nonce: current.nonce + 1 }));
    },
  }));

  return (
    <div className="aspect-video w-full overflow-hidden rounded-xl bg-stone-900">
      <iframe
        key={start.nonce}
        title={title ? `YouTube video: ${title}` : 'YouTube video'}
        src={youtubeEmbedUrl(videoId, { start: start.seconds, autoplay: start.autoplay })}
        className="h-full w-full"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        loading="lazy"
      />
    </div>
  );
});

/** Uploaded video, streamed from a short-lived signed URL that only the owner can obtain. */
const UploadPlayer = forwardRef(function UploadPlayer({ sourceId, retentionNote }, ref) {
  const videoRef = useRef(null);
  const pendingSeek = useRef(null);
  const [state, setState] = useState({ status: 'loading', url: null, message: '' });

  const load = useCallback(async () => {
    setState({ status: 'loading', url: null, message: '' });
    try {
      const playback = await sourceService.getPlayback(sourceId);
      setState({ status: 'ready', url: playback.url, message: '' });
    } catch (error) {
      const gone = error.response?.status === 410;
      setState({
        status: gone ? 'expired' : 'error',
        url: null,
        message: error.response?.data?.error?.message || 'The video could not be loaded.',
      });
    }
  }, [sourceId]);

  useEffect(() => {
    load();
  }, [load]);

  useImperativeHandle(ref, () => ({
    seek(seconds) {
      const video = videoRef.current;
      if (!video) {
        pendingSeek.current = seconds;
        return;
      }
      video.currentTime = seconds;
      const playing = video.play?.();
      if (playing && typeof playing.catch === 'function') playing.catch(() => {});
    },
  }));

  if (state.status === 'loading') {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-stone-100 text-stone-400">
        <Spinner size="lg" label="Loading video" />
      </div>
    );
  }
  if (state.status !== 'ready') {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 rounded-xl border border-stone-200 bg-stone-50 px-6 text-center">
        <Film className="h-6 w-6 text-stone-300" aria-hidden="true" />
        <p className="text-sm text-stone-600">{state.message}</p>
        {state.status === 'expired' && retentionNote && <p className="text-xs text-stone-500">{retentionNote}</p>}
      </div>
    );
  }
  return (
    <video
      ref={videoRef}
      src={state.url}
      controls
      preload="metadata"
      className="aspect-video w-full rounded-xl bg-stone-900"
      onLoadedMetadata={() => {
        if (pendingSeek.current !== null && videoRef.current) {
          videoRef.current.currentTime = pendingSeek.current;
          pendingSeek.current = null;
        }
      }}
      // Signed URLs expire; fetch a fresh one if playback fails.
      onError={() => load()}
    >
      <track kind="captions" />
    </video>
  );
});

const VideoPlayer = forwardRef(function VideoPlayer({ source }, ref) {
  if (source.kind === 'youtube' && source.video?.videoId) {
    return <YouTubePlayer ref={ref} videoId={source.video.videoId} title={source.metadata?.title} />;
  }
  if (source.kind === 'video') {
    return (
      <UploadPlayer
        ref={ref}
        sourceId={source.id}
        retentionNote="Uploaded files are deleted after the retention period. The transcript and summary remain available."
      />
    );
  }
  return null;
});

export default VideoPlayer;
