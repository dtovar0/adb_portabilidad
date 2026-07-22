import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Portabilidad — Dashboard",
  description: "Comportamiento de la portabilidad numérica en México",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
