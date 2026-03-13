"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Arena" },
  { href: "/optimize", label: "Evolve" },
  { href: "/colony", label: "Colony" },
  { href: "/mafia", label: "Mafia" },
];

export default function NavBar({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div
      style={{ width: "100vw", height: "100vh", display: "flex", flexDirection: "column", background: "#c0c0c0" }}
      className="w95-raise"
    >
      {/* Title Bar */}
      <div className="w95-titlebar">
        <span>Agent Arena</span>
        <div className="w95-winctrls">
          <button className="w95-winbtn">_</button>
          <button className="w95-winbtn">□</button>
          <button className="w95-winbtn">✕</button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <nav className="w95-menubar" style={{ padding: "0 4px", gap: 0, borderBottom: "2px solid #808080" }}>
        {TABS.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            className={`w95-tab ${pathname === href ? "w95-tab-active" : "w95-tab-inactive"}`}
            style={{ padding: "3px 10px", fontSize: 11, textDecoration: "none" }}
          >
            {label}
          </Link>
        ))}
      </nav>

      {/* Page content */}
      {children}
    </div>
  );
}
