import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fulltextApi } from "../api/client";
import type { FulltextPdfMeta, ScreeningNextItem } from "../api/client";

export function PDFUploadPanel({
  projectId,
  item,
}: {
  projectId: string;
  item: ScreeningNextItem;
}) {
  const qc = useQueryClient();
  const itemKey = item.record_id ?? item.cluster_id;
  const [uploading, setUploading] = useState(false);

  const { data: meta, isLoading } = useQuery<FulltextPdfMeta | null>({
    queryKey: ["fulltext-pdf", projectId, itemKey],
    queryFn: () =>
      fulltextApi
        .getMeta(projectId, { record_id: item.record_id, cluster_id: item.cluster_id })
        .then((r) => r.data),
    enabled: !!itemKey,
    staleTime: 60_000,
  });

  const deleteMut = useMutation({
    mutationFn: (pdfId: string) => fulltextApi.delete(projectId, pdfId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fulltext-pdf", projectId, itemKey] }),
  });

  async function handleOpen() {
    if (!meta) return;
    const res = await fulltextApi.download(projectId, meta.id);
    const url = URL.createObjectURL(res.data);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await fulltextApi.upload(projectId, file, {
        record_id: item.record_id,
        cluster_id: item.cluster_id,
      });
      qc.invalidateQueries({ queryKey: ["fulltext-pdf", projectId, itemKey] });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  if (isLoading || !itemKey) return null;

  const pillStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.2rem",
    padding: "0.22rem 0.65rem",
    borderRadius: "1rem",
    border: "1px solid #bbf7d0",
    background: "#fff",
    color: "#166534",
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
  };

  return (
    <div
      style={{
        background: meta ? "#f0fdf4" : "#f8fafc",
        border: `1px solid ${meta ? "#bbf7d0" : "#e2e8f0"}`,
        borderRadius: "0.375rem",
        padding: "0.55rem 1rem",
        display: "flex",
        gap: "0.4rem",
        alignItems: "center",
        flexWrap: "wrap",
        marginTop: "0.4rem",
      }}
    >
      <span
        style={{
          color: meta ? "#166534" : "#64748b",
          fontWeight: 600,
          fontSize: "0.73rem",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          marginRight: "0.25rem",
          flexShrink: 0,
        }}
      >
        PDF:
      </span>

      {meta ? (
        <>
          <button
            onClick={handleOpen}
            style={{ ...pillStyle, maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }}
            title={meta.original_filename}
          >
            {String.fromCodePoint(0x1f4c4)} {meta.original_filename}
          </button>
          <span style={{ fontSize: "0.72rem", color: "#64748b" }}>
            ({(meta.file_size / 1024).toFixed(0)} KB)
          </span>
          <label style={{ ...pillStyle, border: "1px solid #e2e8f0", color: "#64748b" }}>
            {uploading ? "Uploading…" : "Replace"}
            <input type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={handleUpload} disabled={uploading} />
          </label>
          <button
            onClick={() => { if (window.confirm("Remove uploaded PDF?")) deleteMut.mutate(meta.id); }}
            disabled={deleteMut.isPending}
            style={{ ...pillStyle, border: "1px solid #fecaca", color: "#dc2626" }}
          >
            Remove
          </button>
        </>
      ) : (
        <label style={{ ...pillStyle, border: "1px solid #c7d7fd", color: "#1558d6" }}>
          {uploading ? "Uploading…" : "↑ Upload PDF"}
          <input type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={handleUpload} disabled={uploading} />
        </label>
      )}
    </div>
  );
}
