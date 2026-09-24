import {CircleAlert, CircleCheck} from "lucide-react";
import {useCallback, useRef, useState} from "react";

import type {Notify} from "./format";

type Toast = {
  id: number;
  message: string;
  error: boolean;
};

const TOAST_MS = 3_200;
// Errors stay up longer: they usually need reading, not just noticing.
const ERROR_TOAST_MS = 6_000;

/** Transient feedback toasts, raised through the returned `notify`. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const notify: Notify = useCallback((message, error = false) => {
    const id = ++nextId.current;
    setToasts((current) => [...current, {id, message, error}]);
    const dismiss = () => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    };
    window.setTimeout(dismiss, error ? ERROR_TOAST_MS : TOAST_MS);
  }, []);
  return {toasts, notify};
}

export function Toasts({toasts}: {toasts: Toast[]}) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div className="toast" data-error={toast.error} key={toast.id}>
          {toast.error ? <CircleAlert /> : <CircleCheck />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
