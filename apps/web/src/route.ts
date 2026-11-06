// The URL is the navigation state: which node is in focus, which moment is
// being looked at, and which file or link's page is open (ADR 0014). Every
// step is a history entry, so Back retraces it, and any view can be shared as
// a link: `?repo=<id>&path=<path>` is how a code review links a file to its
// requirements.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Route {
  focus: string | null;
  asOf: string | null;
  /** A reference target's page: a file or directory in a repository… */
  repo: string | null;
  path: string | null;
  /** …or a URL. */
  url: string | null;
}

const KEYS = ['focus', 'asOf', 'repo', 'path', 'url'] as const;

function read(): Route {
  const p = new URLSearchParams(window.location.search);
  return { focus: p.get('focus'), asOf: p.get('asOf'), repo: p.get('repo'), path: p.get('path'), url: p.get('url') };
}

export function useRoute(): [Route, (patch: Partial<Route>, opts?: { replace?: boolean }) => void] {
  const [route, setRoute] = useState<Route>(read);
  const current = useRef(route);
  current.current = route;

  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((patch: Partial<Route>, opts?: { replace?: boolean }) => {
    const next = { ...current.current, ...patch };
    if (KEYS.every((k) => next[k] === current.current[k])) return;
    const p = new URLSearchParams();
    for (const k of KEYS) if (next[k]) p.set(k, next[k]!);
    const qs = p.toString();
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (opts?.replace) window.history.replaceState(null, '', url);
    else window.history.pushState(null, '', url);
    current.current = next;
    setRoute(next);
  }, []);

  return [route, navigate];
}

export function useStoredState(key: string, initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: string) => {
      setValue(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        // storage unavailable — keep it for this session only
      }
    },
    [key],
  );
  return [value, set];
}
