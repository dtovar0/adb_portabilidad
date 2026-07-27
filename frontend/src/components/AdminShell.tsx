"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Shell del panel de administracion: sidebar colapsable + topbar. Envuelve todas
// las paginas (via layout). El estado de colapso persiste en localStorage.

// soon: la ruta aún no existe como página propia; el ítem se muestra pero
// deshabilitado (evita links rotos mientras se construyen esas vistas).
type NavEntry = { href: string; label: string; icon: React.ReactNode; soon?: boolean };

const ICON = {
  panel: (
    <svg className="ic" viewBox="0 0 24 24">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  ),
  map: (
    <svg className="ic" viewBox="0 0 24 24">
      <path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  ),
  bars: (
    <svg className="ic" viewBox="0 0 24 24">
      <path d="M3 3v18h18" />
      <rect x="7" y="11" width="3" height="7" />
      <rect x="12" y="7" width="3" height="11" />
      <rect x="17" y="13" width="3" height="5" />
    </svg>
  ),
  search: (
    <svg className="ic" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  ),
  sync: (
    <svg className="ic" viewBox="0 0 24 24">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  ),
  clock: (
    <svg className="ic" viewBox="0 0 24 24">
      <path d="M12 8v4l3 2" />
      <circle cx="12" cy="12" r="9" />
    </svg>
  ),
};

const NAV_GENERAL: NavEntry[] = [
  { href: "/", label: "Panel general", icon: ICON.panel },
  { href: "/#buscador", label: "Buscar número", icon: ICON.search },
  { href: "/estados", label: "Por estado", icon: ICON.map, soon: true },
  { href: "/operadores", label: "Por operador", icon: ICON.bars, soon: true },
];
const NAV_DATOS: NavEntry[] = [
  { href: "/sincronizaciones", label: "Sincronizaciones", icon: ICON.sync, soon: true },
  { href: "/eventos", label: "Historial de eventos", icon: ICON.clock, soon: true },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

// Titulo del breadcrumb segun la ruta (fallback: "Panel general").
function crumbFor(pathname: string): string {
  const all = [...NAV_GENERAL, ...NAV_DATOS];
  const hit = all.find((n) => isActive(pathname, n.href));
  if (hit) return hit.label;
  if (pathname.startsWith("/operador/")) return "Operador";
  return "Panel general";
}

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/";
  const [collapsed, setCollapsed] = useState(false);

  // Restaura la preferencia de colapso al montar (evita flash: el default es
  // expandido, que es lo mas comun). localStorage puede lanzar (modo privado,
  // storage lleno o bloqueado por politica): la preferencia es opcional, asi que
  // se ignora el fallo y se usa el default.
  useEffect(() => {
    try {
      if (localStorage.getItem("sidebar-collapsed") === "1") setCollapsed(true);
    } catch {
      /* preferencia no disponible: se queda expandido */
    }
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      const next = !c;
      // Persistir es best-effort: un QuotaExceededError (u otro fallo de storage)
      // no debe impedir contraer/expandir el menu.
      try {
        localStorage.setItem("sidebar-collapsed", next ? "1" : "0");
      } catch {
        /* no se pudo guardar la preferencia: se aplica solo en esta sesion */
      }
      return next;
    });
  };

  const renderNav = (entries: NavEntry[]) =>
    entries.map((n) => {
      // Ítems 'soon': se muestran atenuados y no navegan (aún sin página).
      if (n.soon) {
        return (
          <span
            key={n.href}
            className="nav-item"
            style={{ opacity: 0.45, cursor: "default" }}
            title="Próximamente"
          >
            {n.icon}
            <span>{n.label}</span>
          </span>
        );
      }
      return (
        <Link
          key={n.href}
          href={n.href}
          className={"nav-item" + (isActive(pathname, n.href) ? " active" : "")}
        >
          {n.icon}
          <span>{n.label}</span>
        </Link>
      );
    });

  return (
    <div className={"shell" + (collapsed ? " collapsed" : "")}>
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">P</div>
          <div className="name">
            Portabilidad
            <small>México · IFT</small>
          </div>
        </div>

        <div className="nav-group-label">General</div>
        {renderNav(NAV_GENERAL)}

        <div className="nav-group-label">Datos</div>
        {renderNav(NAV_DATOS)}

        <div className="side-foot">
          <span className="dot" />
          <span>Datos de demostración</span>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button
            className="icon-btn"
            onClick={toggle}
            aria-label={collapsed ? "Expandir menú" : "Contraer menú"}
            title={collapsed ? "Expandir menú" : "Contraer menú"}
          >
            <svg className="ic" viewBox="0 0 24 24">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <div className="crumb">
            <span>Inicio</span>
            <span className="sep">›</span>
            <b>{crumbFor(pathname)}</b>
          </div>
          <div className="topbar-right">
            <div className="avatar">DT</div>
          </div>
        </div>

        <div className="content">{children}</div>
      </div>
    </div>
  );
}
