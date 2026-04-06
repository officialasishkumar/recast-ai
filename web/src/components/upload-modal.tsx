"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, Upload, FileVideo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { createJob, getVoices, type Voice } from "@/lib/api";

interface UploadModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function UploadModal({ open, onClose, onCreated }: UploadModalProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [style, setStyle] = useState<"formal" | "casual">("formal");
  const [language, setLanguage] = useState("en");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      getVoices()
        .then((v) => {
          setVoices(v);
          if (v.length > 0) setVoiceId(v[0].id);
        })
        .catch(() => setVoices([]));
    }
  }, [open]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped && dropped.type.startsWith("video/")) {
      setFile(dropped);
      setError("");
    } else {
      setError("Please drop a video file.");
    }
  }, []);

  async function handleSubmit() {
    if (!file) {
      setError("Please select a video file.");
      return;
    }
    setUploading(true);
    setProgress(0);
    setError("");

    const interval = setInterval(() => {
      setProgress((p) => Math.min(p + 8, 90));
    }, 300);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("voice_id", voiceId);
      formData.append("style", style);
      formData.append("language", language);
      await createJob(formData);
      setProgress(100);
      setTimeout(() => {
        onCreated();
        resetForm();
      }, 400);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      clearInterval(interval);
      setUploading(false);
    }
  }

  function resetForm() {
    setFile(null);
    setProgress(0);
    setError("");
    setUploading(false);
  }

  if (!open) return null;

  const LANGUAGES = [
    { value: "en", label: "English" },
    { value: "es", label: "Spanish" },
    { value: "fr", label: "French" },
    { value: "de", label: "German" },
    { value: "ja", label: "Japanese" },
    { value: "ko", label: "Korean" },
    { value: "zh", label: "Chinese" },
    { value: "pt", label: "Portuguese" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
        {/* Close */}
        <button
          onClick={() => {
            onClose();
            resetForm();
          }}
          className="absolute right-4 top-4 rounded-lg p-1 text-slate-500 hover:bg-slate-800 hover:text-slate-300"
        >
          <X className="h-5 w-5" />
        </button>

        <h2 className="text-lg font-semibold text-slate-100">New Project</h2>
        <p className="mt-1 text-sm text-slate-400">
          Upload a video to get started.
        </p>

        {/* Drop zone */}
        <div
          className={`mt-5 flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 transition-colors ${
            dragOver
              ? "border-indigo-500 bg-indigo-500/10"
              : file
                ? "border-emerald-600 bg-emerald-500/5"
                : "border-slate-700 bg-slate-800/40"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setFile(f);
                setError("");
              }
            }}
          />
          {file ? (
            <>
              <FileVideo className="h-8 w-8 text-emerald-400" />
              <p className="mt-2 text-sm font-medium text-slate-200">
                {file.name}
              </p>
              <p className="text-xs text-slate-500">
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </>
          ) : (
            <>
              <Upload className="h-8 w-8 text-slate-500" />
              <p className="mt-2 text-sm text-slate-400">
                Drag & drop a video or click to browse
              </p>
            </>
          )}
        </div>

        {/* Options */}
        <div className="mt-5 grid grid-cols-2 gap-4">
          {/* Voice */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Voice
            </label>
            <select
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value)}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {voices.length === 0 && (
                <option value="">Loading voices...</option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} ({v.language})
                </option>
              ))}
            </select>
          </div>

          {/* Language */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-400">
              Language
            </label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="h-10 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Style */}
        <div className="mt-4">
          <label className="mb-1.5 block text-xs font-medium text-slate-400">
            Style
          </label>
          <div className="flex gap-4">
            {(["formal", "casual"] as const).map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-center gap-2 text-sm text-slate-300"
              >
                <input
                  type="radio"
                  name="style"
                  value={s}
                  checked={style === s}
                  onChange={() => setStyle(s)}
                  className="accent-indigo-500"
                />
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </label>
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <p className="mt-4 text-sm text-red-400">{error}</p>
        )}

        {/* Progress */}
        {uploading && (
          <div className="mt-4">
            <Progress value={progress} />
            <p className="mt-1 text-xs text-slate-500">{progress}% uploaded</p>
          </div>
        )}

        {/* Submit */}
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            onClick={() => {
              onClose();
              resetForm();
            }}
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={uploading || !file}>
            {uploading ? "Uploading..." : "Create Project"}
          </Button>
        </div>
      </div>
    </div>
  );
}
