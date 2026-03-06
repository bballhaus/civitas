"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { logout } from "@/lib/api";

const NAV_LINKS = [
  {
    label: "Home",
    href: "/home",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z" />
      </svg>
    ),
  },
  {
    label: "View Matches",
    href: "/dashboard",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
      </svg>
    ),
  },
  {
    label: "Profile",
    href: "/profile",
    icon: (
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
    ),
  },
] as const;

export function AppHeader() {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-slate-200 z-10 shadow-sm">
      <div className="max-w-full mx-auto px-8 py-3 flex items-center justify-between">
        {/* Logo */}
        <Link href="/home" className="flex items-center gap-2.5 shrink-0 group">
          <img src="/logo.png" alt="Civitas logo" className="h-10 w-10 transition-transform group-hover:scale-105" />
          <span className="text-xl font-extrabold tracking-tight text-slate-900">
            Civitas
          </span>
        </Link>

        {/* Navigation tabs */}
        <div className="flex items-center gap-1">
          {NAV_LINKS.map(({ label, href, icon }) => {
            const isActive =
              pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 px-4 py-2 text-sm rounded-lg transition-all duration-150 ${
                  isActive
                    ? "font-bold bg-[#3C89C6]/10 text-[#3C89C6] shadow-sm ring-1 ring-[#3C89C6]/20"
                    : "font-semibold text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                }`}
              >
                <span className={isActive ? "text-[#3C89C6]" : "text-slate-400"}>
                  {icon}
                </span>
                {label}
              </Link>
            );
          })}

          <div className="w-px h-6 bg-slate-200 mx-2" />

          <button
            type="button"
            onClick={() => logout(router)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-slate-500 hover:text-white rounded-lg border border-slate-200 hover:bg-red-500 hover:border-red-500 hover:shadow-md transition-all duration-150"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Log out
          </button>
        </div>
      </div>
    </nav>
  );
}
