/**
 * CommandPalette — ⌘K / Ctrl+K quick navigation.
 *
 * Three command groups, filtered as you type:
 *  - "Go to" — sections of the current project (already permission-filtered
 *    by AppShell, so members only see what their role allows)
 *  - "Switch project" — all projects the user can access
 *  - "Actions" — global navigation and helpers
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, LayoutGrid, Settings, HelpCircle, Search } from "lucide-react";
import { projectsApi } from "../api/client";
import type { LucideIcon } from "lucide-react";

export interface PaletteNavItem {
  path: string;
  label: string;
  icon: LucideIcon;
}

interface Command {
  id: string;
  group: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

/** Mount only while open — state resets naturally on each open. */
export default function CommandPalette({ onClose, projectId, navItems }: {
  onClose: () => void;
  projectId?: string;
  navItems: PaletteNavItem[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: projects = [] } = useQuery({
    queryKey: ["projects"],
    queryFn: () => projectsApi.list().then(r => r.data),
    staleTime: 60_000,
  });

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];
    if (projectId) {
      for (const item of navItems) {
        cmds.push({
          id: `nav${item.path}`,
          group: "Go to",
          label: item.label,
          icon: item.icon,
          run: () => navigate(`/projects/${projectId}${item.path}`),
        });
      }
    }
    for (const p of projects) {
      if (p.id === projectId) continue;
      cmds.push({
        id: `proj-${p.id}`,
        group: "Switch project",
        label: p.name,
        icon: FolderOpen,
        run: () => navigate(`/projects/${p.id}`),
      });
    }
    cmds.push(
      { id: "all-projects", group: "Actions", label: "All projects",   icon: LayoutGrid, run: () => navigate("/projects") },
      { id: "new-project",  group: "Actions", label: "New project",    icon: FolderPlus, run: () => navigate("/projects/new") },
      { id: "settings",     group: "Actions", label: "Settings",       icon: Settings,   run: () => navigate("/settings") },
      {
        id: "tutorial", group: "Actions", label: "Restart tutorial", icon: HelpCircle,
        run: () => { localStorage.removeItem("ep_tour_done"); window.location.reload(); },
      },
    );
    return cmds;
  }, [projectId, navItems, projects, navigate]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c =>
      c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)
    );
  }, [commands, query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[selected];
        if (cmd) { cmd.run(); onClose(); }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [filtered, selected, onClose]);

  // Keep the highlighted row visible while arrowing through a long list
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Rows with group headers injected when the group changes
  let lastGroup: string | null = null;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette-panel" onClick={e => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="palette-input-row">
          <Search size={15} />
          <input
            autoFocus
            className="palette-input"
            value={query}
            onChange={e => { setQuery(e.target.value); setSelected(0); }}
            placeholder="Jump to a section, project, or action…"
            aria-label="Search commands"
          />
          <kbd className="palette-kbd">esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && (
            <div className="palette-empty">No matches for “{query}”</div>
          )}
          {filtered.map((cmd, idx) => {
            const header = cmd.group !== lastGroup ? cmd.group : null;
            lastGroup = cmd.group;
            const Icon = cmd.icon;
            return (
              <div key={cmd.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  data-idx={idx}
                  className={`palette-item${idx === selected ? " is-selected" : ""}`}
                  onMouseEnter={() => setSelected(idx)}
                  onClick={() => { cmd.run(); onClose(); }}
                >
                  <Icon size={15} />
                  <span>{cmd.label}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
