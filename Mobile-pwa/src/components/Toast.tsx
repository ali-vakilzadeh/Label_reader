import React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';

export interface ToastMessage {
  id: string;
  type: 'success' | 'warning' | 'error' | 'info';
  title?: string;
  message: string;
}

interface ToastProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

/**
 * Status hues from the design basis. Colour never arrives alone: every toast pairs
 * its hue with an icon and a word, so the meaning survives a colour-blind reader and
 * a washed-out screen in a warehouse.
 */
const TONE: Record<ToastMessage['type'], { bg: string; Icon: typeof Info }> = {
  success: { bg: 'bg-[color:var(--color-good)]', Icon: CheckCircle2 },
  warning: { bg: 'bg-[color:var(--color-warning)]', Icon: AlertTriangle },
  error: { bg: 'bg-[color:var(--color-critical)]', Icon: XCircle },
  info: { bg: 'bg-[color:var(--color-info)]', Icon: Info }
};

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    // Below the brand bar's safe area, so a toast never lands under the notch.
    <div className="fixed top-0 left-1/2 -translate-x-1/2 z-[90] safe-top pt-2 flex flex-col gap-2 w-[92%] max-w-md pointer-events-none">
      {toasts.map((toast) => {
        const { bg, Icon } = TONE[toast.type];
        return (
          <button
            key={toast.id}
            type="button"
            onClick={() => onDismiss(toast.id)}
            className={`pointer-events-auto w-full flex items-start gap-3 px-4 py-3 rounded-[var(--radius-control)] shadow-[var(--shadow-overlay)] text-left text-cream-50 cursor-pointer ${bg}`}
          >
            <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              {toast.title && (
                <div className="text-[0.75rem] font-semibold uppercase tracking-wider opacity-90">
                  {toast.title}
                </div>
              )}
              <div className="text-[0.82rem] leading-snug">{toast.message}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
};
