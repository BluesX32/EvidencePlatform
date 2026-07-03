import { useRef, useState, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckSquare, ArrowRight, Download, List, X } from "lucide-react";
import { projectsApi, screeningApi } from "../api/client";
import { INK, FONT, fmtReason, buildExportSVG } from "../utils/prismaExport";

// ── Helpers ───────────────────────────────────────────────────────────────────
function groupSources(raw: { name: string; count: number }[]) {
  let bwN = 0, bwCount = 0, fwN = 0, fwCount = 0;
  const dbs: { name: string; count: number }[] = [];
  for (const s of raw) {
    const core = s.name.replace(/^[^A-Za-z]+/, "");
    if (core.startsWith("Refs:") || core.startsWith("Refs "))          { bwN += s.count; bwCount++; }
    else if (core.startsWith("Citing:") || core.startsWith("Citing ")) { fwN += s.count; fwCount++; }
    else dbs.push(s);
  }
  const out = [...dbs];
  if (bwN > 0) out.push({ name: `Backward citation searching (${bwCount} seed${bwCount > 1 ? "s" : ""})`, count: bwN });
  if (fwN > 0) out.push({ name: `Forward citation searching (${fwCount} seed${fwCount > 1 ? "s" : ""})`, count: fwN });
  return out;
}

// ── Inline-editable number ────────────────────────────────────────────────────
function EN({
  value, color = INK.title, size = 20, onSave,
}: { value: number; color?: string; size?: number; onSave: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    const n = parseInt(draft.replace(/,/g, ""), 10);
    if (!isNaN(n) && n >= 0) onSave(n);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        style={{
          width: 90, border: "none", borderBottom: `2px solid ${color}`,
          background: "transparent", textAlign: "center",
          fontSize: size, fontWeight: 700, color, outline: "none",
          fontVariantNumeric: "tabular-nums",
        }}
      />
    );
  }

  return (
    <span
      title="Click to edit"
      onClick={() => { setDraft(String(value)); setEditing(true); }}
      style={{
        fontSize: size, fontWeight: 700, color, cursor: "text",
        borderBottom: "1px dotted #94a3b8", paddingBottom: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {value.toLocaleString()}
    </span>
  );
}

function NLine({
  value, size = 20, onSave, color = INK.title,
}: { value: number; size?: number; onSave: (v: number) => void; color?: string }) {
  return (
    <div style={{ textAlign: "center", marginTop: 8 }}>
      <span style={{ fontSize: Math.round(size * 0.62), color: INK.muted }}>n = </span>
      <EN value={value} color={color} size={size} onSave={onSave} />
    </div>
  );
}

// ── Structural primitives ─────────────────────────────────────────────────────
// Grid columns: [phase bar | gap | main box | arrow gutter | side box]
const COLS = "36px 20px 340px 56px 300px";

function PhaseBar({ label, row }: { label: string; row: string }) {
  return (
    <div style={{
      gridColumn: 1, gridRow: row,
      background: INK.phaseBg, border: `1px solid ${INK.phaseBorder}`, borderRadius: 4,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <span style={{
        writingMode: "vertical-rl", transform: "rotate(180deg)",
        fontSize: 11, fontWeight: 600, color: INK.body,
        letterSpacing: "0.12em", textTransform: "uppercase",
      }}>
        {label}
      </span>
    </div>
  );
}

function VArr({ row }: { row: number }) {
  return (
    <div style={{ gridColumn: 3, gridRow: row, display: "flex", justifyContent: "center" }}>
      <svg width="16" height="30" viewBox="0 0 16 30">
        <line x1="8" y1="0" x2="8" y2="23" stroke={INK.arrow} strokeWidth="1.5" />
        <polygon points="3.5,22 12.5,22 8,30" fill={INK.arrow} />
      </svg>
    </div>
  );
}

function HArr({ row }: { row: number }) {
  return (
    <div style={{ gridColumn: 4, gridRow: row, display: "flex", alignItems: "flex-start", paddingTop: 34 }}>
      <svg width="56" height="14" viewBox="0 0 56 14">
        <line x1="0" y1="7" x2="47" y2="7" stroke={INK.arrow} strokeWidth="1.5" />
        <polygon points="46,2.5 54,7 46,11.5" fill={INK.arrow} />
      </svg>
    </div>
  );
}

function Box({
  row, col, children, emphasis = false,
}: { row: number; col: 3 | 5; children: React.ReactNode; emphasis?: boolean }) {
  return (
    <div style={{
      gridColumn: col, gridRow: row,
      background: "#fff",
      border: `${emphasis ? 2 : 1.5}px solid ${emphasis ? INK.title : INK.border}`,
      borderRadius: 6,
      padding: "12px 16px",
      minHeight: 76,
      display: "flex", flexDirection: "column", justifyContent: "center",
      alignSelf: "start",
      width: "100%", boxSizing: "border-box",
    }}>
      {children}
    </div>
  );
}

function BoxTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ textAlign: "center", fontSize: 12.5, fontWeight: 600, color: INK.title, lineHeight: 1.35 }}>
      {children}
    </div>
  );
}

function BoxSub({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ textAlign: "center", fontSize: 10.5, color: INK.muted, marginTop: 1 }}>{children}</div>
  );
}

function ProgressNote({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ textAlign: "center", fontSize: 10, color: INK.muted, fontStyle: "italic", marginTop: 5 }}>
      {children}
    </div>
  );
}

// Inline-editable text label (session-only, mirrors EN for numbers)
function ET({ value, size = 11, onSave }: { value: string; size?: number; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    const t = draft.trim();
    if (t) onSave(t);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        style={{
          fontSize: size, fontFamily: "inherit", color: INK.body,
          border: "none", borderBottom: `1px solid ${INK.border}`,
          background: "transparent", outline: "none", width: "100%", padding: 0,
        }}
      />
    );
  }
  return (
    <span
      title="Click to edit label"
      onClick={() => { setDraft(value); setEditing(true); }}
      style={{ cursor: "text" }}
    >
      {value}
    </span>
  );
}

// One exclusion-reason line: editable label + count, with fold/restore controls
type DisplayReason = {
  key: string; label: string; count: number;
  isOther?: boolean; reasonCode?: string | null;
};

function ReasonLine({
  row, onSaveLabel, onSaveCount, onFold, onRestore, onViewPapers,
}: {
  row: DisplayReason;
  onSaveLabel: (v: string) => void;
  onSaveCount: (v: number) => void;
  onFold?: () => void;
  onRestore?: () => void;
  onViewPapers?: () => void;
}) {
  const btnStyle: React.CSSProperties = {
    border: "none", background: "none", cursor: "pointer", padding: "0 2px",
    fontSize: 10, color: "#b3a88e", lineHeight: 1, flexShrink: 0,
  };
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "2.5px 0", gap: 8,
    }}>
      {onFold && (
        <button title="Fold this reason into 'Other'" onClick={onFold} style={btnStyle}
          onMouseEnter={e => (e.currentTarget.style.color = INK.title)}
          onMouseLeave={e => (e.currentTarget.style.color = "#b3a88e")}
        >✕</button>
      )}
      {onRestore && (
        <button title="Restore folded reasons" onClick={onRestore} style={btnStyle}
          onMouseEnter={e => (e.currentTarget.style.color = INK.title)}
          onMouseLeave={e => (e.currentTarget.style.color = "#b3a88e")}
        >↺</button>
      )}
      {onViewPapers && (
        <button title="Show the papers behind this reason" onClick={onViewPapers} style={btnStyle}
          onMouseEnter={e => (e.currentTarget.style.color = INK.title)}
          onMouseLeave={e => (e.currentTarget.style.color = "#b3a88e")}
        ><List size={10} style={{ display: "block", transform: "translateY(1px)" }} /></button>
      )}
      <span style={{
        fontSize: 11, color: INK.body, lineHeight: 1.35, flex: 1, minWidth: 0,
        fontStyle: row.isOther ? "italic" : "normal",
      }}>
        <ET value={row.label} onSave={onSaveLabel} />
      </span>
      <span style={{
        fontSize: 11, fontWeight: 700, color: INK.title,
        whiteSpace: "nowrap", flexShrink: 0, fontVariantNumeric: "tabular-nums",
      }}>
        n = <EN value={row.count} size={11} onSave={onSaveCount} />
      </span>
    </div>
  );
}

// Left-label / right-count line, used for source lists and exclusion reasons
function ItemRow({
  label, count, onSaveCount, strong = false,
}: { label: string; count: number; onSaveCount?: (v: number) => void; strong?: boolean }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "2.5px 0", gap: 10,
    }}>
      <span style={{
        fontSize: strong ? 11.5 : 11, color: strong ? INK.title : INK.body,
        fontWeight: strong ? 700 : 400, lineHeight: 1.35,
      }}>
        {label}
      </span>
      <span style={{
        fontSize: strong ? 11.5 : 11, fontWeight: 700, color: INK.title,
        whiteSpace: "nowrap", flexShrink: 0, fontVariantNumeric: "tabular-nums",
      }}>
        {onSaveCount
          ? <>n = <EN value={count} size={strong ? 11.5 : 11} onSave={onSaveCount} /></>
          : <>n = {count.toLocaleString()}</>}
      </span>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function PrismaPage() {
  const { id: projectId } = useParams<{ id: string }>();
  const diagramRef = useRef<HTMLDivElement>(null);

  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [reasonOverrides, setReasonOverrides] = useState<Record<string, number>>({});
  const [reasonLabels, setReasonLabels] = useState<Record<string, string>>({});
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [reasonView, setReasonView] = useState<
    { stage: "TA" | "FT"; reasonCode: string | null; label: string } | null
  >(null);

  const ov = useCallback((key: string, def: number) => overrides[key] ?? def, [overrides]);
  const setOv = useCallback((key: string) => (v: number) => setOverrides(o => ({ ...o, [key]: v })), []);

  const { data: sources = [], isLoading: srcLoading } = useQuery({
    queryKey: ["screening-sources", projectId],
    queryFn: () => screeningApi.getSources(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });
  const { data: prisma, isLoading: prismaLoading } = useQuery({
    queryKey: ["prisma-stats", projectId],
    queryFn: () => projectsApi.getPrismaStats(projectId!).then((r) => r.data),
    enabled: !!projectId,
  });
  const { data: reasonPapers, isLoading: papersLoading } = useQuery({
    queryKey: ["prisma-exclusions", projectId, reasonView?.stage, reasonView?.reasonCode ?? "__none__"],
    queryFn: () => projectsApi
      .getPrismaExclusions(projectId!, reasonView!.stage, reasonView!.reasonCode)
      .then((r) => r.data),
    enabled: !!projectId && reasonView !== null,
  });

  const allSource    = sources.find((s) => s.id === "all");
  const indivSources = sources.filter((s) => s.id !== "all");
  const grouped      = groupSources(
    prisma?.by_source ?? indivSources.map((s) => ({ name: s.name, count: s.record_count })),
  );

  const totalIdentified  = ov("total_identified",  prisma?.total_identified ?? grouped.reduce((a, s) => a + s.count, 0));
  // "After dedup" must count SCREENING UNITS (cross-source overlap clusters +
  // standalone records = allSource.record_count), the same unit ta_screened
  // uses. prisma.total_unique counts individual records, so cluster members
  // beyond the representative would show up as phantom "awaiting screening"
  // even at 100% progress. Cluster grouping is deduplication — count it here.
  const screeningUnits    = allSource?.record_count ?? prisma?.total_unique ?? 0;
  const afterDedup        = ov("after_dedup",        screeningUnits);
  const duplicatesRemoved = ov("duplicates_removed", Math.max(0, totalIdentified - screeningUnits));
  const taScreened        = ov("ta_screened",        allSource?.ta_screened ?? 0);
  const taIncluded        = allSource?.ta_included ?? 0;
  const taExcluded        = ov("ta_excluded",        allSource?.ta_excluded ?? (taScreened - taIncluded));
  const taUncertain       = ov("ta_uncertain",       allSource?.ta_uncertain ?? 0);
  const taNotScreened     = ov("ta_not_screened",    Math.max(0, afterDedup - taScreened));
  const ftScreened        = ov("ft_screened",        allSource?.ft_screened ?? 0);
  const ftIncluded        = ov("ft_included",        allSource?.ft_included ?? 0);
  const ftExcluded        = ov("ft_excluded",        ftScreened - ftIncluded);
  const ftAwaiting        = ov("ft_awaiting",        Math.max(0, taIncluded - ftScreened));
  const extracted         = ov("extracted",          allSource?.extracted_count ?? 0);

  const dupExact   = prisma?.duplicates_removed ?? 0;
  const dupOverlap = Math.max(0, (prisma?.total_unique ?? 0) - screeningUnits);

  // Per-source screening backlog — answers "where are the awaiting papers?"
  // Records can belong to several sources, so these can sum to more than the
  // unique total shown in the diagram.
  const sourceBacklog = indivSources
    .map(s => ({ id: s.id, name: s.name, remaining: Math.max(0, s.record_count - s.ta_screened) }))
    .filter(s => s.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);

  const taReasonsBase = prisma?.ta_exclude_reasons ?? [];
  const ftReasonsBase = prisma?.ft_exclude_reasons ?? [];

  // Apply session edits: count overrides, renamed labels, and reasons folded
  // into a single trailing "Other" row (count = sum of folded, overridable).
  const buildDisplay = (
    base: { reason_code: string | null; count: number }[], prefix: string,
  ): DisplayReason[] => {
    const out: DisplayReason[] = [];
    let otherSum = 0;
    let foldedCount = 0;
    base.forEach((r, i) => {
      const key = `${prefix}_${i}`;
      const count = reasonOverrides[key] ?? r.count;
      if (folded[key]) { otherSum += count; foldedCount++; return; }
      out.push({
        key, label: reasonLabels[key] ?? fmtReason(r.reason_code), count,
        reasonCode: r.reason_code,
      });
    });
    if (foldedCount > 0) {
      const okey = `${prefix}_other`;
      out.push({
        key: okey,
        label: reasonLabels[okey] ?? "Other",
        count: reasonOverrides[okey] ?? otherSum,
        isOther: true,
      });
    }
    return out;
  };

  const taReasons = buildDisplay(taReasonsBase, "ta");
  const ftReasons = buildDisplay(ftReasonsBase, "ft");

  const restoreFolded = (prefix: string) => {
    setFolded(f => Object.fromEntries(
      Object.entries(f).filter(([k]) => !k.startsWith(`${prefix}_`)),
    ));
  };

  const exportSVG = () => buildExportSVG({
    grouped, totalIdentified, duplicatesRemoved, afterDedup,
    dupExact, dupOverlap,
    taScreened, taExcluded, taNotScreened, taUncertain,
    ftScreened, ftIncluded, ftExcluded, ftAwaiting, extracted,
    taReasons: taReasons.map(r => ({ reason_code: null, count: r.count, label: r.label })),
    ftReasons: ftReasons.map(r => ({ reason_code: null, count: r.count, label: r.label })),
  });

  function downloadSVG() {
    const blob = new Blob([exportSVG()], { type: "image/svg+xml;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "prisma-flow-diagram.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadPNG() {
    const svg = exportSVG();
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = 3; // print resolution
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => {
        if (!b) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = "prisma-flow-diagram.png";
        a.click();
        URL.revokeObjectURL(a.href);
      }, "image/png");
    };
    img.src = url;
  }

  if (srcLoading || prismaLoading) {
    return <div style={{ padding: "2rem", color: "#94a3b8" }}>Loading…</div>;
  }

  return (
    <div style={{ padding: "2rem" }}>
      <header className="page-header">
        <div className="page-title">
          <h1>PRISMA Flow Diagram</h1>
          <span className="subtitle">
            Preferred Reporting Items for Systematic Reviews and Meta-Analyses · 2020
            &nbsp;·&nbsp;
            <span style={{ color: "#6366f1", fontWeight: 500 }}>Click any number to edit</span>
          </span>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="btn-primary" onClick={downloadPNG} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <Download size={14} /> PNG
          </button>
          <button className="btn-secondary" onClick={downloadSVG} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
            <Download size={14} /> SVG
          </button>
        </div>
      </header>

      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div
        ref={diagramRef}
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: "0.75rem",
          boxShadow: "0 2px 12px rgba(0,0,0,.07)",
          padding: "28px",
          display: "inline-block",
          fontFamily: FONT,
        }}
      >
        <div style={{
          display: "grid",
          gridTemplateColumns: COLS,
          gridAutoRows: "min-content",
          rowGap: 0,
        }}>
          {/* Phase bars — official PRISMA 2020 phases, spanning their rows */}
          <PhaseBar label="Identification" row="1 / 4" />
          <PhaseBar label="Screening" row="5 / 8" />
          <PhaseBar label="Included" row="9" />

          {/* ── Identification: records identified + removed before screening ── */}
          <Box row={1} col={3}>
            <BoxTitle>Records identified from:</BoxTitle>
            <div style={{ marginTop: 6 }}>
              {grouped.map((s) => (
                <ItemRow key={s.name} label={s.name} count={s.count} />
              ))}
              {grouped.length > 1 && (
                <>
                  <div style={{ borderTop: `1px solid ${INK.faint}`, margin: "5px 0 3px" }} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: INK.title }}>Total</span>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: INK.title, fontVariantNumeric: "tabular-nums" }}>
                      n = <EN value={totalIdentified} size={11.5} onSave={setOv("total_identified")} />
                    </span>
                  </div>
                </>
              )}
            </div>
          </Box>
          <HArr row={1} />
          <Box row={1} col={5}>
            <BoxTitle>Records removed before screening:</BoxTitle>
            <div style={{ marginTop: 6 }}>
              <ItemRow
                label="Duplicate records removed"
                count={duplicatesRemoved}
                onSaveCount={setOv("duplicates_removed")}
              />
              {(dupExact > 0 || dupOverlap > 0) && (
                <ProgressNote>
                  exact: {dupExact.toLocaleString()} · overlap-matched: {dupOverlap.toLocaleString()}
                </ProgressNote>
              )}
            </div>
          </Box>

          <VArr row={2} />

          {/* ── Records after duplicates removed ── */}
          <Box row={3} col={3}>
            <BoxTitle>Records after duplicates removed</BoxTitle>
            <NLine value={afterDedup} size={20} onSave={setOv("after_dedup")} />
          </Box>

          <VArr row={4} />

          {/* ── Screening: title & abstract ── */}
          <Box row={5} col={3}>
            <BoxTitle>Records screened</BoxTitle>
            <BoxSub>(title and abstract)</BoxSub>
            <NLine value={taScreened} size={20} onSave={setOv("ta_screened")} />
            {taNotScreened > 0 && (
              <ProgressNote>
                awaiting screening: n = <EN value={taNotScreened} color={INK.muted} size={10} onSave={setOv("ta_not_screened")} />
              </ProgressNote>
            )}
            {taUncertain > 0 && (
              <ProgressNote>
                uncertain: n = <EN value={taUncertain} color={INK.muted} size={10} onSave={setOv("ta_uncertain")} />
              </ProgressNote>
            )}
          </Box>
          <HArr row={5} />
          <Box row={5} col={5}>
            <BoxTitle>Records excluded</BoxTitle>
            <div style={{ textAlign: "center", marginTop: 4 }}>
              <span style={{ fontSize: 10, color: INK.muted }}>n = </span>
              <EN value={taExcluded} size={14} onSave={setOv("ta_excluded")} />
            </div>
            {taReasons.length > 0 && (
              <>
                <div style={{ borderTop: `1px solid ${INK.faint}`, margin: "8px 0 4px" }} />
                {taReasons.map(r => (
                  <ReasonLine
                    key={r.key} row={r}
                    onSaveLabel={v => setReasonLabels(o => ({ ...o, [r.key]: v }))}
                    onSaveCount={v => setReasonOverrides(o => ({ ...o, [r.key]: v }))}
                    onFold={r.isOther ? undefined : () => setFolded(f => ({ ...f, [r.key]: true }))}
                    onRestore={r.isOther ? () => restoreFolded("ta") : undefined}
                    onViewPapers={r.isOther ? undefined
                      : () => setReasonView({ stage: "TA", reasonCode: r.reasonCode ?? null, label: r.label })}
                  />
                ))}
              </>
            )}
          </Box>

          <VArr row={6} />

          {/* ── Eligibility: full text ── */}
          <Box row={7} col={3}>
            <BoxTitle>Reports assessed for eligibility</BoxTitle>
            <BoxSub>(full text)</BoxSub>
            <NLine value={ftScreened} size={20} onSave={setOv("ft_screened")} />
            {ftAwaiting > 0 && (
              <ProgressNote>
                awaiting review: n = <EN value={ftAwaiting} color={INK.muted} size={10} onSave={setOv("ft_awaiting")} />
              </ProgressNote>
            )}
          </Box>
          <HArr row={7} />
          <Box row={7} col={5}>
            <BoxTitle>Reports excluded, by reason:</BoxTitle>
            <div style={{ textAlign: "center", marginTop: 4 }}>
              <span style={{ fontSize: 10, color: INK.muted }}>n = </span>
              <EN value={ftExcluded} size={14} onSave={setOv("ft_excluded")} />
            </div>
            {ftReasons.length > 0 && (
              <>
                <div style={{ borderTop: `1px solid ${INK.faint}`, margin: "8px 0 4px" }} />
                {ftReasons.map(r => (
                  <ReasonLine
                    key={r.key} row={r}
                    onSaveLabel={v => setReasonLabels(o => ({ ...o, [r.key]: v }))}
                    onSaveCount={v => setReasonOverrides(o => ({ ...o, [r.key]: v }))}
                    onFold={r.isOther ? undefined : () => setFolded(f => ({ ...f, [r.key]: true }))}
                    onRestore={r.isOther ? () => restoreFolded("ft") : undefined}
                    onViewPapers={r.isOther ? undefined
                      : () => setReasonView({ stage: "FT", reasonCode: r.reasonCode ?? null, label: r.label })}
                  />
                ))}
              </>
            )}
          </Box>

          <VArr row={8} />

          {/* ── Included ── */}
          <Box row={9} col={3} emphasis>
            <BoxTitle>Studies included in review</BoxTitle>
            <NLine value={ftIncluded} size={24} onSave={setOv("ft_included")} />
            {extracted > 0 && (
              <ProgressNote>
                data extracted: n = <EN value={extracted} color={INK.muted} size={10} onSave={setOv("extracted")} />
              </ProgressNote>
            )}
          </Box>
        </div>
      </div>

      {/* ── "Where are the remaining papers?" — actionable backlog panel ── */}
      {(taNotScreened > 0 || ftAwaiting > 0) && (
        <aside style={{
          background: "var(--surface)", border: "1px solid var(--border)",
          borderRadius: "0.75rem", boxShadow: "var(--shadow-sm)",
          padding: "1.1rem 1.25rem", width: 300, flexShrink: 0,
          fontSize: "0.85rem",
        }}>
          <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.92rem", display: "flex", alignItems: "center", gap: "0.4rem" }}>
            <CheckSquare size={15} style={{ color: "var(--brand)" }} /> Where are the remaining papers?
          </h3>

          {taNotScreened > 0 && (
            <div style={{ marginBottom: ftAwaiting > 0 ? "1rem" : 0 }}>
              <p style={{ margin: "0 0 0.5rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text)", fontSize: "1.05rem" }}>{taNotScreened.toLocaleString()}</strong>{" "}
                records are waiting in the <strong>Screening queue</strong> (title &amp; abstract stage).
              </p>
              <Link
                to={`/projects/${projectId}/screen?bucket=ta_unscreened&source=all&strategy=sequential`}
                className="btn-primary btn-sm"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              >
                Screen them now <ArrowRight size={13} />
              </Link>

              {sourceBacklog.length > 0 && (
                <div style={{ marginTop: "0.85rem" }}>
                  <div style={{ fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)", marginBottom: "0.35rem" }}>
                    By source
                  </div>
                  {sourceBacklog.map(s => (
                    <Link
                      key={s.id}
                      to={`/projects/${projectId}/screen?bucket=ta_unscreened&source=${s.id}&strategy=sequential`}
                      style={{
                        display: "flex", justifyContent: "space-between", alignItems: "center",
                        padding: "0.3rem 0.45rem", borderRadius: "0.375rem",
                        color: "var(--text-secondary)", textDecoration: "none", fontSize: "0.82rem",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                      <span style={{ fontWeight: 700, color: "var(--warning)", flexShrink: 0, marginLeft: "0.5rem" }}>
                        {s.remaining.toLocaleString()}
                      </span>
                    </Link>
                  ))}
                  {sourceBacklog.length > 1 && (
                    <p style={{ margin: "0.4rem 0 0", fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.45 }}>
                      Records can appear in several sources, so these may sum to more than the unique total.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {ftAwaiting > 0 && (
            <div style={{ borderTop: taNotScreened > 0 ? "1px solid var(--border)" : "none", paddingTop: taNotScreened > 0 ? "0.85rem" : 0 }}>
              <p style={{ margin: "0 0 0.5rem", color: "var(--text-secondary)", lineHeight: 1.5 }}>
                <strong style={{ color: "var(--text)", fontSize: "1.05rem" }}>{ftAwaiting.toLocaleString()}</strong>{" "}
                TA-included records await <strong>full-text review</strong>.
              </p>
              <Link
                to={`/projects/${projectId}/screen?bucket=ft_pending&source=all&strategy=sequential`}
                className="btn-secondary btn-sm"
                style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
              >
                Review full texts <ArrowRight size={13} />
              </Link>
            </div>
          )}
        </aside>
      )}
      </div>

      <p style={{ fontSize: "0.78rem", color: "#94a3b8", marginTop: "1rem", maxWidth: 680 }}>
        Counts reflect current screening progress. Click any <strong style={{ color: "#6366f1" }}>n = </strong>
        value or exclusion-reason label to edit it for export; click <strong>✕</strong> on a reason to fold it
        into a single <em>Other</em> row (↺ restores); the list icon shows the papers behind a reason.
        Edits are session-only and reset on refresh.
        Italic notes show in-progress status and appear in exports only while counts are outstanding.
      </p>

      {/* ── Paper list for one exclusion reason ── */}
      {reasonView && (
        <div
          onClick={() => setReasonView(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(15,23,42,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "2rem",
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: "#fff", borderRadius: 10, maxWidth: 660, width: "100%",
              maxHeight: "75vh", display: "flex", flexDirection: "column",
              boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
            }}
          >
            <div style={{
              padding: "1rem 1.25rem", borderBottom: "1px solid #e5e7eb",
              display: "flex", alignItems: "baseline", gap: 10,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                  {reasonView.label}
                </div>
                <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
                  Excluded at {reasonView.stage === "TA" ? "title & abstract" : "full-text"} stage
                  {reasonPapers ? ` · ${reasonPapers.papers.length} paper${reasonPapers.papers.length === 1 ? "" : "s"}` : ""}
                </div>
              </div>
              <button
                onClick={() => setReasonView(null)}
                title="Close"
                style={{ border: "none", background: "none", cursor: "pointer", color: "#94a3b8", padding: 4 }}
              >
                <X size={16} />
              </button>
            </div>
            <div style={{ overflowY: "auto", padding: "0.5rem 1.25rem 1rem" }}>
              {papersLoading && (
                <div style={{ padding: "1.5rem 0", color: "#94a3b8", fontSize: 13 }}>Loading…</div>
              )}
              {reasonPapers?.papers.map((p, i) => (
                <div key={p.record_id ?? p.cluster_id ?? i} style={{
                  padding: "0.65rem 0",
                  borderTop: i > 0 ? "1px solid #f1f5f9" : "none",
                }}>
                  <div style={{ fontSize: 13, color: "#0f172a", lineHeight: 1.45 }}>{p.title}</div>
                  <div style={{ fontSize: 11.5, color: "#94a3b8", marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>{new Date(p.decided_at).toLocaleDateString()}</span>
                    {p.origin === "ai" && <span style={{ color: "#7c3aed", fontWeight: 600 }}>AI decision</span>}
                    {p.notes && <span style={{ fontStyle: "italic" }}>note: {p.notes}</span>}
                  </div>
                </div>
              ))}
              {reasonPapers && reasonPapers.papers.length === 0 && (
                <div style={{ padding: "1.5rem 0", color: "#94a3b8", fontSize: 13 }}>
                  No papers found for this reason.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
