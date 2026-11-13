import { useEffect, useRef } from 'preact/hooks';

let nextOverlay = 0;
/** A phone's Back gesture closes the top overlay before leaving its underlying tab. */
export function usePhoneBack(onClose: () => void, open = true): void {
  const close = useRef(onClose);
  close.current = onClose;
  const token = useRef(0);
  if (!token.current) token.current = ++nextOverlay;
  useEffect(() => {
    if (!open || innerWidth >= 700) return;
    const state = { ...history.state, glassOverlay: token.current };
    if (history.state?.glassOverlay) history.replaceState(state, '', location.href);
    else history.pushState(state, '', location.href);
    const back = () => {
      if (history.state?.glassOverlay !== token.current) close.current();
    };
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('popstate', back);
      // Another sheet opened in the same render keeps this entry. Otherwise remove it.
      queueMicrotask(() => {
        if (history.state?.glassOverlay === token.current) history.back();
      });
    };
  }, [open]);
}
