import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react';

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

export const ToastContainer: React.FC<ToastProps> = ({ toasts, onDismiss }) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[92%] max-w-md pointer-events-none">
      {toasts.map((toast) => {
        const bg =
          toast.type === 'success'
            ? 'bg-[#166534] text-white border-green-600'
            : toast.type === 'warning'
            ? 'bg-[#B4531B] text-white border-amber-600'
            : toast.type === 'error'
            ? 'bg-[#991B1B] text-white border-red-600'
            : 'bg-[#2A1D14] text-white border-[#BF9445]';

        const Icon =
          toast.type === 'success'
            ? CheckCircle2
            : toast.type === 'warning'
            ? AlertTriangle
            : toast.type === 'error'
            ? XCircle
            : Info;

        return (
          <div
            key={toast.id}
            onClick={() => onDismiss(toast.id)}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium transition-all transform animate-in fade-in slide-in-from-top duration-200 cursor-pointer ${bg}`}
          >
            <Icon className="w-5 h-5 flex-shrink-0" />
            <div className="flex-1">
              {toast.title && <div className="font-bold text-xs uppercase tracking-wide opacity-90">{toast.title}</div>}
              <div className="text-xs leading-snug">{toast.message}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
