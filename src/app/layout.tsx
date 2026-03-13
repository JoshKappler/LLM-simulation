import type { Metadata } from "next";
import "./globals.css";
import NavBar from "@/components/NavBar";

export const metadata: Metadata = {
  title: "Agent Arena",
  description: "Run AI agents in conversation, evolution, and social simulation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavBar>{children}</NavBar>
      </body>
    </html>
  );
}
