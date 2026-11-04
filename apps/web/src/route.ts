// The URL is the navigation state: which node is in focus and which moment is
// being looked at. Every drill-down step is a history entry, so Back climbs
// one level, and any view can be shared as a link.
import { useCallback, useEffect, useRef, useState } from 'react';

export interface Route {
  focus: string | null;
  asOf: string | null;
}

function read(): Route {
  const p = new URLSearchParams(window.location.search);
  return { focus: p.get('focus'), asOf: p.get('asOf') };
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
    if (next.focus === current.current.focus && next.asOf === current.current.asOf) return;
    const p = new URLSearchParams();
    if (next.focus) p.set('focus', next.focus);
    if (next.asOf) p.set('asOf', next.asOf);
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
