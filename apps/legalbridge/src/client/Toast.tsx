import { createContext, useCallback, useContext, useRef, useState } from "react";

export type ToastKind = "info" | "success" | "error";
type Toast = { id: number; message: string; kind: ToastKind };

type ToastApi = {
  push: (message: string, kind?: ToastKind) => void;
  // Wrap a mutation: resolves show a success toast, rejections show an error.
  run: <T>(promise: Promise<T>, okMessage: string, errorMessage?: string) => Promise<T>;
};

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used within <ToastProvider>");
  return api;
}

const ICONS: Record<ToastKind, string> = { info: "ℹ", success: "✓", error: "⚠" };

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => remove(id), 4500);
  }, [remove]);

  const run = useCallback(async <T,>(promise: Promise<T>, okMessage: string, errorMessage?: string) => {
    try {
      const result = await promise;
      push(okMessage, "success");
      return result;
    } catch (error) {
      push(errorMessage ?? (error instanceof Error ? error.message : "処理に失敗しました"), "error");
      throw error;
    }
  }, [push]);

  return <ToastContext.Provider value={{ push, run }}>
    {children}
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
          onClick={() => remove(toast.id)}>
          <span className="toast-icon" aria-hidden="true">{ICONS[toast.kind]}</span>
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  </ToastContext.Provider>;
}
