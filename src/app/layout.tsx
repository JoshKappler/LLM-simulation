import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Arena",
  description: "Run two AI agents in conversation via Ollama",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
