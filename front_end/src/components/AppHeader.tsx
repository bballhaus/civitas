"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { logout } from "@/lib/api";

interface AppHeaderProps {
  /** Optional content to show between logo and Log out (e.g. Profile link) */
  rightContent?: React.ReactNode;
  /** Nav layout: dashboard uses slightly different max-width */
  variant?: "default" | "dashboard";
}

export function AppHeader({ rightContent, variant = "default" }: AppHeaderProps) {
  const router = useRouter();
  const maxWidth = variant === "dashboard" ? "max-w-full" : "max-w-7xl";
  const logoSize = variant === "dashboard" ? "h-10 w-10" : "h-12 w-12";
  const titleSize = variant === "dashboard" ? "text-xl" : "text-2xl";

  return (
    <nav className="sticky top-0 bg-white border-b border-slate-200 z-10 shadow-sm">
      <div className={`${maxWidth} mx-auto px-6 py-4 flex items-center justify-between`}>
        <Link href="/dashboard" className="flex items-center gap-2">
          <img src="/logo.png" alt="Civitas logo" className={logoSize} />
          <span className={`${titleSize} font-bold text-slate-900`}>Civitas</span>
        </Link>
        <div className="flex items-center gap-4">
          {rightContent}
          <button
            type="button"
            onClick={() => logout(router)}
            className="px-3 py-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 transition-colors"
          >
            Log out
          </button>
        </div>
      </div>
    </nav>
  );
}
