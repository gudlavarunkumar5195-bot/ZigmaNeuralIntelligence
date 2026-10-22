import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./styles";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

/** Button with consistent variants; `loading` disables it and announces busy state. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = "secondary", size = "md", loading = false, icon, className = "", children, disabled, type = "button", ...rest }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={`${buttonClass(variant, size)} ${className}`} {...rest}>
      {loading ? <Loader2 size={14} className="animate-spin-slow" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
});

/** Icon-only button; an accessible name is required. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "children"> & { "aria-label": string; children: ReactNode }>(function IconButton({ variant = "ghost", className = "", children, ...rest }, ref) {
  return (
    <Button ref={ref} variant={variant} size="icon" className={className} {...rest}>
      {children}
    </Button>
  );
});
