/**
 * Feedback — app-wide toast notifications and confirm dialogs.
 *
 * Usage:
 *   const toast = useToast();
 *   toast("Saved", "success");            // "success" | "error" | "info"
 *
 *   const confirm = useConfirm();
 *   if (await confirm({ title: "Delete label?", message: "This removes it from all articles.", danger: true })) { … }
 *
 * Replaces native alert()/window.confirm() so feedback matches the app's
 * design system and destructive actions get an explicit, styled dialog.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertCircle, Info } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive (red). */
  danger?: boolean;
}

type ToastFn = (message: string, type?: ToastType) => void;
type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ToastContext = createContext<ToastFn | null>(null);
const ConfirmContext = createContext<ConfirmFn | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastFn {
  const fn = useContext(ToastContext);
  if (!fn) throw new Error("useToast must be used within <FeedbackProvider>");
  return fn;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm must be used within <FeedbackProvider>");
  return fn;
}

const TOAST_ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 size={16} />,
  error: <AlertCircle size={16} />,
  info: <Info size={16} />,
};

const TOAST_DURATION_MS = 6000;

function ToastStack({ toasts, onDismiss }: { toasts: ToastItem[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast--${t.type}`}>
          <span className="toast-icon">{TOAST_ICONS[t.type]}</span>
          <span className="toast-message">{t.message}</span>
          <button className="toast-dismiss" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">✕</button>
        </div>
      ))}
    </div>
  );
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (result: boolean) => void;
}

function ConfirmDialog({ pending, onResolve }: { pending: PendingConfirm; onResolve: (result: boolean) => void }) {
  const { title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger } = pending.options;
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onResolve(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onResolve]);

  return (
    <div className="modal-overlay" onClick={() => onResolve(false)}>
      <div
        className="modal-card"
        style={{ maxWidth: 400 }}
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <div style={{ padding: "1.25rem 1.25rem 1rem" }}>
          <h3 id="confirm-title" style={{ margin: 0, fontSize: "1rem" }}>{title}</h3>
          {message && (
            <p style={{ margin: "0.5rem 0 0", fontSize: "0.86rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {message}
            </p>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", padding: "0 1.25rem 1.25rem" }}>
          <button className="btn-ghost btn-sm" onClick={() => onResolve(false)}>{cancelLabel}</button>
          <button
            ref={confirmRef}
            className={`${danger ? "btn-danger" : "btn-primary"} btn-sm`}
            onClick={() => onResolve(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const nextId = useRef(1);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>((message, type = "info") => {
    const id = nextId.current++;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => dismissToast(id), TOAST_DURATION_MS);
  }, [dismissToast]);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>(resolve => {
      setPendingConfirm({ options, resolve });
    });
  }, []);

  const resolveConfirm = useCallback((result: boolean) => {
    setPendingConfirm(prev => {
      prev?.resolve(result);
      return null;
    });
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      <ConfirmContext.Provider value={confirm}>
        {children}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
        {pendingConfirm && <ConfirmDialog pending={pendingConfirm} onResolve={resolveConfirm} />}
      </ConfirmContext.Provider>
    </ToastContext.Provider>
  );
}
